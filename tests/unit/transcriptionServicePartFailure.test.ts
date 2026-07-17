/**
 */

/**
 * Tests that a multi-part transcription keeps the parts that succeeded when a
 * later part fails (e.g. a Gemini MAX_TOKENS truncation), instead of discarding
 * a completed - and, on a paid API, already-billed - transcript. The note flags
 * the gap, the user is warned, and only when every part fails does the run
 * surface an error.
 * @module tests/unit/transcriptionServicePartFailure.test
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import { prepareAudio } from 'src/transcription/audioPrep';
import { TranscriptTruncatedError } from 'src/transcription/transcriptionErrors';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { mergeSettings } from 'src/settings/settingsSerialization';

jest.mock('obsidian', () => {
	const actual = jest.requireActual('../mocks/obsidian');
	return { ...actual, Notice: jest.fn() };
});

// Replace audio preparation so the test drives the part count directly without
// decoding real audio (the Web Audio path is unavailable under jsdom).
jest.mock('src/transcription/audioPrep', () => ({
	prepareAudio: jest.fn(),
	audioMimeFromExtension: jest.fn(() => 'audio/webm'),
	audioPrepOptions: jest.fn(() => ({})),
}));

const mockPrepareAudio = prepareAudio as jest.Mock;
const mockNotice = Notice as unknown as jest.Mock;

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(): App {
	return {
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
			create: jest.fn(),
			adapter: { exists: jest.fn(async () => false) },
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
		workspace: { getLeavesOfType: jest.fn(() => []) },
	} as unknown as App;
}

/** Two prepared parts on the timeline (0s and 60s), each a tiny WAV payload. */
function prepareTwoParts(): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio-0.wav',
				offsetSeconds: 0,
				createData: () => new ArrayBuffer(4),
			},
			{
				contentType: 'audio/wav',
				filename: 'audio-1.wav',
				offsetSeconds: 60,
				createData: () => new ArrayBuffer(4),
			},
		],
		diarizationSplitWarning: false,
	});
}

/**
 * Two prepared parts that carry their timeline spans (endSeconds), exactly as
 * the decode path stamps them, so a salvage label reads as a time range rather
 * than the "part N of M" fallback the span-less payloads above produce.
 */
function prepareTwoPartsWithSpans(): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio-0.wav',
				offsetSeconds: 0,
				endSeconds: 450,
				createData: () => new ArrayBuffer(4),
			},
			{
				contentType: 'audio/wav',
				filename: 'audio-1.wav',
				offsetSeconds: 450,
				endSeconds: 900,
				createData: () => new ArrayBuffer(4),
			},
		],
		diarizationSplitWarning: false,
	});
}

/**
 * One prepared part spanning 0..900s that, on demand, subdivides into two
 * halves; each half declares it cannot split further (subdivide -> []), so a
 * test can drive both the recovery path and the at-the-floor failure path.
 */
function prepareSubdividingPart(): void {
	const half = (
		offsetSeconds: number,
		endSeconds: number,
		filename: string,
	) => ({
		contentType: 'audio/wav',
		filename,
		offsetSeconds,
		endSeconds,
		createData: () => new ArrayBuffer(4),
		subdivide: () => [],
	});
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio.wav',
				offsetSeconds: 0,
				endSeconds: 900,
				createData: () => new ArrayBuffer(4),
				subdivide: () => [
					half(0, 450, 'audio-0.wav'),
					half(450, 900, 'audio-1.wav'),
				],
			},
		],
		diarizationSplitWarning: false,
	});
}

/** A stub LLM provider whose cleanup output deliberately carries no callout. */
function makeLlm(output: string): LlmProvider {
	return {
		id: 'fake-llm',
		label: 'Fake LLM',
		complete: jest.fn(async () => output),
	};
}

function makeProvider(transcribe: jest.Mock): TranscriptionProvider {
	return {
		id: 'fake',
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: false,
			supportsDictionary: false,
		},
		transcribe,
	};
}

const baseSettings = {
	transcriptionProvider: 'gemini' as const,
	geminiApiKey: 'gm-test',
};

