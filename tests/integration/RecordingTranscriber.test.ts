/**
 * Tests for one recording's transcription run as every surface starts it:
 * the engine refused before anything is read, what the engine billed counted
 * into the real session tracker whether the run finished or not, the
 * chapters that follow a run, and the outcome each way a run can end.
 * @module tests/integration/RecordingTranscriber.test
 */

import { App } from 'obsidian';
import {
	RecordingTranscriber,
	runOutcomeNotice,
	type RecordingTranscriptionRequest,
} from 'src/transcription/RecordingTranscriber';
import { SessionCostTracker } from 'src/transcription/SessionCostTracker';
import {
	TranscriptionCancelledError,
	type TranscribeRunCost,
	type TranscribeRunResult,
} from 'src/transcription/TranscriptionService';
import type { TranscriptOutputSidecar } from 'src/transcription/runTranscription';
import { CancellationSource } from 'src/utils/cancellation';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { createFile } from '../helpers/createApp';
import { at } from '../helpers/assertions';
import { partial, silenceConsole } from '../helpers/doubles';
import { useDesktopPlatform, useMobilePlatform } from '../helpers/platform';

// The pipeline that reads the audio and writes the transcripts has suites of
// its own; what the run owes is the policy around it.
jest.mock('src/transcription/runTranscription', () => ({
	transcribeFile: jest.fn(),
}));

import { transcribeFile } from 'src/transcription/runTranscription';

const pipeline = jest.mocked(transcribeFile);

const RECORDING = 'Recordings/standup.webm';
const NOTE = 'Meetings/standup.md';

/** What Deepgram reported for a run. */
function deepgram(
	usd: number | null,
	usage: TranscribeRunCost['usage'] = {},
): TranscribeRunCost {
	return { engineId: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, usd, usage };
}

/** A finished pipeline run, with whatever the case needs to differ. */
function finished(
	overrides: Partial<TranscribeRunResult> = {},
): TranscribeRunResult {
	return {
		transcript: { segments: [], speakers: [] },
		markdown: '',
		cost: deepgram(0.05, { audioSeconds: 700 }),
		missingParts: [],
		sentSeconds: 600,
		...overrides,
	};
}

/** A pipeline run that bills the given cost and then fails with `thrown`. */
function billedThenFails(cost: TranscribeRunCost, thrown: unknown): void {
	pipeline.mockImplementation((_app, _getSettings, _file, options) => {
		options.onCost?.(cost);
		return Promise.reject(thrown);
	});
}

interface Sut {
	transcriber: RecordingTranscriber;
	tracker: SessionCostTracker;
	sidecar: TranscriptOutputSidecar;
	generateChapters: jest.Mock;
	app: App;
}

function createSut(): Sut {
	const app = new App();
	const tracker = new SessionCostTracker();
	// The pipeline that writes through it is mocked, so the store is only
	// ever handed on.
	const sidecar = partial<TranscriptOutputSidecar>({});
	const generateChapters = jest.fn().mockResolvedValue(undefined);
	return {
		transcriber: new RecordingTranscriber({
			app,
			sidecar,
			costs: tracker,
			generateChapters,
		}),
		tracker,
		sidecar,
		generateChapters,
		app,
	};
}

/** A run of the standup recording on Deepgram nova-3, into its note. */
function request(
	overrides: Partial<AudioRecorderSettings> = {},
	run: Partial<RecordingTranscriptionRequest> = {},
): RecordingTranscriptionRequest {
	return {
		file: createFile(RECORDING),
		settings: {
			...DEFAULT_SETTINGS,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			...overrides,
		},
		notePath: NOTE,
		durationSeconds: () => 600,
		chapters: false,
		...run,
	};
}

beforeEach(() => {
	pipeline.mockResolvedValue(finished());
});

