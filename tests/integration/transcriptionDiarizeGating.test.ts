/**
 * Tests that the service asks an engine only for what that engine can deliver.
 *
 * The earlier behavior sent a diarize field to engines that silently ignored
 * it (OpenAI's Whisper), so a user could enable speaker labels and get an
 * unlabeled transcript with no warning. Per-word timing had the same shape:
 * only Whisper API reads the request, and the switch was offered on all four
 * engines. Both options are now the AND of the user's setting and the engine's
 * capability, derived from the configured engine id (effectiveDiarize,
 * effectiveWordTimestamps).
 * @module tests/unit/transcriptionDiarizeGating.test
 */

import type { App, TFile } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type { TranscribeOptions } from 'src/transcription/providers/TranscriptionProvider';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type {
	Transcript,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider } from '../helpers/providerFixtures';
import type { FakeProvider } from '../helpers/providerFixtures';

const audioFile = partial<TFile>({
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
});

/**
 * A whole-file provider. Its capabilities only steer audio preparation;
 * whether diarization is requested is decided from the configured engine id,
 * not this stub.
 * @param segments - What one request resolves with
 * @returns The provider double
 */
function makeProvider(
	segments: TranscriptSegment[] = [{ start: 0, end: 1, text: 'hi' }],
): FakeProvider {
	return fakeProvider({
		id: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		transcribe: { segments },
	});
}

/**
 * The options the service last transcribed with.
 *
 * Read off the mock's own call log rather than a field the double maintains:
 * `transcribe` is already a `jest.Mock`, and asking it what it was called with
 * is what a mock is for.
 * @param provider - The double the service ran through
 * @returns The options of the last call, or null when it was never called
 */
function lastOptions(provider: FakeProvider): TranscribeOptions | null {
	return provider.transcribe.mock.lastCall?.[1] ?? null;
}

/** Minimal App surface the service touches on the whole-file path. */
function makeApp(): App {
	return createMockApp({
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
	}).app;
}

/**
 * Runs one transcription over the given settings and hands back the provider
 * double, so a test can read what the service asked it for.
 * @param overrides - The settings this test cares about
 * @returns The double the service ran through
 */
async function runWith(
	overrides: Partial<AudioRecorderSettings>,
): Promise<FakeProvider> {
	const provider = makeProvider();
	const service = new TranscriptionService(
		makeApp(),
		() => mergeSettings(overrides),
		{ createProvider: () => provider },
	);
	await service.run(audioFile, { notePathForLinks: 'note.md' });
	return provider;
}

describe('TranscriptionService diarization gating', () => {
	it('does not request diarization for a non-diarizing engine, even if enabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			transcriptionDiarize: true,
		});
		expect(lastOptions(provider)?.diarize).toBe(false);
	});

	it('does not request diarization for local whisper, even if enabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			transcriptionDiarize: true,
		});
		expect(lastOptions(provider)?.diarize).toBe(false);
	});

	it('requests diarization for a diarizing engine when enabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionDiarize: true,
		});
		expect(lastOptions(provider)?.diarize).toBe(true);
	});

	it('does not request diarization when a capable engine has it disabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionDiarize: false,
		});
		expect(lastOptions(provider)?.diarize).toBe(false);
	});
});

/**
 * Runs a transcription with a provider that returns a segment already
 * carrying a speaker label, to prove speakers are dropped from every output
 * when diarization is not in effect even if the provider supplied one.
 */
async function runWithSpeaker(
	engineId: TranscriptionProviderId,
	diarizeSetting: boolean,
): Promise<{ markdown: string; transcript: Transcript }> {
	const segments: TranscriptSegment[] = [
		{ start: 0, end: 1, text: 'hi', speaker: 'Speaker 1' },
	];
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: engineId,
				transcriptionDiarize: diarizeSetting,
			}),
		{ createProvider: () => makeProvider(segments) },
	);
	return service.run(audioFile, { notePathForLinks: 'note.md' });
}

async function runWithDictionary(
	engineId: TranscriptionProviderId,
	dictionary: string,
	deepgramModel?: string,
): Promise<FakeProvider> {
	const provider = makeProvider();
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: engineId,
				// The dictionary lives under the advanced settings master switch.
				transcriptionAdvancedSettingsEnabled: true,
				// The dictionary now travels through the selected profile.
				transcriptionDictionaryProfiles: [
					{ id: 'p1', name: 'Test', terms: dictionary },
				],
				transcriptionDictionaryProfileId: 'p1',
				...(deepgramModel ? { deepgramModel } : {}),
			}),
		{ createProvider: () => provider },
	);
	await service.run(audioFile, { notePathForLinks: 'note.md' });
	return provider;
}

