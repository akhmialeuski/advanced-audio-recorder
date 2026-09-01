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
	TranscriptionCancelledError,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import { prepareAudio } from 'src/transcription/audioPrep';
import { TranscriptTruncatedError } from 'src/transcription/transcriptionErrors';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	LLM_PROVIDER_IDS,
	TRANSCRIBE_RETRY_MAX_ATTEMPTS,
	TRANSCRIBE_RETRY_MAX_DELAY_MS,
} from 'src/constants';
import { HttpError } from 'src/transcription/httpClient';
import { CancellationSource } from 'src/utils/cancellation';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { outcomeOf } from '../helpers/async';
import { completed } from '../helpers/llmDoubles';

// Replace audio preparation so the test drives the part count directly without
// decoding real audio (the Web Audio path is unavailable under jsdom).
jest.mock('src/transcription/audioPrep', () =>
	require('../mocks/modules/audioPrep'),
);

const mockPrepareAudio = jest.mocked(prepareAudio);
const mockNotice = jest.mocked(Notice);

const audioFile = partial<TFile>({
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
});

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(): App {
	return createMockApp({
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
			create: jest.fn(),
			adapter: { exists: jest.fn(async () => false) },
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
		workspace: { getLeavesOfType: jest.fn(() => []) },
	}).app;
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
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Fake LLM',
		complete: jest.fn(async () => completed(output)),
	};
}

/**
 * A provider whose request behaviour the test scripts directly.
 * @param transcribe - Stands in for the whole request
 * @returns The provider double
 */
function makeProvider(transcribe: jest.Mock): TranscriptionProvider {
	return { ...fakeProvider({ capabilities: NO_DIARIZATION }), transcribe };
}

const baseSettings = {
	transcriptionProvider: 'gemini' as const,
	geminiApiKey: 'gm-test',
};

/** A provider answer carrying one segment of the given text. */
function oneSegment(text: string): { segments: TranscriptSegment[] } {
	return { segments: [{ start: 0, end: 1, text }] };
}

/** One prepared part, with whatever this test needs it to carry. */
function prepareOnePart(overrides: Record<string, unknown> = {}): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio.wav',
				offsetSeconds: 0,
				createData: () => new ArrayBuffer(4),
				...overrides,
			},
		],
		diarizationSplitWarning: false,
	});
}

/**
 * A service over one scripted request, on the settings every test shares.
 * @param transcribe - Stands in for the whole provider request
 * @returns The service
 */
function serviceOver(transcribe: jest.Mock): TranscriptionService {
	return new TranscriptionService(
		makeApp(),
		() => mergeSettings(baseSettings),
		{ createProvider: () => makeProvider(transcribe) },
	);
}

/**
 * Runs a transcription that is never cancelled.
 * @param service - The service under test
 */
function runToCompletion(
	service: TranscriptionService,
): ReturnType<TranscriptionService['run']> {
	return service.run(audioFile, {
		notePathForLinks: 'note.md',
		token: NEVER_CANCELLED,
	});
}

