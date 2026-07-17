/**
 * Unit tests for the transcribe dialog's cost surface: the pre-run
 * estimate line, the session-total line, and how a finished run is
 * recorded in the session tracker.
 */

import { App, Notice, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import { SessionCostTracker } from 'src/transcription/SessionCostTracker';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

jest.mock('src/utils/AudioFileAnalyzer', () => ({
	probeAudioMetadata: jest.fn(),
}));

import { probeAudioMetadata } from 'src/utils/AudioFileAnalyzer';

type ModalInternals = {
	probeDuration: () => Promise<void>;
	updateCostEstimate: () => void;
	recordRunCost: (
		settings: AudioRecorderSettings,
		cost: TranscribeRunCost,
	) => void;
	costEstimateEl: HTMLElement | null;
	durationSeconds: number | null;
	probeFinished: boolean;
};

function createAudioFile(): TFile {
	const file = new TFile('Audio/meeting.webm');
	Object.defineProperty(file, 'name', { value: 'meeting.webm' });
	return file;
}

function makeApp(): App {
	const app = new App();
	(app as unknown as { vault: Record<string, unknown> }).vault = {
		readBinary: jest.fn(async () => new ArrayBuffer(8)),
	};
	return app;
}

function createModal(
	overrides: Partial<AudioRecorderSettings>,
	tracker?: SessionCostTracker,
): { modal: TranscriptionModal; internals: ModalInternals } {
	const settings = { ...DEFAULT_SETTINGS, ...overrides };
	const modal = new TranscriptionModal(
		makeApp(),
		createAudioFile(),
		() => settings,
		{ costTracker: tracker },
	);
	return { modal, internals: modal as unknown as ModalInternals };
}

const probeMock = probeAudioMetadata as jest.Mock;

beforeEach(() => {
	probeMock.mockResolvedValue({
		durationSeconds: 600,
		sampleRate: 16000,
		channels: 1,
	});
});

describe('TranscriptionModal cost estimate', () => {
	it('shows a priced estimate once the duration probe finishes', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		});
		modal.onOpen();
		await internals.probeDuration();

		const text = internals.costEstimateEl?.textContent ?? '';
		expect(text).toContain('Estimated cost: ~$0.04');
		expect(text).toContain('nova-3');
	});

	it('degrades to an explanation when the duration cannot be read', async () => {
		probeMock.mockResolvedValue(null);
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		});
		modal.onOpen();
		await internals.probeDuration();

		expect(internals.costEstimateEl?.textContent).toContain(
			'duration could not be read',
		);
	});

	it('marks the local engine as free without probing anything', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		});
		modal.onOpen();
		await internals.probeDuration();

		expect(internals.costEstimateEl?.textContent).toContain(
			'Local engine - no API cost.',
		);
	});

	it('renders nothing when cost estimates are disabled', async () => {
		const { modal, internals } = createModal({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionShowCostEstimates: false,
		});
		modal.onOpen();
		await internals.probeDuration();

		expect(internals.costEstimateEl?.textContent).toBe('');
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
		await internals.probeDuration();

		expect(internals.costEstimateEl?.textContent).toContain(
			'Spent this session: ~$0.12',
		);
	});
});

describe('TranscriptionModal recordRunCost', () => {
	const settings = (
		overrides: Partial<AudioRecorderSettings>,
	): AudioRecorderSettings => ({ ...DEFAULT_SETTINGS, ...overrides });

	it('records the provider-reported cost and shows a notice', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.recordRunCost(
			settings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			}),
			{
				engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				usd: 0.05,
				usage: { audioSeconds: 700 },
			},
		);

		expect(tracker.totalUsd()).toBeCloseTo(0.05, 10);
		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('Transcription cost ~$0.05'),
		);
	});

	it('falls back to the duration estimate when the run was not priced', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.durationSeconds = 600;
		internals.recordRunCost(
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

		expect(tracker.totalUsd()).toBeCloseTo(0.043, 10);
	});

	it('records an unpriced run when neither actuals nor estimate exist', () => {
		const tracker = new SessionCostTracker();
		const { internals } = createModal({}, tracker);
		internals.durationSeconds = null;
		internals.recordRunCost(
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
		internals.recordRunCost(
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
		internals.recordRunCost(
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
