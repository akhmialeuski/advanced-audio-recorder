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
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/**
 * A provider that accepts the original container (so the service takes the
 * whole-file path and never needs the Web Audio decode). `onTranscribe` runs
 * inside the single transcribe call, letting a test flip its cancel flag mid
 * request.
 */
function makeProvider(onTranscribe: () => void): TranscriptionProvider {
	return {
		id: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: false,
			supportsDictionary: false,
			biasChannel: 'prompt',
		},
		transcribe: jest.fn(async () => {
			onTranscribe();
			return { segments: [{ start: 0, end: 1, text: 'hi' }] };
		}),
	};
}

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(create?: jest.Mock): App {
	return {
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
			create: create ?? jest.fn(),
			adapter: { exists: jest.fn(async () => false) },
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
		workspace: { getLeavesOfType: jest.fn(() => []) },
	} as unknown as App;
}

const baseSettings = {
	transcriptionProvider: 'whisper-api' as const,
	whisperApiKey: 'test-key',
};

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
		const service = new TranscriptionService(
			makeApp(),
			() => mergeSettings(baseSettings),
			{ createProvider: () => provider },
		);

		await expect(
			service.run(audioFile, {
				notePathForLinks: 'note.md',
				token: { isCancelled: () => cancelled },
			}),
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
