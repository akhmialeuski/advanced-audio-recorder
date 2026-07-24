/**
 * Unit tests for the transcribe dialog's cost surface: the combined
 * pre-run estimate breakdown, the pricing links, the session-total line,
 * the duration-probe gating (never read the whole file when the estimate
 * cannot use it), and how a finished (or output-failed) run is recorded in
 * the session tracker.
 */

import { App, Notice, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import type { TranscriptionModalOptions } from 'src/ui/TranscriptionModal';
import { SessionCostTracker } from 'src/transcription/SessionCostTracker';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

jest.mock('src/utils/AudioFileAnalyzer', () => ({
	probeAudioMetadata: jest.fn(),
}));

// Mock only transcribeFile so a run can be driven without a real provider;
// every other export (buildCostEstimate, formatUsd, ...) stays real.
jest.mock('src/transcription/api', () => {
	const actual = jest.requireActual('src/transcription/api');
	return { __esModule: true, ...actual, transcribeFile: jest.fn() };
});

import { probeAudioMetadata } from 'src/utils/AudioFileAnalyzer';
import { transcribeFile } from 'src/transcription/api';

type ModalInternals = {
	updateCostEstimate: () => void;
	accountRunCost: (
		settings: AudioRecorderSettings,
		cost: TranscribeRunCost,
	) => number | null;
	startRun: () => Promise<void>;
	costEstimateEl: HTMLElement | null;
	durationSeconds: number | null;
	probeFinished: boolean;
};

const probeMock = probeAudioMetadata as jest.Mock;
const transcribeMock = transcribeFile as jest.Mock;

/** Lets a fire-and-forget probe (readBinary + probe) settle before asserting. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAudioFile(): TFile {
	const file = new TFile('Audio/meeting.webm');
	Object.defineProperty(file, 'name', { value: 'meeting.webm' });
	return file;
}

function createModal(
	overrides: Partial<AudioRecorderSettings>,
	tracker?: SessionCostTracker,
	modalOptions: Partial<TranscriptionModalOptions> = {},
): {
	modal: TranscriptionModal;
	internals: ModalInternals;
	readBinary: jest.Mock;
} {
	const settings = { ...DEFAULT_SETTINGS, ...overrides };
	const readBinary = jest.fn(async () => new ArrayBuffer(8));
	const app = new App();
	(app as unknown as { vault: Record<string, unknown> }).vault = {
		readBinary,
	};
	const modal = new TranscriptionModal(
		app,
		createAudioFile(),
		() => settings,
		{
			costTracker: tracker,
			...modalOptions,
		},
	);
	return { modal, internals: modal as unknown as ModalInternals, readBinary };
}

beforeEach(() => {
	probeMock.mockResolvedValue({
		durationSeconds: 600,
		sampleRate: 16000,
		channels: 1,
	});
	transcribeMock.mockReset();
	transcribeMock.mockResolvedValue({
		transcript: { segments: [], speakers: [] },
		markdown: '',
		cost: {
			engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			usd: null,
			usage: {},
		},
	});
	(Notice as unknown as jest.Mock).mockClear();
});

describe('TranscriptionModal cost estimate', () => {
	it('renders a combined breakdown with a total once the probe finishes', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await flush();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Estimated cost');
		expect(text).toContain('Transcription - Deepgram (nova-3): ~$0.04');
		expect(text).toContain('Estimated total: ~$0.04');
		expect(text).toContain('Check current pricing');
		expect(readBinary).toHaveBeenCalledTimes(1);
	});

	it('adds a post-processing line to the breakdown when enabled', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
		});
		modal.onOpen();
		await flush();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Post-processing (Clean up) - OpenAI');
		// The LLM steps are billed separately, so the estimate says so to match
		// the smaller "Transcription cost" reported after the run.
		expect(text).toContain(
			'The LLM steps above are billed separately by their provider and are not added to the session total',
		);
		// Both providers are linked for pricing.
		const links = internals.costEstimateEl?.querySelectorAll('a') ?? [];
		expect(links.length).toBe(2);
	});

	it('opens pricing links in the browser, not the Obsidian window', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await flush();

		const links = internals.costEstimateEl?.querySelectorAll('a') ?? [];
		expect(links.length).toBe(1);
		const link = links[0];
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener');
		expect(link?.getAttribute('href')).toBe('https://deepgram.com/pricing');
	});

	it('degrades to an explanation when the duration cannot be read', async () => {
		probeMock.mockResolvedValue(null);
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		});
		modal.onOpen();
		await flush();

		expect(internals.costEstimateEl?.textContent).toContain(
			'estimate unavailable (duration unreadable)',
		);
	});

	it('marks the local engine as free and never reads the file', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await flush();

		expect(internals.costEstimateEl?.textContent).toContain('no API cost');
		expect(readBinary).not.toHaveBeenCalled();
	});

	it('renders nothing and reads nothing when cost estimates are disabled', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionShowCostEstimates: false,
		});
		modal.onOpen();
		await flush();

		expect(internals.costEstimateEl?.textContent).toBe('');
		expect(readBinary).not.toHaveBeenCalled();
	});

	it('does not read the file for the estimate on an auto-run', async () => {
		const { modal, readBinary } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			undefined,
			{ autoStart: true },
		);
		modal.onOpen();
		await flush();

		// The run's own read is the only one; the estimate probe is skipped so
		// a long recording is never held in memory twice.
		expect(readBinary).not.toHaveBeenCalled();
	});

	it('shows the session total when the tracker has entries', async () => {
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 0.12);
		const { modal, internals } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			tracker,
		);
		modal.onOpen();
		await flush();

		expect(internals.costEstimateEl?.textContent).toContain(
			'Spent this session: ~$0.12',
		);
	});
});

describe('TranscriptionModal accountRunCost', () => {
	const settings = (
		overrides: Partial<AudioRecorderSettings>,
	): AudioRecorderSettings => ({ ...DEFAULT_SETTINGS, ...overrides });

	it('records the provider-reported cost and returns it', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		const usd = internals.accountRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.05,
				usage: { audioSeconds: 700 },
			},
		);

		expect(usd).toBeCloseTo(0.05, 10);
		expect(tracker.totalUsd()).toBeCloseTo(0.05, 10);
	});

	it('falls back to the duration estimate when the run was not priced', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.durationSeconds = 600;
		const usd = internals.accountRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: null,
				usage: {},
			},
		);

		expect(usd).toBeCloseTo(0.043, 10);
		expect(tracker.totalUsd()).toBeCloseTo(0.043, 10);
	});

	it('records an unpriced run when neither actuals nor estimate exist', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.durationSeconds = null;
		internals.accountRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: null,
				usage: {},
			},
		);

		expect(tracker.totalUsd()).toBe(0);
		expect(tracker.unpricedRuns()).toBe(1);
	});

	it('never records the free local engine', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.accountRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				usd: 0,
				usage: {},
			},
		);

		expect(tracker.hasEntries()).toBe(false);
	});

	it('records nothing when cost estimates are disabled', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.accountRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				transcriptionShowCostEstimates: false,
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.05,
				usage: {},
			},
		);

		expect(tracker.hasEntries()).toBe(false);
	});
});

describe('TranscriptionModal run accounting', () => {
	it('shows the cost notice after a successful run', async () => {
		const tracker = new SessionCostTracker();
		const { modal, internals } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			tracker,
		);
		transcribeMock.mockResolvedValue({
			transcript: { segments: [], speakers: [] },
			markdown: '',
			cost: {
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.05,
				usage: { audioSeconds: 700 },
			},
		});
		modal.onOpen();
		await internals.startRun();

		expect(tracker.totalUsd()).toBeCloseTo(0.05, 10);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Transcription cost ~$0.05'),
		);
	});

	it('still records the billed cost when the transcript write fails', async () => {
		const tracker = new SessionCostTracker();
		const { modal, internals } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			tracker,
		);
		// The provider call succeeds and bills (onCost), but writing the
		// transcript afterwards throws (read-only or full vault).
		transcribeMock.mockImplementation(
			async (
				_app: unknown,
				_getSettings: unknown,
				_file: unknown,
				opts: { onCost?: (cost: TranscribeRunCost) => void },
			) => {
				opts.onCost?.({
					engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
					usd: 0.07,
					usage: { audioSeconds: 900 },
				});
				throw new Error('Vault is read-only');
			},
		);
		modal.onOpen();
		await internals.startRun();

		// The already-billed run is counted despite the write failure.
		expect(tracker.totalUsd()).toBeCloseTo(0.07, 10);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Transcription failed'),
		);
	});
});
