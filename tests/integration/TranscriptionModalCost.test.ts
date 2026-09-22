/**
 * Unit tests for the transcribe dialog's cost surface: the combined
 * pre-run estimate breakdown, the pricing links, the session-total line,
 * the duration-probe gating (never read the whole file when the estimate
 * cannot use it), the re-pricing a control change has to trigger, and how a
 * finished (or output-failed) run is recorded in the session tracker.
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
	readAudioMetadata: jest.fn(),
}));

// Mock only transcribeFile so a run can be driven without a real provider;
// every other export (buildCostEstimate, formatUsd, ...) stays real.
jest.mock('src/transcription/api', () => {
	const actual = jest.requireActual('src/transcription/api');
	return { __esModule: true, ...actual, transcribeFile: jest.fn() };
});

import { readAudioMetadata } from 'src/utils/AudioFileAnalyzer';
import { transcribeFile } from 'src/transcription/api';
import { createFile } from '../helpers/createApp';
import { tick } from '../helpers/async';
import { internalsOf } from '../helpers/doubles';
import { rowSelect, rowToggle, settingRow } from '../helpers/settingRows';

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

const probeMock = readAudioMetadata as jest.Mock;
const transcribeMock = transcribeFile as jest.Mock;

/** Lets a fire-and-forget probe (readBinary + probe) settle before asserting. */

function createAudioFile(): TFile {
	const file = createFile('Audio/meeting.webm');
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
	return { modal, internals: internalsOf<ModalInternals>(modal), readBinary };
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
	jest.mocked(Notice).mockClear();
});

describe('TranscriptionModal cost estimate', () => {
	it('renders a combined breakdown with a total once the probe finishes', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await tick();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Estimated cost');
		expect(text).toContain('Transcription - Deepgram (nova-3): ~$0.04');
		expect(text).toContain('Estimated total for this run: ~$0.04');
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
		await tick();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Post-processing (Clean up) - OpenAI');
		// The LLM steps do reach the session total now; what the note has to
		// say is that their share of it is an estimate, because their provider
		// reports no usage to price from.
		expect(text).toContain('their share of the session total is estimated');
		// Both providers are linked for pricing.
		const links = internals.costEstimateEl?.querySelectorAll('a') ?? [];
		expect(links).toHaveLength(2);
	});

	it('opens pricing links in the browser, not the Obsidian window', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await tick();

		const links = internals.costEstimateEl?.querySelectorAll('a') ?? [];
		expect(links).toHaveLength(1);
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
		await tick();

		expect(internals.costEstimateEl?.textContent).toContain(
			'estimate unavailable (duration unreadable)',
		);
	});

	it('degrades rather than quoting zero when the read answered with no length', async () => {
		// The metadata came back - a sample rate, a channel count - with no
		// length, which is what this plugin's own recordings look like. Sized
		// by that the whole breakdown prices at ~$0.00, and a confident zero in
		// a money line is worse than no line at all: the user reads it as "this
		// run is free" and starts a job that is not.
		probeMock.mockResolvedValue({
			durationSeconds: null,
			sampleRate: 48000,
			channels: 2,
		});
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		});
		modal.onOpen();
		await tick();

		expect(internals.durationSeconds).toBeNull();
		expect(internals.costEstimateEl?.textContent).toContain(
			'estimate unavailable (duration unreadable)',
		);
		expect(internals.costEstimateEl?.textContent).not.toContain('$0.00');
	});

	it('marks the local engine as free and never reads the file', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			llmPostProcessEnabled: false,
		});
		modal.onOpen();
		await tick();

		expect(internals.costEstimateEl?.textContent).toContain('no API cost');
		expect(readBinary).not.toHaveBeenCalled();
	});

	it('renders nothing and reads nothing when cost estimates are disabled', async () => {
		const { modal, internals, readBinary } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionShowCostEstimates: false,
		});
		modal.onOpen();
		await tick();

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
		await tick();

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
		await tick();

		expect(internals.costEstimateEl?.textContent).toContain(
			'Spent this session: ~$0.12',
		);
	});

	/**
	 * Opens the dialog over a tracker in a given state and reads the session
	 * line it renders.
	 * @param fill - Puts the tracker into the state under test
	 * @returns The session line's text
	 */
	async function sessionLine(
		fill: (tracker: SessionCostTracker) => void,
	): Promise<string> {
		const tracker = new SessionCostTracker();
		fill(tracker);
		const { modal, internals } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			tracker,
		);
		modal.onOpen();
		await tick();
		return internals.costEstimateEl?.textContent ?? '';
	}

	it('says how much of the total is estimated rather than measured', async () => {
		const line = await sessionLine((tracker) => {
			tracker.add('deepgram', 0.12, false);
			tracker.recordLlmCall('gemini', 'autoChapters', 0.01, true);
		});

		expect(line).toContain('Spent this session: ~$0.13 (1 step estimated)');
	});

	it('says nothing extra when every figure came from a vendor', async () => {
		const line = await sessionLine((tracker) => {
			tracker.add('deepgram', 0.12, false);
			tracker.recordLlmCall('gemini', 'autoChapters', 0.01, false);
		});

		expect(line).toContain('Spent this session: ~$0.13');
		expect(line).not.toContain('estimated');
	});

	it('reports the unpriced runs and the estimated steps together', async () => {
		const line = await sessionLine((tracker) => {
			tracker.add('deepgram', null);
			tracker.recordLlmCall('gemini', 'autoChapters', 0.01, true);
			tracker.recordLlmCall('gemini', 'postProcess', 0.02, true);
		});

		expect(line).toContain('(1 run not priced, 2 steps estimated)');
	});

	it('names the scope of each figure it shows', async () => {
		// A forecast for the run about to start sits directly above an
		// accumulated total, and the two are not comparable: reading them as one
		// number makes a correct calculation look like a wrong one. Each figure
		// therefore says what it covers.
		const tracker = new SessionCostTracker();
		tracker.add('deepgram', 2.45);
		const { modal, internals } = createModal(
			{
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			},
			tracker,
		);
		modal.onOpen();
		await tick();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Estimated total for this run: ~$0.04');
		expect(text).toContain('Session spending');
		expect(text).toContain('Spent this session: ~$2.45');
		expect(text).toContain('this run is not counted yet');
	});
});

