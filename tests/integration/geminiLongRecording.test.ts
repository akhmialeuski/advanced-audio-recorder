/**
 * A long recording transcribed by the real Gemini provider in two parts, with
 * the model's answers scripted on the wire. Gemini estimates its own
 * timecodes, and on the 2026-10-19 lesson it placed lines past the end of the
 * part it was sent and lost a part with nothing but a notice to say why. These
 * cases pin what the run does with such answers before they reach the note.
 * @module tests/integration/geminiLongRecording.test
 */

import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { prepareAudio } from 'src/transcription/audioPrep';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { partial, silenceConsole } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { queueResponses } from '../helpers/network';

jest.mock('src/transcription/audioPrep', () =>
	require('../mocks/modules/audioPrep'),
);

const mockPrepareAudio = jest.mocked(prepareAudio);

/** The lesson's length, 24:13, split the way the plan splits it. */
const RECORDING_SECONDS = 1453;
const PART_SECONDS = RECORDING_SECONDS / 2;

const recording = partial<TFile>({
	name: 'lesson.m4a',
	extension: 'm4a',
	path: 'lesson.m4a',
});

/** Two parts with measured spans, small enough to go inline. */
function prepareTwoParts(): void {
	const part = (offsetSeconds: number, endSeconds: number) => ({
		contentType: 'audio/wav',
		filename: `audio-${String(offsetSeconds)}.wav`,
		offsetSeconds,
		endSeconds,
		createData: () => new ArrayBuffer(4),
	});
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			part(0, PART_SECONDS),
			part(PART_SECONDS, RECORDING_SECONDS),
		],
		diarizationSplitWarning: false,
	});
}

/**
 * A `generateContent` answer carrying the given structured transcript.
 * @param structured - What the model's JSON text holds
 * @returns The response the request resolves with
 */
function answer(structured: unknown): { text: string } {
	return {
		text: JSON.stringify({
			candidates: [
				{
					finishReason: 'STOP',
					content: { parts: [{ text: JSON.stringify(structured) }] },
				},
			],
		}),
	};
}

/** A `generateContent` answer the model refused, with the reason it gave. */
const REFUSED = {
	text: JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }),
};

/**
 * Transcribes the recording through a real Gemini provider.
 * @returns What the run returned
 */
function transcribe(): ReturnType<TranscriptionService['run']> {
	const service = new TranscriptionService(
		createMockApp().app,
		() =>
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				geminiApiKey: 'gm-test',
			}),
		{
			createProvider: () =>
				new GeminiProvider({
					baseUrl: 'https://gemini.example',
					apiKey: 'gm-test',
					model: 'gemini-3.8-flash',
				}),
		},
	);
	return service.run(recording, {
		notePathForLinks: 'lesson.md',
		token: NEVER_CANCELLED,
	});
}

describe('a long recording Gemini transcribes in parts', () => {
	beforeEach(() => {
		prepareTwoParts();
		silenceConsole('warn');
	});

	it('writes why a part is missing into the warning the note keeps', async () => {
		queueResponses([
			REFUSED,
			answer({ segments: [{ start: 2, end: 4, text: 'Andrzej.' }] }),
		]);

		const result = await transcribe();

		expect(result.missingParts).toHaveLength(1);
		expect(result.markdown).toMatch(
			/\[!warning\] Transcription incomplete[^\n]*\n>[^\n]*Gemini blocked the request \(OTHER\)/,
		);
	});
});