describe('TranscriptionService multi-part salvage', () => {
	beforeEach(() => {
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
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

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
		const service = serviceOver(transcribe);

		await expect(runToCompletion(service)).rejects.toThrow(
			/first failed \(while transcribing part 1 of 2\)/,
		);
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
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

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

	it('counts the billed usage of a truncated part it discards and retries', async () => {
		prepareSubdividingPart();
		const transcribe = jest
			.fn()
			// The whole part is billed for its audio and truncated output, then
			// discarded; its usage must still count toward the run cost.
			.mockRejectedValueOnce(
				new TranscriptTruncatedError(
					'Gemini stopped because it reached its output token limit',
					{
						inputTokens: 60000,
						audioInputTokens: 60000,
						outputTokens: 500,
					},
				),
			)
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'first half' }],
				usage: {
					inputTokens: 30000,
					audioInputTokens: 30000,
					outputTokens: 800,
				},
			})
			.mockResolvedValueOnce({
				segments: [{ start: 0, end: 1, text: 'second half' }],
				usage: {
					inputTokens: 30000,
					audioInputTokens: 30000,
					outputTokens: 800,
				},
			});
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		// Discarded truncated parent (60k/500) plus both halves (2 x 30k/800).
		expect(result.cost.usage).toEqual({
			inputTokens: 120000,
			audioInputTokens: 120000,
			outputTokens: 2100,
		});
		// Priced at the default gemini-3.5-flash: 120k audio input at $1.5/M
		// plus 2.1k output at $9/M.
		expect(result.cost.usd).toBeCloseTo(0.18 + (2100 * 9) / 1_000_000, 10);
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
		const service = serviceOver(transcribe);

		// Every leaf failed: nothing to keep, so the run surfaces the first
		// failure named by the timeline span that could not be salvaged.
		await expect(runToCompletion(service)).rejects.toThrow(
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

		const result = await runToCompletion(service);

		// The cleaned body is used, and the gap warning still survives above it.
		expect(result.markdown).toContain('LLM CLEANED OUTPUT');
		expect(result.markdown).toContain('Transcription incomplete');
		expect(result.markdown).toContain('part 1 of 2');
	});

	it('post-processes on the engine the post-processing row names', async () => {
		// Post-processing keeps its own engine choice, separate from the ones
		// chapters and the two-pass agents make, and the run has to dispatch to
		// the field that belongs to it.
		const transcribe = jest.fn().mockResolvedValue({
			segments: [{ start: 0, end: 1, text: 'good part' }],
		});
		const vendorIds: string[] = [];
		const service = new TranscriptionService(
			makeApp(),
			() =>
				mergeSettings({
					...baseSettings,
					llmPostProcessEnabled: true,
					llmPostProcessTask: 'cleanup',
					llmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
					chaptersLlmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				}),
			{
				createProvider: () => makeProvider(transcribe),
				createLlm: (_settings, vendorId): LlmProvider => {
					vendorIds.push(vendorId);
					return makeLlm('LLM CLEANED OUTPUT');
				},
			},
		);

		await runToCompletion(service);

		expect(vendorIds).toEqual([LLM_PROVIDER_IDS.ANTHROPIC]);
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
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		expect(result.markdown).toContain('the 7:30-15:00 segment');
		expect(result.markdown).not.toContain('part 2 of 2');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('the 7:30-15:00 segment'),
		);
	});
});

describe('what the user is told about the parts that went missing', () => {
	/** Three prepared parts on the timeline, spans unmeasured. */
	function prepareThreeParts(): void {
		mockPrepareAudio.mockResolvedValue({
			payloads: [0, 60, 120].map((offsetSeconds, index) => ({
				contentType: 'audio/wav',
				filename: `audio-${String(index)}.wav`,
				offsetSeconds,
				createData: () => new ArrayBuffer(4),
			})),
			diarizationSplitWarning: false,
		});
	}

	// One missing part reads "is missing", several read "are missing". The
	// sentence is the only place the user learns how much of the recording
	// is not in the note.
	it('counts the missing parts in the warning it writes', async () => {
		prepareThreeParts();
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce(oneSegment('kept'))
			.mockRejectedValueOnce(new Error('second failed'))
			.mockRejectedValueOnce(new Error('third failed'));
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		expect(result.markdown).toContain(
			'part 2 of 3, part 3 of 3 could not be transcribed and are missing',
		);
	});

	it('names a single missing part in the singular', async () => {
		prepareTwoParts();
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce(oneSegment('kept'))
			.mockRejectedValueOnce(new Error('second failed'));
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		expect(result.markdown).toContain(
			'part 2 of 2 could not be transcribed and is missing',
		);
	});
});