describe('TranscriptionModal cost reactivity', () => {
	it('re-prices the estimate when the LLM task changes', async () => {
		// The output share the pass is priced from is the task's own: a summary
		// answers with a quarter of the transcript a cleanup rewrites in full.
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4.1',
		});
		modal.onOpen();
		await tick();
		const before = internals.costEstimateEl?.textContent ?? '';
		expect(before).toContain('Post-processing (Clean up)');
		expect(before).toContain('Estimated total for this run: ~$0.09');

		const task = rowSelect(settingRow(modal.contentEl, 'LLM task'));
		task.value = 'summary';
		task.dispatchEvent(new Event('change'));
		await tick();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Post-processing (Summarize)');
		expect(text).not.toContain('Post-processing (Clean up)');
		// A 600-second transcript is 4800 tokens; the cleanup writes all of them
		// up to the model's 4096-token ceiling, the summary a quarter of it. The
		// 2896 output tokens a summary does not write are the whole of the drop,
		// $0.09 to $0.06 at gpt-4.1's $8 per million.
		expect(text).toContain('Estimated total for this run: ~$0.06');
	});

	it('re-prices the estimate when the advanced two-pass mode is switched on', async () => {
		// The mode doubles the engine passes and adds a team of context agents
		// between them, so it changes both the transcription line and the number
		// of priced lines.
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: false,
			llmPostProcessEnabled: false,
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4.1',
		});
		modal.onOpen();
		await tick();
		const before = internals.costEstimateEl?.textContent ?? '';
		expect(before).toContain('Transcription - Deepgram (nova-3)');
		expect(before).toContain('Estimated total for this run: ~$0.04');

		rowToggle(
			settingRow(modal.contentEl, 'Advanced two-pass transcription'),
		).click();
		await tick();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Transcription (2 passes) - Deepgram (nova-3)');
		expect(text).toContain('Advanced context agents');
		// The second pass doubles the engine line, and the context agents the
		// mode runs between the passes are priced on top: four calls reading
		// 3000 tokens of the draft each, answering 200 tokens apiece.
		expect(text).toContain('Estimated total for this run: ~$0.12');
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
