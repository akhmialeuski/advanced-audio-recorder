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
import type { RecordingRange } from 'src/transcription/partFailure';
import { prepareAudio } from 'src/transcription/audioPrep';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { partial, silenceConsole } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { queueResponses } from '../helpers/network';
import { noticeMessages } from '../mocks/obsidian';

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

/**
 * Parts with measured spans, small enough to go inline.
 * @param bounds - Where each part starts and ends, in seconds
 */
function prepareParts(bounds: [number, number][]): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: bounds.map(([offsetSeconds, endSeconds]) => ({
			contentType: 'audio/wav',
			filename: `audio-${String(offsetSeconds)}.wav`,
			offsetSeconds,
			endSeconds,
			createData: () => new ArrayBuffer(4),
		})),
		diarizationSplitWarning: false,
	});
}

/** A line of a part, timed from the start of that part. */
interface Line {
	start: number;
	end: number;
	text: string;
}

/**
 * A `generateContent` answer carrying the given lines.
 * @param segments - What the model's JSON transcript holds
 * @param outputTokens - What the answer reports it was billed for, or null
 *   for an answer that reports no usage
 * @returns The response the request resolves with
 */
function answer(
	segments: Line[],
	outputTokens: number | null = 100,
): { text: string } {
	return {
		text: JSON.stringify({
			candidates: [
				{
					finishReason: 'STOP',
					content: {
						parts: [{ text: JSON.stringify({ segments }) }],
					},
				},
			],
			...(outputTokens === null
				? {}
				: { usageMetadata: { candidatesTokenCount: outputTokens } }),
		}),
	};
}

/** A `generateContent` answer the model refused, with the reason it gave. */
const REFUSED = {
	text: JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }),
};

/** A first part that runs to its end, as a sound answer does. */
const WHOLE_FIRST = answer([
	{ start: 24, end: 30, text: 'Dzień dobry.' },
	{ start: 700, end: 726, text: 'Dobrze.' },
]);

/** A last part whose closing line the model put a minute and a half late. */
const OVERRUN_LAST = answer([
	{ start: 141, end: 145, text: 'Andrzej to mój przyjaciel.' },
	{ start: 840, end: 842, text: 'Do widzenia.' },
]);

/** The same last part answered inside its bounds. */
const WHOLE_LAST = answer([
	{ start: 141, end: 145, text: 'Andrzej to mój przyjaciel.' },
	{ start: 724, end: 726, text: 'Do widzenia.' },
]);

/**
 * What a run keeps of the first part answered whole and the last part
 * answered past its end: every line that starts inside its part.
 */
const LINES_THAT_FIT = [
	'Dzień dobry.',
	'Dobrze.',
	'Andrzej to mój przyjaciel.',
];

/** A request the endpoint refused outright, which is not tried again. */
const BAD_REQUEST = {
	status: 400,
	text: JSON.stringify({ error: { message: 'bad' } }),
};

/** An answer the model cut off at its output limit, billed for 500 tokens. */
const TRUNCATED = {
	text: JSON.stringify({
		candidates: [
			{
				finishReason: 'MAX_TOKENS',
				content: { parts: [{ text: '{"segments":[' }] },
			},
		],
		usageMetadata: { candidatesTokenCount: 500 },
	}),
};

/** A first part whose lines stop at 7:30 of its 12:06. */
const SHORT_FIRST = answer([{ start: 24, end: 450, text: 'Dzień dobry.' }]);

/**
 * Transcribes the recording through a real Gemini provider.
 * @param onlyRanges - The stretches a top-up asks for, or none for a full run
 * @returns What the run returned
 */
function transcribe(
	onlyRanges?: RecordingRange[],
): ReturnType<TranscriptionService['run']> {
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
		...(onlyRanges ? { onlyRanges } : {}),
	});
}

