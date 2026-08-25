/**
 * Tests that a transcription run honors a cancel pressed during the final (or
 * only) request. Obsidian's requestUrl cannot abort the in-flight call, but a
 * cancelled run must still throw and write nothing - otherwise a single-request
 * job (whole-file Deepgram, a sub-limit Whisper upload, local whisper.cpp)
 * would ignore Cancel and silently report success, since the per-chunk check
 * only fires before the next chunk.
 * @module tests/unit/transcriptionServiceCancel.test
 */

import type { App, TFile } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	NEVER_CANCELLED,
	TranscriptionCancelledError,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { transcribeFile } from 'src/transcription/runTranscription';
import type { TranscriptionProvider } from 'src/transcription/providers/TranscriptionProvider';
import type { TranscriptionServiceDeps } from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { noticeMessages } from '../mocks/obsidian';
import { CancellationSource } from 'src/utils/cancellation';
import { outcomeOf, waitFor } from '../helpers/async';

const audioFile = partial<TFile>({
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
});

/**
 * A provider that accepts the original container (so the service takes the
 * whole-file path and never needs the Web Audio decode). `onTranscribe` runs
 * inside the single transcribe call, letting a test flip its cancel flag mid
 * request.
 */
/**
 * A provider that accepts the original container (so the service takes the
 * whole-file path and never needs the Web Audio decode). `onTranscribe` runs
 * inside the single transcribe call, letting a test flip its cancel flag mid
 * request.
 * @param onTranscribe - Runs inside the request, before it resolves
 * @returns The provider double
 */
function makeProvider(onTranscribe: () => void): TranscriptionProvider {
	return fakeProvider({
		capabilities: NO_DIARIZATION,
		transcribe: () => {
			onTranscribe();
			return Promise.resolve({
				segments: [{ start: 0, end: 1, text: 'hi' }],
			});
		},
	});
}

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(create?: jest.Mock): App {
	return createMockApp({
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
			create: create ?? jest.fn(),
			adapter: { exists: jest.fn(async () => false) },
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
		workspace: { getLeavesOfType: jest.fn(() => []) },
	}).app;
}

const baseSettings = {
	transcriptionProvider: 'whisper-api' as const,
	whisperApiKey: 'test-key',
};

/**
 * A service over one provider, on the settings every test here shares.
 * @param provider - The provider the run transcribes through
 * @param overrides - Settings this test needs different
 * @returns The service
 */
function serviceOver(
	provider: TranscriptionProvider,
	overrides: Parameters<typeof mergeSettings>[0] = {},
	createLlm?: TranscriptionServiceDeps['createLlm'],
): TranscriptionService {
	return new TranscriptionService(
		makeApp(),
		() => mergeSettings({ ...baseSettings, ...overrides }),
		{
			createProvider: () => provider,
			...(createLlm ? { createLlm } : {}),
		},
	);
}

/** Settings that switch the LLM cleanup pass on. */
const withCleanup = {
	llmPostProcessEnabled: true,
	llmProvider: LLM_PROVIDER_IDS.GEMINI,
	geminiApiKey: 'gm-test',
};

/**
 * A service whose transcription completes and whose cleanup pass fails.
 * @param reason - What the cleanup pass rejects with
 * @returns The service, and the provider its request went through
 */
function serviceWithFailingCleanup(
	reason: () => unknown,
): TranscriptionService {
	return serviceOver(
		makeProvider(() => {
			/* the request itself completes */
		}),
		withCleanup,
		() => ({
			id: LLM_PROVIDER_IDS.GEMINI,
			label: 'Fake LLM',
			complete: () => Promise.reject(reason()),
		}),
	);
}

/**
 * A provider whose single request fails the way this test needs.
 * @param reason - What the request rejects with
 * @returns The provider double
 */
function failingProvider(reason: unknown): TranscriptionProvider {
	return fakeProvider({
		capabilities: NO_DIARIZATION,
		transcribe: () => Promise.reject(reason),
	});
}

/**
 * Runs a transcription that is never cancelled.
 * @param service - The service under test
 */
function runToCompletion(service: TranscriptionService): Promise<unknown> {
	return service.run(audioFile, {
		notePathForLinks: 'note.md',
		token: NEVER_CANCELLED,
	});
}

/**
 * Runs a transcription, watching a cancel flag the test flips.
 * @param service - The service under test
 * @param isCancelled - Reports whether the user has cancelled
 */
function runWatching(
	service: TranscriptionService,
	isCancelled: () => boolean,
): Promise<unknown> {
	return service.run(audioFile, {
		notePathForLinks: 'note.md',
		token: { isCancelled },
	});
}

