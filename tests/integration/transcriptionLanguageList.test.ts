/**
 * Tests a recording that switches between languages from the setting to the
 * stored transcript: a Language field naming several codes reaches Gemini as a
 * list, the answer's per-segment languages survive the service, and the JSON
 * output read back still carries them. The response goes through the real
 * Gemini mapper, so the shape the schema asks for is the shape tested.
 * @module tests/integration/transcriptionLanguageList.test
 */

import type { App, TFile } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { mapGeminiResponse } from 'src/transcription/providers/geminiResponse';
import { serializeTranscriptFile } from 'src/transcription/transcriptFormat';
import { readRecordedTranscript } from 'src/transcription/recordedTranscript';
import { TranscriptFileFormat } from 'src/transcription/TranscriptTypes';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, type FakeProvider } from '../helpers/providerFixtures';

const audioFile = partial<TFile>({
	name: 'lesson.m4a',
	extension: 'm4a',
	path: 'lesson.m4a',
});

const JSON_OUTPUT_PATH = 'lesson.json';

/** A lesson that opens in Ukrainian and goes on in Polish, as Gemini answers it. */
const MIXED_ANSWER = {
	candidates: [
		{
			content: {
				parts: [
					{
						text: JSON.stringify({
							language: 'uk',
							segments: [
								{
									start: 24,
									end: 26,
									text: 'Добрий день.',
									language: 'uk',
								},
								{
									start: 33,
									end: 35,
									text: 'Możemy od razu po polsku, czy chciałby pan na początku',
									language: 'pl',
								},
								{
									start: 35,
									end: 37,
									text: 'по-українськи щось мені повідомити?',
									language: 'uk',
								},
								{
									start: 867,
									end: 880,
									text: 'Andrzej to mój przyjaciel. Jest Polakiem i studiuje informatykę w Szczecinie.',
									language: 'pl',
								},
							],
						}),
					},
				],
			},
		},
	],
};

/**
 * Runs one transcription of the lesson through a provider double that answers
 * with the real Gemini mapping of {@link MIXED_ANSWER}.
 * @param language - The Language field as typed
 * @param engine - The engine the settings name
 * @returns The run's transcript and the double, for its call log
 */
async function transcribeLesson(
	language: string,
	engine: TranscriptionProviderId = TRANSCRIPTION_PROVIDER_IDS.GEMINI,
): Promise<{
	provider: FakeProvider;
	result: Awaited<ReturnType<TranscriptionService['run']>>;
}> {
	const provider = fakeProvider({
		id: engine,
		transcribe: async () => mapGeminiResponse(MIXED_ANSWER, false),
	});
	const { app } = createMockApp({
		vault: { readBinary: jest.fn(async () => new ArrayBuffer(4)) },
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[lesson#t=0|0:00]]'),
		},
	});
	const service = new TranscriptionService(
		app,
		() =>
			mergeSettings({
				transcriptionProvider: engine,
				transcriptionLanguage: language,
			}),
		{ createProvider: () => provider },
	);
	const result = await service.run(audioFile, {
		notePathForLinks: 'lesson.md',
	});
	return { provider, result };
}

/**
 * A vault holding one written JSON output, for reading a transcript back.
 * @param content - The file's text
 * @returns The app whose vault serves it
 */
function vaultWith(content: string): App {
	return createMockApp({
		vault: {
			getFileByPath: jest.fn((path: string) =>
				path === JSON_OUTPUT_PATH
					? partial<TFile>({ path: JSON_OUTPUT_PATH })
					: null,
			),
			cachedRead: jest.fn(async () => content),
		},
	}).app;
}

describe('a recording that switches between configured languages', () => {
	it('tells the engine every language and keeps the language of each segment', async () => {
		const { provider, result } = await transcribeLesson('pl, uk');

		const options = provider.transcribe.mock.lastCall?.[1];
		expect(options?.languages).toEqual(['pl', 'uk']);
		expect(options?.language).toBe('pl');
		expect(result.transcript.segments.map((s) => s.language)).toEqual([
			'uk',
			'pl',
			'uk',
			'pl',
		]);
		// Most of the text is Polish, whatever the model named at the top.
		expect(result.transcript.language).toBe('pl');
	});

	it('keeps the segment languages in the JSON output read back', async () => {
		const { result } = await transcribeLesson('pl, uk');
		const written = serializeTranscriptFile(
			result.transcript,
			TranscriptFileFormat.Json,
		);

		const recorded = await readRecordedTranscript(vaultWith(written), [
			{
				path: JSON_OUTPUT_PATH,
				format: TranscriptFileFormat.Json,
				writtenAt: '2026-10-20T00:00:00.000Z',
			},
		]);

		expect(recorded?.transcript.segments.map((s) => s.language)).toEqual([
			'uk',
			'pl',
			'uk',
			'pl',
		]);
	});

	it('sends one code to an engine that takes a single language', async () => {
		const { provider } = await transcribeLesson(
			'pl, uk',
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		);

		const options = provider.transcribe.mock.lastCall?.[1];
		expect(options?.languages).toBeUndefined();
		expect(options?.language).toBe('pl');
	});
});