/** Runs a transcription with an explicit selected profile id. */
async function runWithProfileId(
	engineId: TranscriptionProviderId,
	profileId: string,
): Promise<FakeProvider> {
	const provider = makeProvider();
	const service = new TranscriptionService(
		makeApp(),
		() =>
			mergeSettings({
				transcriptionProvider: engineId,
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionDictionaryProfiles: [
					{ id: 'p1', name: 'Test', terms: 'Kubernetes' },
				],
				transcriptionDictionaryProfileId: profileId,
			}),
		{ createProvider: () => provider },
	);
	await service.run(audioFile, { notePathForLinks: 'note.md' });
	return provider;
}

describe('TranscriptionService word-timestamp gating', () => {
	it('requests per-word timing for the engine that reads the request', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			transcriptionWordTimestamps: true,
		});

		expect(lastOptions(provider)?.wordTimestamps).toBe(true);
	});

	it('does not request per-word timing for Gemini, even if enabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			transcriptionWordTimestamps: true,
		});

		expect(lastOptions(provider)?.wordTimestamps).toBe(false);
	});

	it('does not request per-word timing for local whisper, even if enabled', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			transcriptionWordTimestamps: true,
		});

		expect(lastOptions(provider)?.wordTimestamps).toBe(false);
	});

	it('does not request per-word timing when the capable engine has it off', async () => {
		const provider = await runWith({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			transcriptionWordTimestamps: false,
		});

		expect(lastOptions(provider)?.wordTimestamps).toBe(false);
	});
});

describe('TranscriptionService dictionary passthrough', () => {
	it('forwards the parsed, de-duplicated dictionary to the provider', async () => {
		const provider = await runWithDictionary(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'Kubernetes\ngRPC\nkubernetes\n',
		);
		expect(lastOptions(provider)?.dictionary).toEqual([
			'Kubernetes',
			'gRPC',
		]);
	});

	it('leaves the dictionary undefined when the setting is empty', async () => {
		const provider = await runWithDictionary(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			'   \n\t\n',
		);
		expect(lastOptions(provider)?.dictionary).toBeUndefined();
	});

	it('drops the dictionary for a Deepgram model that cannot bias', async () => {
		const provider = await runWithDictionary(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'Kubernetes\ngRPC',
			'whisper-medium',
		);
		expect(lastOptions(provider)?.dictionary).toBeUndefined();
	});

	it('caps the dictionary at the Deepgram keyterm entry limit on nova-3', async () => {
		// Short terms stay under the aggregate token budget, so the 100-entry
		// cap is the bound that bites.
		const many = Array.from(
			{ length: 130 },
			(_v, i) => `t${String(i)}`,
		).join('\n');
		const provider = await runWithDictionary(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			many,
			'nova-3',
		);
		expect(lastOptions(provider)?.dictionary).toHaveLength(100);
	});

	it('caps the dictionary at the Deepgram keyterm token budget on nova-3', async () => {
		// Longer multi-word terms breach the 500-token aggregate well before the
		// 100-entry cap, so fewer than 100 terms reach the provider.
		const many = Array.from(
			{ length: 130 },
			(_v, i) => `distributed consensus protocol term ${String(i)}`,
		).join('\n');
		const provider = await runWithDictionary(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			many,
			'nova-3',
		);
		const applied = lastOptions(provider)?.dictionary ?? [];
		expect(applied.length).toBeGreaterThan(0);
		expect(applied.length).toBeLessThan(100);
	});

	it('sends no dictionary when None is selected', async () => {
		const provider = await runWithProfileId(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'',
		);
		expect(lastOptions(provider)?.dictionary).toBeUndefined();
	});

	it('sends no dictionary when the selected profile no longer exists', async () => {
		const provider = await runWithProfileId(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'missing',
		);
		expect(lastOptions(provider)?.dictionary).toBeUndefined();
	});
});

describe('TranscriptionService speaker output gating', () => {
	it('omits speaker labels for a non-diarizing engine, even if the provider returns one', async () => {
		const { markdown, transcript } = await runWithSpeaker(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			true,
		);
		expect(markdown).not.toContain('Speaker 1');
		// Speakers are stripped from the canonical transcript, so the sidecar
		// file/JSON output stays consistent with the note Markdown.
		expect(transcript.speakers).toEqual([]);
		expect(transcript.segments.every((s) => s.speaker === undefined)).toBe(
			true,
		);
	});

	it('omits speaker labels when a capable engine has diarization disabled', async () => {
		const { markdown, transcript } = await runWithSpeaker(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			false,
		);
		expect(markdown).not.toContain('Speaker 1');
		expect(transcript.speakers).toEqual([]);
	});

	it('keeps speaker labels for a diarizing engine when enabled', async () => {
		const { markdown, transcript } = await runWithSpeaker(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			true,
		);
		expect(markdown).toContain('Speaker 1');
		expect(transcript.speakers).toEqual(['Speaker 1']);
	});
});