describe('TranscriptionService cancellation', () => {
	it('completes normally when not cancelled', async () => {
		const provider = makeProvider(() => {
			/* never cancels */
		});
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => provider },
		);

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
			token: NEVER_CANCELLED,
		});

		expect(at(result.transcript.segments, 0).text).toBe('hi');
		expect(result.markdown).toContain('hi');
	});

	it('throws when cancelled during the only request (no per-chunk boundary to catch it)', async () => {
		let cancelled = false;
		const provider = makeProvider(() => {
			cancelled = true;
		});
		await expect(
			runWatching(serviceOver(provider), () => cancelled),
		).rejects.toBeInstanceOf(TranscriptionCancelledError);
		expect(provider.transcribe).toHaveBeenCalledTimes(1);
	});

	it('regression: writes no output when cancelled during the only request', async () => {
		let cancelled = false;
		const provider = makeProvider(() => {
			cancelled = true;
		});
		const create = jest.fn(async () => audioFile);

		await expect(
			transcribeFile(
				makeApp(create),
				() =>
					mergeSettings({
						...baseSettings,
						transcriptDestination: 'file',
					}),
				audioFile,
				{
					notePathForLinks: 'note.md',
					token: { isCancelled: () => cancelled },
				},
				{ createProvider: () => provider },
			),
		).rejects.toBeInstanceOf(TranscriptionCancelledError);
		expect(create).not.toHaveBeenCalled();
	});

	it('regression: writes the file when the same run is not cancelled', async () => {
		const provider = makeProvider(() => {
			/* never cancels */
		});
		const create = jest.fn(async () => audioFile);

		await transcribeFile(
			makeApp(create),
			() =>
				mergeSettings({
					...baseSettings,
					transcriptDestination: 'file',
				}),
			audioFile,
			{ notePathForLinks: 'note.md', token: NEVER_CANCELLED },
			{ createProvider: () => provider },
		);

		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe('a cancel that lands while a request is in flight', () => {
	// A cancelled request is aborted at the transport, so what reaches the
	// service is an ordinary network error. Reported as-is it would read as
	// "transcription failed" for something the user asked for on purpose.
	it('reads a transport failure after a cancel as the cancel it was', async () => {
		let cancelled = false;
		const provider = fakeProvider({
			capabilities: NO_DIARIZATION,
			transcribe: () => {
				cancelled = true;
				return Promise.reject(new Error('The user aborted'));
			},
		});
		await expect(
			runWatching(serviceOver(provider), () => cancelled),
		).rejects.toBeInstanceOf(TranscriptionCancelledError);
		expect(provider.transcribe).toHaveBeenCalledTimes(1);
	});

	// The provider itself can raise the cancellation, when it is the one
	// watching the abort signal; it must travel out untouched rather than
	// being re-wrapped as a failed part.
	it('lets a cancellation raised by the provider through as it is', async () => {
		const raised = new TranscriptionCancelledError();

		await expect(
			runToCompletion(serviceOver(failingProvider(raised))),
		).rejects.toBe(raised);
	});

	it('reports a genuine failure as itself when nothing was cancelled', async () => {
		await expect(
			runToCompletion(
				serviceOver(failingProvider(new Error('the key is invalid'))),
			),
		).rejects.toThrow('the key is invalid');
	});

	// Post-processing runs after the transcript exists. A cancel there must
	// still abort rather than fall through to the "cleanup was skipped"
	// fallback, which would save a transcript the user cancelled.
	it('aborts rather than saving when the cleanup pass is cancelled', async () => {
		let cancelled = false;
		const service = serviceWithFailingCleanup(() => {
			cancelled = true;
			return new TranscriptionCancelledError();
		});

		await expect(
			runWatching(service, () => cancelled),
		).rejects.toBeInstanceOf(TranscriptionCancelledError);
	});

	// The cancel used to reach the transcription request and nothing else, so
	// pressing it during post-processing released nothing: the dialog stayed
	// busy for the request's own five-minute timeout, and the provider ran the
	// call and billed for it. What the user pressed the button for was exactly
	// not to pay for it.
	describe('a cancel pressed while the cleanup pass is running', () => {
		/**
		 * Runs to the post-processing stage, cancels there, and reports what
		 * the pass saw.
		 * @param costSink - Where the run reports LLM spending, when a test
		 *   cares whether anything was billed
		 * @returns Whether the pass was aborted, once the run has rejected
		 */
		async function cancelDuringCleanup(
			costSink?: TranscriptionServiceDeps['costSink'],
		): Promise<boolean> {
			const source = new CancellationSource();
			let started = false;
			let aborted = false;
			const service = new TranscriptionService(
				makeApp(),
				() => mergeSettings({ ...baseSettings, ...withCleanup }),
				{
					createProvider: () =>
						makeProvider(() => {
							/* the transcription itself completes */
						}),
					createLlm: () => ({
						id: LLM_PROVIDER_IDS.GEMINI,
						label: 'Fake LLM',
						complete: (_prompt, _maxTokens, options) =>
							new Promise((_resolve, reject) => {
								started = true;
								options?.signal?.addEventListener(
									'abort',
									() => {
										aborted = true;
										reject(
											new TranscriptionCancelledError(),
										);
									},
								);
							}),
					}),
					...(costSink ? { costSink } : {}),
				},
			);

			const settled = outcomeOf(
				service.run(audioFile, {
					notePathForLinks: 'note.md',
					token: source.token,
				}),
			);
			await waitFor(() => started, {
				message: 'the post-processing call to start',
			});
			source.cancel();

			expect(await settled).toEqual({
				error: expect.any(TranscriptionCancelledError),
			});
			return aborted;
		}

		it('aborts the request rather than waiting it out', async () => {
			expect(await cancelDuringCleanup()).toBe(true);
		});

		// A call that was aborted was never answered, so it is not spending
		// the session counter should show.
		it('accounts nothing for the call it cancelled', async () => {
			const records: string[] = [];

			await cancelDuringCleanup({
				recordLlmCall: (providerId) => {
					records.push(providerId);
				},
			});

			expect(records).toEqual([]);
		});
	});

	// The same failure that is not a cancel keeps the transcript: the run is
	// already paid for and the cleanup is a bonus pass on top of it.
	it('keeps the raw transcript when the cleanup pass merely fails', async () => {
		const service = serviceWithFailingCleanup(
			() => new Error('the LLM key is invalid'),
		);

		const result = (await runToCompletion(service)) as { markdown: string };

		expect(result.markdown).toContain('hi');
		expect(noticeMessages()).toContain(
			'LLM post-processing failed; saving the raw transcript.',
		);
	});
});