describe('a part that cannot be subdivided any further', () => {
	// The decode path stamps a subdivide() on parts it split itself; a part
	// that came straight from the file has none, so the retry has nothing to
	// fall back on and the part is reported rather than retried forever.
	it('reports the part rather than retrying when it cannot split', async () => {
		prepareTwoParts();
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce(oneSegment('kept'))
			.mockRejectedValueOnce(
				new TranscriptTruncatedError('output token limit reached'),
			);
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		expect(transcribe).toHaveBeenCalledTimes(2);
		expect(result.markdown).toContain('Transcription incomplete');
		expect(result.markdown).toContain('kept');
	});

	// The only part of a single-part job has no label, so there is nothing to
	// salvage: the run fails with the provider's own error rather than
	// writing an empty note.
	it('fails the run outright when the only part cannot be salvaged', async () => {
		mockPrepareAudio.mockResolvedValue({
			payloads: [
				{
					contentType: 'audio/wav',
					filename: 'audio.wav',
					offsetSeconds: 0,
					createData: () => new ArrayBuffer(4),
				},
			],
			diarizationSplitWarning: false,
		});
		const transcribe = jest
			.fn()
			.mockRejectedValue(new Error('the key is invalid'));
		const service = serviceOver(transcribe);

		await expect(runToCompletion(service)).rejects.toThrow(
			'the key is invalid',
		);
	});

	it('names a failure that threw something other than an Error', async () => {
		prepareTwoParts();
		const transcribe = jest
			.fn()
			.mockResolvedValueOnce(oneSegment('kept'))
			.mockRejectedValueOnce('the connection dropped');
		const service = serviceOver(transcribe);

		const result = await runToCompletion(service);

		expect(result.markdown).toContain('Transcription incomplete');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('the connection dropped'),
		);
	});
});

describe('the LLM pass that runs after the transcript exists', () => {
	beforeEach(() => {
		prepareTwoParts();
	});

	/** A service whose post-processing runs the given task on a fake LLM. */
	function serviceWithPostProcess(
		task: 'cleanup' | 'summary' | 'custom',
		output: string,
	): TranscriptionService {
		const transcribe = jest.fn().mockResolvedValue({
			segments: [{ start: 0, end: 1, text: 'the raw transcript' }],
		});
		return new TranscriptionService(
			makeApp(),
			() =>
				mergeSettings({
					...baseSettings,
					llmPostProcessEnabled: true,
					llmPostProcessTask: task,
					llmProvider: LLM_PROVIDER_IDS.GEMINI,
					geminiApiKey: 'gm-test',
				}),
			{
				createProvider: () => makeProvider(transcribe),
				createLlm: () => makeLlm(output),
			},
		);
	}

	// A summary is additive: it sits above the transcript rather than
	// replacing it, because losing the transcript to a summary would lose
	// the timecodes the player links to.
	it('puts a summary above the transcript it summarises', async () => {
		const result = await serviceWithPostProcess(
			'summary',
			'the short version',
		).run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(result.markdown).toContain('### Summary');
		expect(result.markdown).toContain('the short version');
		expect(result.markdown).toContain('### Transcript');
		expect(result.markdown).toContain('the raw transcript');
		expect(result.markdown.indexOf('### Summary')).toBeLessThan(
			result.markdown.indexOf('### Transcript'),
		);
	});

	it('replaces the body with what a cleanup pass returned', async () => {
		const result = await serviceWithPostProcess(
			'cleanup',
			'the tidy version',
		).run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(result.markdown).toContain('the tidy version');
		expect(result.markdown).not.toContain('the raw transcript');
	});

	// An LLM that answers with nothing has produced no cleanup, and an empty
	// note is worse than an unclean one.
	it('keeps the raw transcript when the pass came back empty', async () => {
		const result = await serviceWithPostProcess('cleanup', '').run(
			audioFile,
			{ notePathForLinks: 'note.md', token: NEVER_CANCELLED },
		);

		expect(result.markdown).toContain('the raw transcript');
	});
});

