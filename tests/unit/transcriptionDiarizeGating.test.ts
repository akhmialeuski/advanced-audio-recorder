/**
 * Tests that the service requests diarization only when the chosen engine can
 * actually diarize. The earlier behavior sent a diarize field to engines that
 * silently ignored it (OpenAI's Whisper), so a user could enable speaker
 * labels and get an unlabeled transcript with no warning. The diarize option
 * must now be the AND of the user's setting and the engine's capability,
 * derived from the configured engine id (effectiveDiarize).
 * @module tests/unit/transcriptionDiarizeGating.test
 */

import type { App, TFile } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type {
	TranscribeOptions,
	TranscriptionProvider,
} from 'src/transcription/providers/TranscriptionProvider';
import {
	mergeSettings,
	type TranscriptionProviderId,
} from 'src/settings/Settings';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/**
 * A whole-file provider that records the options it was transcribed with. Its
 * capabilities only steer audio preparation; whether diarization is requested
 * is decided from the configured engine id, not this stub.
 */
function makeProvider(): TranscriptionProvider & {
	lastOptions: TranscribeOptions | null;
} {
	const provider = {
		id: 'fake',
		label: 'Fake',
		requiresNetwork: false,
		capabilities: {
			maxRequestBytes: Number.POSITIVE_INFINITY,
			maxRequestSeconds: Number.POSITIVE_INFINITY,
			acceptsOriginalContainer: true,
			supportsDiarization: true,
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
	engineId: TranscriptionProviderId,
	diarizeSetting: boolean,
): Promise<TranscriptionProvider & { lastOptions: TranscribeOptions | null }> {
	const provider = makeProvider();
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: engineId,
				transcriptionDiarize: diarizeSetting,
			}),
		{ createProvider: () => provider },
	);
	await service.run(audioFile, { notePathForLinks: 'note.md' });
	return provider;
}

describe('TranscriptionService diarization gating', () => {
	it('does not request diarization for a non-diarizing engine, even if enabled', async () => {
		const provider = await runWith(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			true,
		);
		expect(provider.lastOptions?.diarize).toBe(false);
	});

	it('does not request diarization for local whisper, even if enabled', async () => {
		const provider = await runWith(
			TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			true,
		);
		expect(provider.lastOptions?.diarize).toBe(false);
	});

	it('requests diarization for a diarizing engine when enabled', async () => {
		const provider = await runWith(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			true,
		);
		expect(provider.lastOptions?.diarize).toBe(true);
	});

	it('does not request diarization when a capable engine has it disabled', async () => {
		const provider = await runWith(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			false,
		);
		expect(provider.lastOptions?.diarize).toBe(false);
	});
});