describe('a long recording Gemini transcribes in parts', () => {
	beforeEach(() => {
		prepareParts([
			[0, PART_SECONDS],
			[PART_SECONDS, RECORDING_SECONDS],
		]);
		silenceConsole('warn');
	});

	it('places no line past the end of the recording when the model overruns its part', async () => {
		queueResponses([WHOLE_FIRST, OVERRUN_LAST, OVERRUN_LAST]);

		const result = await transcribe();

		const lastStart = result.transcript.segments.at(-1)?.start ?? 0;
		expect(lastStart).toBeLessThan(RECORDING_SECONDS);
	});

	it('sends a part again when its answer leaves it, and keeps the answer that fits', async () => {
		const sent = queueResponses([WHOLE_FIRST, OVERRUN_LAST, WHOLE_LAST]);

		const result = await transcribe();

		expect(sent).toHaveLength(3);
		expect(result.missingParts).toEqual([]);
		expect(result.markdown).not.toContain('[!warning]');
		expect(result.transcript.segments.at(-1)).toMatchObject({
			start: PART_SECONDS + 724,
			text: 'Do widzenia.',
		});
	});

	it('counts what the rejected answer was billed for', async () => {
		queueResponses([
			answer(
				[
					{ start: 24, end: 30, text: 'Dzień dobry.' },
					{ start: 700, end: 726, text: 'Dobrze.' },
				],
				10,
			),
			answer([{ start: 840, end: 842, text: 'Do widzenia.' }], 200),
			answer([{ start: 724, end: 726, text: 'Do widzenia.' }], 3000),
		]);

		const result = await transcribe();

		expect(result.cost.usage.outputTokens).toBe(3210);
	});

	it('keeps what fits and names the part with its reason when both answers leave it', async () => {
		queueResponses([WHOLE_FIRST, OVERRUN_LAST, OVERRUN_LAST]);

		const result = await transcribe();

		expect(result.transcript.segments.map((s) => s.text)).toEqual(
			LINES_THAT_FIT,
		);
		expect(result.missingParts).toEqual([
			{
				label: 'the 12:06-24:13 segment',
				message:
					'Google Gemini placed lines up to 14:02 in a part 12:06 long, on both attempts, so the lines past 12:06 were dropped.',
				startSeconds: PART_SECONDS,
				endSeconds: RECORDING_SECONDS,
			},
		]);
		expect(result.markdown).toContain(
			'> - The 12:06-24:13 segment: Google Gemini placed lines up to 14:02',
		);
		expect(noticeMessages()).toContainEqual(
			expect.stringContaining('the 12:06-24:13 segment'),
		);
	});

	it('sends a part again when its lines stop more than a minute before its end', async () => {
		const sent = queueResponses([SHORT_FIRST, WHOLE_FIRST, WHOLE_LAST]);

		const result = await transcribe();

		expect(sent).toHaveLength(3);
		expect(result.missingParts).toEqual([]);
	});

	it('reports a part whose lines stopped short on both attempts', async () => {
		queueResponses([SHORT_FIRST, SHORT_FIRST, WHOLE_LAST]);

		const result = await transcribe();

		expect(result.missingParts.map((part) => part.message)).toEqual([
			'Google Gemini stopped at 7:30 in a part 12:06 long, on both attempts, so the rest of the part may be missing.',
		]);
		expect(result.transcript.segments.map((s) => s.text)).toContain(
			'Dzień dobry.',
		);
	});

	// The reason is the one record of what went wrong once the notice closes,
	// so it says what each attempt did rather than claiming both did the same.
	it('names both faults when the two answers failed differently', async () => {
		queueResponses([
			SHORT_FIRST,
			answer([{ start: 798, end: 800, text: 'Dobrze.' }]),
			WHOLE_LAST,
		]);

		const result = await transcribe();

		expect(result.missingParts.map((part) => part.message)).toEqual([
			'Google Gemini placed lines up to 13:20 in a part 12:06 long, after a first answer that stopped at 7:30, so the lines past 12:06 were dropped.',
		]);
	});

	it('takes a last part that ends early, since a recording often runs on in silence', async () => {
		const sent = queueResponses([
			WHOLE_FIRST,
			answer([{ start: 2, end: 60, text: 'Do widzenia.' }]),
		]);

		const result = await transcribe();

		expect(sent).toHaveLength(2);
		expect(result.missingParts).toEqual([]);
	});

	it('writes why a part is missing into the warning the note keeps', async () => {
		queueResponses([REFUSED, WHOLE_LAST]);

		const result = await transcribe();

		expect(result.missingParts).toHaveLength(1);
		expect(result.markdown).toMatch(
			/\[!warning\] Transcription incomplete[^\n]*\n>[^\n]*Gemini blocked the request \(OTHER\)/,
		);
	});

	it('sends a part again when the rejected answer reported no usage', async () => {
		const sent = queueResponses([
			WHOLE_FIRST,
			answer([{ start: 840, end: 842, text: 'Do widzenia.' }], null),
			WHOLE_LAST,
		]);

		const result = await transcribe();

		expect(sent).toHaveLength(3);
		expect(result.missingParts).toEqual([]);
	});

	// A recording sent in one request has no part label, so the warning names
	// the stretch by its span instead.
	it('names a recording sent whole by its span when both answers leave it', async () => {
		prepareParts([[0, PART_SECONDS]]);
		queueResponses([OVERRUN_LAST, OVERRUN_LAST]);

		const result = await transcribe();

		expect(result.missingParts.map((part) => part.label)).toEqual([
			'the 0:00-12:06 segment',
		]);
	});

	// The first answer was billed and its lines inside the part are sound, so
	// a second request that fails is no reason to lose them.
	it('keeps what fits of the first answer when sending the part again fails', async () => {
		queueResponses([WHOLE_FIRST, OVERRUN_LAST, BAD_REQUEST]);

		const result = await transcribe();

		expect(result.transcript.segments.map((s) => s.text)).toEqual(
			LINES_THAT_FIT,
		);
		expect(result.missingParts.map((part) => part.message)).toEqual([
			'Google Gemini placed lines up to 14:02 in a part 12:06 long, and sending the part again failed, so the lines past 12:06 were dropped. Request to https://gemini.example/v1beta/models/gemini-3.8-flash:generateContent failed with status 400: bad',
		]);
	});

	it('bills the kept first answer once when sending the part again fails', async () => {
		queueResponses([WHOLE_FIRST, OVERRUN_LAST, BAD_REQUEST]);

		const result = await transcribe();

		expect(result.cost.usage.outputTokens).toBe(200);
	});

	// A second answer cut off at the output limit is no better than a failed
	// request, and splitting the part would send it twice more for an answer
	// already in hand.
	it('keeps what fits of the first answer when the second one is cut off', async () => {
		const sent = queueResponses([WHOLE_FIRST, OVERRUN_LAST, TRUNCATED]);

		const result = await transcribe();

		expect(sent).toHaveLength(3);
		expect(result.transcript.segments.map((s) => s.text)).toContain(
			'Andrzej to mój przyjaciel.',
		);
	});

	it('bills the second answer that was cut off', async () => {
		queueResponses([WHOLE_FIRST, OVERRUN_LAST, TRUNCATED]);

		const result = await transcribe();

		expect(result.cost.usage.outputTokens).toBe(700);
	});

	// A top-up sends only the parts that failed, and the first part of the
	// recording is still not its end, so its silent tail is still judged.
	it('judges a part a top-up sends again by where the recording ends', async () => {
		const sent = queueResponses([SHORT_FIRST, SHORT_FIRST]);

		const result = await transcribe([
			{ startSeconds: 0, endSeconds: PART_SECONDS },
		]);

		expect(sent).toHaveLength(2);
		expect(result.missingParts.map((part) => part.label)).toEqual([
			'the 0:00-12:06 segment',
		]);
	});
});