describe('what the prepared audio tells the run', () => {
	/** A provider that answers every part with one segment. */
	function alwaysSucceeds(): jest.Mock {
		return jest.fn().mockResolvedValue({
			segments: [{ start: 0, end: 1, text: 'hi' }],
		});
	}

	it('warns that speaker labels may differ once the audio had to be split', async () => {
		mockPrepareAudio.mockResolvedValue({
			payloads: [
				{
					contentType: 'audio/wav',
					filename: 'audio.wav',
					offsetSeconds: 0,
					createData: () => new ArrayBuffer(4),
				},
			],
			diarizationSplitWarning: true,
		});
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(alwaysSucceeds()) },
		);

		await runToCompletion(service);

		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('speaker labels may differ between parts'),
		);
	});

	// Nothing to transcribe and nothing that failed: the run has to say so
	// rather than write an empty note and report success.
	it('fails when the preparation produced nothing to transcribe', async () => {
		mockPrepareAudio.mockResolvedValue({
			payloads: [],
			diarizationSplitWarning: false,
		});
		const transcribe = alwaysSucceeds();
		const service = serviceOver(transcribe);

		await expect(runToCompletion(service)).rejects.toThrow(
			'Transcription produced no output.',
		);
		expect(transcribe).not.toHaveBeenCalled();
	});

	it('sends the configured language, and nothing when it is set to auto', async () => {
		prepareTwoParts();
		const transcribe = alwaysSucceeds();
		const settings = mergeSettings({
			...baseSettings,
			transcriptionLanguage: 'de',
		});
		await new TranscriptionService(makeApp(), () => settings, {
			createProvider: () => makeProvider(transcribe),
		}).run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(transcribe).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: 'de' }),
		);
	});

	it.each([
		{ name: 'auto', transcriptionLanguage: 'auto' },
		{ name: 'blank', transcriptionLanguage: '' },
	])(
		'lets the engine detect the language when it is set to $name',
		async ({ transcriptionLanguage }) => {
			prepareTwoParts();
			const transcribe = alwaysSucceeds();
			const settings = mergeSettings({
				...baseSettings,
				transcriptionLanguage,
			});
			await new TranscriptionService(makeApp(), () => settings, {
				createProvider: () => makeProvider(transcribe),
			}).run(audioFile, {
				notePathForLinks: 'note.md',
				token: NEVER_CANCELLED,
			});

			expect(transcribe).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ language: undefined }),
			);
		},
	);

	// A single-part run has no part to name, so the progress line says what
	// is happening without an ordinal that would read as "part 1 of 1".
	it('reports progress without a part number on a single-part run', async () => {
		mockPrepareAudio.mockResolvedValue({
			payloads: [
				{
					contentType: 'audio/wav',
					filename: 'audio.wav',
					offsetSeconds: 0,
					createData: () => new ArrayBuffer(4),
				},
			],
			diarizationSplitWarning: false,
		});
		const descriptions: string[] = [];
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => makeProvider(alwaysSucceeds()) },
		);

		await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
			onProgress: (_percent, description) => {
				descriptions.push(description);
			},
		});

		expect(descriptions).toContain('Transcribing...');
	});
});

describe('a single indivisible part that overran the output limit', () => {
	it('fails the run, naming the audio rather than a part number', async () => {
		prepareOnePart();
		const debug = jest.spyOn(console, 'debug').mockImplementation();
		const transcribe = jest
			.fn()
			.mockRejectedValue(
				new TranscriptTruncatedError('output token limit reached'),
			);

		await expect(runToCompletion(serviceOver(transcribe))).rejects.toThrow(
			'output token limit reached',
		);
		expect(debug).toHaveBeenCalledWith(
			expect.stringContaining('The audio still overran'),
		);
	});

	// A subdivision whose span was never measured cannot be named by a time
	// range, so it is named by where it starts.
	it('labels a subdivision with no measured span by its start time', async () => {
		prepareOnePart({
			endSeconds: 900,
			subdivide: () => [
				{
					contentType: 'audio/wav',
					filename: 'half-0.wav',
					offsetSeconds: 450,
					createData: () => new ArrayBuffer(4),
					subdivide: () => [],
				},
			],
		});
		jest.spyOn(console, 'debug').mockImplementation();
		const transcribe = jest
			.fn()
			.mockRejectedValue(
				new TranscriptTruncatedError('output token limit reached'),
			);

		await expect(runToCompletion(serviceOver(transcribe))).rejects.toThrow(
			/the segment at 7:30/,
		);
	});
});