describe('what a finished run reports', () => {
	it('says where the transcript went and how many parts it left out', async () => {
		pipeline.mockResolvedValue(
			finished({
				missingParts: [
					{
						label: 'Part 2',
						message: 'timed out',
						startSeconds: 300,
					},
				],
			}),
		);
		const { transcriber } = createSut();

		const outcome = await transcriber.transcribe(
			request({ transcriptDestination: 'both' }),
		);

		expect(outcome).toEqual({
			status: 'done',
			destination: 'both',
			notePath: NOTE,
			missingParts: 1,
			usd: 0.05,
			sessionTotalUsd: 0.05,
		});
	});

	it('hands the pipeline the run it was asked for, with the plugin services', async () => {
		const { transcriber, tracker, sidecar, app } = createSut();
		const bytes = new ArrayBuffer(8);
		const { token } = new CancellationSource();
		const run = request({}, { audioBytes: bytes, token });

		await transcriber.transcribe(run);

		const [passedApp, getSettings, file, options, deps] = at(
			pipeline.mock.calls,
			0,
		);
		expect(passedApp).toBe(app);
		expect(getSettings()).toEqual(run.settings);
		expect(file).toBe(run.file);
		expect(options).toMatchObject({
			notePathForLinks: NOTE,
			audioBytes: bytes,
			token,
			sidecar,
		});
		// The run's LLM steps report to the same session total as it goes.
		expect(deps).toEqual({ costSink: tracker });
	});

	// A run with no note to write into, as the command line starts one, can
	// only write a file; asked for the note alone, the pipeline would fall back
	// to a file and tell the user an insert failed that could never work.
	it('writes a run with no note as a file when it was asked for the note', async () => {
		const { transcriber } = createSut();

		const outcome = await transcriber.transcribe(
			request({ transcriptDestination: 'note' }, { notePath: '' }),
		);

		const [, getSettings] = at(pipeline.mock.calls, 0);
		expect(getSettings().transcriptDestination).toBe('file');
		expect(outcome.status === 'done' && outcome.destination).toBe('file');
	});

	it('passes the progress and the cost so far on to the one that started it', async () => {
		pipeline.mockImplementation((_app, _getSettings, _file, options) => {
			options.onProgress?.(0.5, 'Uploading');
			options.onCost?.(deepgram(0.02));
			return Promise.resolve(finished());
		});
		const onProgress = jest.fn();
		const onCost = jest.fn();
		const { transcriber } = createSut();

		await transcriber.transcribe(request({}, { onProgress, onCost }));

		expect(onProgress).toHaveBeenCalledWith(0.5, 'Uploading');
		expect(onCost).toHaveBeenCalledWith(deepgram(0.02));
	});
});