describe('TranscriptionService multi-part salvage', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		prepareTwoParts();
	});

	it('keeps the successful part when a later part hits the token limit', async () => {
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'part one' }],
			})
			.mockRejectedValueOnce(
				new Error(
					'Gemini stopped because it reached its output token limit',
				),
			);
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(transcribe).toHaveBeenCalledTimes(2);
		// The completed part survives rather than being discarded.
		expect(result.transcript.segments.map((s) => s.text)).toEqual([
			'part one',
		]);
		// The note flags the gap so a partial transcript is not read as whole.
		expect(result.markdown).toContain('Transcription incomplete');
		expect(result.markdown).toContain('part 2 of 2');
		expect(result.markdown).toContain('part one');
		// The user is warned, carrying the underlying provider message.
		expect(mockNotice).toHaveBeenCalledTimes(1);
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('output token limit'),
		);
	});

	it('throws only when every part fails, naming the first failure', async () => {
		const transcribe = jest
			.fn()
			.mockRejectedValueOnce(new Error('first failed'))
			.mockRejectedValueOnce(new Error('second failed'));
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		await expect(
			service.run(audioFile, {
				notePathForLinks: 'note.md',
				token: NEVER_CANCELLED,
			}),
		).rejects.toThrow(/first failed \(while transcribing part 1 of 2\)/);
		expect(mockNotice).not.toHaveBeenCalled();
	});

	it('subdivides a truncated part and keeps both halves', async () => {
		prepareSubdividingPart();
		const transcribe = jest
			.fn()
			// The whole part overruns the output token cap...
			.mockRejectedValueOnce(
				new TranscriptTruncatedError(
					'Gemini stopped because it reached its output token limit',
				),
			)
			// ...so it is retried as two halves, both of which now fit.
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'first half' }],
			})
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'second half' }],
			});
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		// One truncated attempt on the whole part plus the two halves.
		expect(transcribe).toHaveBeenCalledTimes(3);
		expect(result.transcript.segments.map((s) => s.text)).toEqual([
			'first half',
			'second half',
		]);
		// Both halves succeeded, so there is no gap to flag and no warning.
		expect(result.markdown).not.toContain('Transcription incomplete');
		expect(mockNotice).not.toHaveBeenCalled();
	});

	it('fails, naming the timeline span, when every subdivision still truncates', async () => {
		prepareSubdividingPart();
		const truncated = (): TranscriptTruncatedError =>
			new TranscriptTruncatedError(
				'Gemini stopped because it reached its output token limit',
			);
		const transcribe = jest
			.fn()
			.mockRejectedValueOnce(truncated()) // whole part
			.mockRejectedValueOnce(truncated()) // first half (at the floor)
			.mockRejectedValueOnce(truncated()); // second half (at the floor)
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		// Every leaf failed: nothing to keep, so the run surfaces the first
		// failure named by the timeline span that could not be salvaged.
		await expect(
			service.run(audioFile, {
				notePathForLinks: 'note.md',
				token: NEVER_CANCELLED,
			}),
		).rejects.toThrow(
			/output token limit \(while transcribing the .* segment\)/,
		);
		expect(transcribe).toHaveBeenCalledTimes(3);
	});

	it('keeps the incompleteness warning after LLM post-processing replaces the body', async () => {
		const transcribe = jest
			.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'good part' }],
			});
		const service = new TranscriptionService(
			makeApp(),
			() =>
				mergeSettings({
					...baseSettings,
					llmPostProcessEnabled: true,
					llmPostProcessTask: 'cleanup',
				}),
			{
				createProvider: () => makeProvider(transcribe),
				// Cleanup replaces the whole body and drops any callout it was
				// handed, so the gap warning must be re-applied after it returns.
				createLlm: () => makeLlm('LLM CLEANED OUTPUT'),
			},
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		// The cleaned body is used, and the gap warning still survives above it.
		expect(result.markdown).toContain('LLM CLEANED OUTPUT');
		expect(result.markdown).toContain('Transcription incomplete');
		expect(result.markdown).toContain('part 1 of 2');
	});

	it('labels a salvaged part by its timeline span when the span is known', async () => {
		// The decode path stamps endSeconds on every part, so in production the
		// salvage label is a time range, never the ordinal fallback. Exercise
		// that path so the wording the user actually sees is covered.
		prepareTwoPartsWithSpans();
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'first part' }],
			})
			.mockRejectedValueOnce(new Error('boom'));
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(transcribe) },
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(result.markdown).toContain('the 7:30-15:00 segment');
		expect(result.markdown).not.toContain('part 2 of 2');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('the 7:30-15:00 segment'),
		);
	});
});