describe('a recording that turned out to hold no speech', () => {
	// A silent (or music-only) recording transcribes to nothing. The run is
	// still a success, and every step that prices itself by the transcript's
	// extent has to cope with there being none.
	it('post-processes a transcript with no segments at all', async () => {
		mockPrepareAudio.mockResolvedValue({
			payloads: [
				{
					contentType: 'audio/wav',
					filename: 'audio.wav',
					offsetSeconds: 0,
					createData: () => new ArrayBuffer(4),
				},
			],
			diarizationSplitWarning: false,
		});
		const transcribe = jest.fn().mockResolvedValue({ segments: [] });
		const service = new TranscriptionService(
			makeApp(),
			() =>
				mergeSettings({
					...baseSettings,
					llmPostProcessEnabled: true,
					llmProvider: LLM_PROVIDER_IDS.GEMINI,
					geminiApiKey: 'gm-test',
				}),
			{
				createProvider: () => makeProvider(transcribe),
				createLlm: () => makeLlm('nothing was said'),
			},
		);

		const result = await runToCompletion(service);

		expect(result.transcript.segments).toEqual([]);
		expect(result.markdown).toContain('nothing was said');
	});
});

describe('the collaborators the service builds when it is given none', () => {
	// The dependency object exists for the tests; the shipping plugin
	// constructs the service with nothing and must still reach the real
	// engine registry - which is what refuses a run with no key configured.
	it('builds its provider from the engine registry', async () => {
		prepareTwoParts();
		const service = new TranscriptionService(makeApp(), () =>
			mergeSettings({
				transcriptionProvider: 'gemini',
				geminiApiKey: '',
			}),
		);

		await expect(runToCompletion(service)).rejects.toThrow(/API key/i);
	});
});