describe('what a run adds to the session total', () => {
	it('records what the engine reported and returns it', async () => {
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(request());

		expect(outcome.status === 'done' && outcome.usd).toBeCloseTo(0.05, 10);
		expect(tracker.totalUsd()).toBeCloseTo(0.05, 10);
	});

	it('falls back to the length estimate when the engine priced nothing', async () => {
		pipeline.mockResolvedValue(finished({ cost: deepgram(null) }));
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(request());

		expect(outcome.status === 'done' && outcome.usd).toBeCloseTo(0.043, 10);
		expect(tracker.totalUsd()).toBeCloseTo(0.043, 10);
	});

	it('records an unpriced run when neither the engine nor a length can price it', async () => {
		pipeline.mockResolvedValue(finished({ cost: deepgram(null) }));
		const { transcriber, tracker } = createSut();

		await transcriber.transcribe(
			request({}, { durationSeconds: () => null }),
		);

		expect(tracker.totalUsd()).toBe(0);
		expect(tracker.unpricedRuns()).toBe(1);
	});

	// The dialog may still be measuring the recording when the run starts, and
	// a length that arrived during the run is the better estimate.
	it('reads the length when the run is recorded rather than when it starts', async () => {
		let seconds: number | null = null;
		pipeline.mockImplementation(() => {
			seconds = 600;
			return Promise.resolve(finished({ cost: deepgram(null) }));
		});
		const { transcriber, tracker } = createSut();

		await transcriber.transcribe(
			request({}, { durationSeconds: () => seconds }),
		);

		expect(tracker.totalUsd()).toBeCloseTo(0.043, 10);
	});

	it('never records the free local engine', async () => {
		useDesktopPlatform();
		pipeline.mockResolvedValue(
			finished({
				cost: {
					engineId: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					usd: 0,
					usage: {},
				},
			}),
		);
		const { transcriber, tracker } = createSut();

		await transcriber.transcribe(
			request({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
		);

		expect(tracker.hasEntries()).toBe(false);
	});

	it('records nothing when cost estimates are switched off', async () => {
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(
			request({ transcriptionShowCostEstimates: false }),
		);

		expect(tracker.hasEntries()).toBe(false);
		expect(outcome.status === 'done' && outcome.usd).toBeNull();
	});

	// The engine charged for the audio; a read-only vault losing the
	// transcript afterwards does not refund it.
	it('counts what the engine billed before the run failed', async () => {
		silenceConsole('warn');
		billedThenFails(deepgram(0.07), new Error('Vault is read-only'));
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(request());

		expect(outcome).toEqual({
			status: 'failed',
			message: 'Vault is read-only',
		});
		expect(tracker.totalUsd()).toBeCloseTo(0.07, 10);
	});

	it('counts what the engine billed before the run was cancelled', async () => {
		billedThenFails(deepgram(0.03), new TranscriptionCancelledError());
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(request());

		expect(outcome).toEqual({ status: 'cancelled' });
		expect(tracker.totalUsd()).toBeCloseTo(0.03, 10);
	});

	it('records nothing for a run that failed before the engine billed', async () => {
		silenceConsole('warn');
		pipeline.mockRejectedValue(new Error('no network'));
		const { transcriber, tracker } = createSut();

		await transcriber.transcribe(request());

		expect(tracker.hasEntries()).toBe(false);
	});
});

describe('how a run that did not finish ends', () => {
	it.each([
		{
			thrown: new Error('the endpoint refused the key'),
			message: 'the endpoint refused the key',
		},
		{ thrown: 'upstream exploded', message: 'upstream exploded' },
	])('says why it failed: $message', async ({ thrown, message }) => {
		const warn = silenceConsole('warn');
		pipeline.mockRejectedValue(thrown);
		const { transcriber } = createSut();

		const outcome = await transcriber.transcribe(request());

		expect(outcome).toEqual({ status: 'failed', message });
		// The console keeps the whole error, for the log a user can send.
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(RECORDING),
			thrown,
		);
	});

	it('refuses an engine this device cannot run before reading anything', async () => {
		useMobilePlatform();
		const { transcriber, tracker } = createSut();

		const outcome = await transcriber.transcribe(
			request({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
		);

		expect(outcome).toEqual({
			status: 'failed',
			message:
				'The selected transcription engine is not available on this device. Pick a cloud engine in settings.',
		});
		expect(pipeline).toHaveBeenCalledTimes(0);
		expect(tracker.hasEntries()).toBe(false);
	});
});

describe('the chapters that follow a run', () => {
	const asksForChapters: Partial<AudioRecorderSettings> = {
		transcriptionAutoChaptersEnabled: true,
		transcriptionAutoChaptersOnTranscribe: true,
	};

	it('generates the chapters the settings ask for from the fresh transcript', async () => {
		const transcript = {
			segments: [{ start: 0, end: 1, text: 'Hello' }],
			speakers: [],
		};
		pipeline.mockResolvedValue(finished({ transcript }));
		const { transcriber, generateChapters } = createSut();
		const run = request(asksForChapters, { chapters: true });

		await transcriber.transcribe(run);

		expect(generateChapters).toHaveBeenCalledWith(run.file, transcript);
	});

	it.each([
		{
			name: 'a run that was not asked for them',
			settings: asksForChapters,
			chapters: false,
		},
		{
			name: 'settings that do not ask for them',
			settings: { transcriptionAutoChaptersOnTranscribe: false },
			chapters: true,
		},
	])('generates none for $name', async ({ settings, chapters }) => {
		const { transcriber, generateChapters } = createSut();

		await transcriber.transcribe(request(settings, { chapters }));

		expect(generateChapters).toHaveBeenCalledTimes(0);
	});

	it('generates none after a run that failed', async () => {
		silenceConsole('warn');
		pipeline.mockRejectedValue(new Error('no network'));
		const { transcriber, generateChapters } = createSut();

		await transcriber.transcribe(
			request(asksForChapters, { chapters: true }),
		);

		expect(generateChapters).toHaveBeenCalledTimes(0);
	});
});

describe('what the user is told about how a run ended', () => {
	it('says what a finished run cost and what the session has spent', async () => {
		const { transcriber, tracker } = createSut();
		tracker.recordRun(deepgram(0.1), request().settings, 600);

		const outcome = await transcriber.transcribe(request());

		expect(runOutcomeNotice(outcome)).toBe(
			'Transcription cost ~$0.05 (session total ~$0.15).',
		);
	});

	it('says nothing of the cost of a run the session total did not count', async () => {
		const { transcriber } = createSut();

		const outcome = await transcriber.transcribe(
			request({ transcriptionShowCostEstimates: false }),
		);

		expect(runOutcomeNotice(outcome)).toBeNull();
	});

	it.each([
		{ outcome: { status: 'cancelled' }, said: 'Transcription cancelled.' },
		{
			outcome: { status: 'failed', message: 'quota exceeded' },
			said: 'Transcription failed: quota exceeded',
		},
	] as const)('says $said', ({ outcome, said }) => {
		expect(runOutcomeNotice(outcome)).toBe(said);
	});
});
