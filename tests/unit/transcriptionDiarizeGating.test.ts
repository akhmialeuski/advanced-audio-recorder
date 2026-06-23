/**
 * Tests that the service requests diarization only when the chosen engine can
 * actually diarize. The earlier behavior sent a diarize field to engines that
 * silently ignored it (OpenAI's Whisper), so a user could enable speaker
 * labels and get an unlabeled transcript with no warning. The diarize option
 * must now be the AND of the user's setting and the engine's capability.
 * @module tests/unit/transcriptionDiarizeGating.test
 */

import type { App, TFile } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type {
	TranscribeOptions,
	TranscriptionProvider,
} from 'src/transcription/providers/TranscriptionProvider';
import { mergeSettings } from 'src/settings/Settings';

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/** A whole-file provider that records the options it was transcribed with. */
function makeProvider(
	supportsDiarization: boolean,
): TranscriptionProvider & { lastOptions: TranscribeOptions | null } {
	const provider = {
		id: 'fake',
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			diarizesWholeFile: supportsDiarization,
			supportsDiarization,
		},
		lastOptions: null as TranscribeOptions | null,
		transcribe: jest.fn(async (_payload, options: TranscribeOptions) => {
			provider.lastOptions = options;
			return { segments: [{ start: 0, end: 1, text: 'hi' }] };
		}),
	};
	return provider;
}

/** Minimal App surface the service touches on the whole-file path. */
function makeApp(): App {
	return {
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
	} as unknown as App;
}

async function runWith(
	provider: TranscriptionProvider,
	diarizeSetting: boolean,
): Promise<void> {
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: 'whisper-api',
				whisperApiKey: 'test-key',
				transcriptionDiarize: diarizeSetting,
			}),
		{ createProvider: () => provider },
	);
	await service.run(audioFile, { notePathForLinks: 'note.md' });
}

describe('TranscriptionService diarization gating', () => {
	it('does not request diarization when the engine cannot diarize, even if enabled', async () => {
		const provider = makeProvider(false);
		await runWith(provider, true);
		expect(provider.lastOptions?.diarize).toBe(false);
	});

	it('requests diarization when both the engine supports it and it is enabled', async () => {
		const provider = makeProvider(true);
		await runWith(provider, true);
		expect(provider.lastOptions?.diarize).toBe(true);
	});

	it('does not request diarization when a capable engine has it disabled', async () => {
		const provider = makeProvider(true);
		await runWith(provider, false);
		expect(provider.lastOptions?.diarize).toBe(false);
	});
});