// A 429 or a provider fault used to end the part outright: ten minutes of the
// recording vanished from the transcript, and only a full re-run - paid again -
// could get them back. The plugin recognised the status well enough to advise
// waiting and retrying, and then did neither itself.
describe('a part the provider refused for now', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		prepareTwoParts();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** A refusal of the kind that a later attempt could get past. */
	function rateLimited(retryAfterMs?: number): HttpError {
		return new HttpError(
			429,
			'Rate limit reached. Wait a moment and try again.',
			true,
			retryAfterMs,
		);
	}

	/**
	 * Runs a two-part transcription to completion, letting every retry pause
	 * elapse.
	 * @param service - The service under test
	 */
	async function runPastThePauses(
		service: TranscriptionService,
	): ReturnType<TranscriptionService['run']> {
		const settled = outcomeOf(runToCompletion(service));
		await jest.advanceTimersByTimeAsync(TRANSCRIBE_RETRY_MAX_DELAY_MS * 4);
		const outcome = await settled;
		if ('error' in outcome) {
			throw outcome.error;
		}
		return outcome.value;
	}

	it('sends the part again and keeps the whole transcript', async () => {
		const transcribe = jest
			.fn()
			.mockRejectedValueOnce(rateLimited())
			.mockResolvedValue({
				segments: [{ start: 0, end: 5, text: 'recovered' }],
			});

		const result = await runPastThePauses(serviceOver(transcribe));

		expect(transcribe).toHaveBeenCalledTimes(3);
		expect(result.markdown).not.toContain('Transcription incomplete');
		expect(result.transcript.segments).toHaveLength(2);
	});

	it('waits the pause the provider asked for', async () => {
		const transcribe = refusesThenAnswers(rateLimited(9000));
		const service = serviceOver(transcribe);

		const run = runToCompletion(service);
		await jest.advanceTimersByTimeAsync(8999);
		expect(transcribe).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(1);
		await run;
		expect(transcribe).toHaveBeenCalledTimes(3);
	});

	// A pause longer than the run is willing to sit out is the provider saying
	// come back later, which is a different thing from a hiccup to wait out.
	it('gives up rather than freezing on a pause it will not sit out', async () => {
		const transcribe = refusesThenAnswers(
			rateLimited(TRANSCRIBE_RETRY_MAX_DELAY_MS + 1),
		);

		const result = await runPastThePauses(serviceOver(transcribe));

		expect(transcribe).toHaveBeenCalledTimes(2);
		expect(result.markdown).toContain('Transcription incomplete');
	});

	it('stops after the attempts are spent and reports the part missing', async () => {
		const transcribe = jest.fn().mockRejectedValue(rateLimited());

		const service = serviceOver(transcribe);
		await expect(runPastThePauses(service)).rejects.toThrow(/rate limit/i);

		// Both parts are tried their full allowance and no further: a
		// persistent refusal must not turn into an unbounded, billed sequence.
		expect(transcribe).toHaveBeenCalledTimes(
			TRANSCRIBE_RETRY_MAX_ATTEMPTS * 2,
		);
	});

	// A key that is wrong is wrong on every attempt, and each one is a request
	// the user is charged for asking.
	it('does not retry a refusal a retry cannot fix', async () => {
		const transcribe = refusesThenAnswers(
			new HttpError(401, 'Authentication failed.', false),
		);

		await runPastThePauses(serviceOver(transcribe));

		expect(transcribe).toHaveBeenCalledTimes(2);
	});

	/**
	 * A provider that refuses the given attempts in order and answers the one
	 * after them.
	 * @param failures - What each attempt before the answer fails with
	 * @returns The transcribe double
	 */
	function refusesThenAnswers(...failures: unknown[]): jest.Mock {
		const transcribe = jest.fn();
		for (const failure of failures) {
			transcribe.mockRejectedValueOnce(failure);
		}
		return transcribe.mockResolvedValue({
			segments: [{ start: 0, end: 5, text: 'ok' }],
		});
	}

	/**
	 * Runs a job whose attempts are scripted, and reports every progress line
	 * it showed while waiting to try again.
	 * @param transcribe - What the provider answers, attempt by attempt
	 * @returns The labels shown, joined in the order they appeared
	 */
	async function labelsWhileRetrying(
		transcribe: jest.Mock = refusesThenAnswers(rateLimited()),
	): Promise<string> {
		const labels: string[] = [];
		const settled = outcomeOf(
			serviceOver(transcribe).run(audioFile, {
				notePathForLinks: 'note.md',
				token: NEVER_CANCELLED,
				onProgress: (_fraction, label) => labels.push(label),
			}),
		);
		await jest.advanceTimersByTimeAsync(TRANSCRIBE_RETRY_MAX_DELAY_MS * 4);
		await settled;
		return labels.join(' | ');
	}

	// A progress line that stops moving reads as a hang, and the pause before
	// another attempt is the run still working.
	it('says it is waiting rather than looking stuck', async () => {
		expect(await labelsWhileRetrying()).toMatch(/retrying/i);
	});

	// A job small enough to send whole has no part number to name, so the
	// waiting line says what it is waiting on in words instead.
	it('names the audio itself when there is only one request', async () => {
		prepareOnePart();

		expect(await labelsWhileRetrying()).toContain('Retrying the audio in');
	});

	// A provider fault is retried on the same terms as a rate limit, and the
	// line used to name the second whichever one it was: a user waiting out a
	// 502 was told they had been sending too many requests. Which refusal it
	// was reaches them in the error the run reports if the attempts run out.
	it('does not name a cause the waiting line cannot know', async () => {
		const labels = await labelsWhileRetrying(
			refusesThenAnswers(
				new HttpError(
					502,
					'The provider had a server error. Try again shortly.',
					true,
				),
			),
		);

		expect(labels).toMatch(/retrying/i);
		expect(labels).not.toMatch(/rate limit/i);
	});

	// A subdivided piece carries its parent's callback, and the label the
	// callback reported used to be captured in it rather than passed to it:
	// the piece that was waiting was announced under the name of the part it
	// came from, which for an indivisible job is no name at all.
	it('names the piece that is waiting, not the part it came from', async () => {
		prepareSubdividingPart();

		const labels = await labelsWhileRetrying(
			refusesThenAnswers(
				new TranscriptTruncatedError('output token limit'),
				rateLimited(),
			),
		);

		expect(labels).toContain('Retrying the 0:00-7:30 segment in');
	});

	// Waiting out a pause the user has already given up on is the same
	// complaint the retry was added to answer, one level down.
	it('ends the pause at once when the run is cancelled', async () => {
		const transcribe = jest.fn().mockRejectedValue(rateLimited());
		const source = new CancellationSource();
		const settled = outcomeOf(
			serviceOver(transcribe).run(audioFile, {
				notePathForLinks: 'note.md',
				token: source.token,
			}),
		);

		await jest.advanceTimersByTimeAsync(1);
		source.cancel();
		await jest.advanceTimersByTimeAsync(1);

		expect(await settled).toEqual({
			error: expect.any(TranscriptionCancelledError),
		});
		expect(transcribe).toHaveBeenCalledTimes(1);
	});
});
