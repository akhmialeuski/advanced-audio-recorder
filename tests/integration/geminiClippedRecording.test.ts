/**
 * An hour-long lesson transcribed by the real Gemini provider through the real
 * preparation and the real service, with only the wire scripted. The
 * recording is uploaded once in the container it was recorded in, its six
 * parts are asked for as stretches of that upload four at a time, and the
 * scripted model does what the real one did on November 26, 2026: it names
 * the speakers in the part that hears their names and numbers them in the
 * others, and it counts its timecodes from the start of the recording in
 * some answers and from the start of the stretch in others.
 * @module tests/integration/geminiClippedRecording.test
 */

import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { jsonBody } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { withRequestUrl } from '../helpers/network';
import { noticeMessages } from '../mocks/obsidian';

const RECORDING_SECONDS = 3600;
const PART_SECONDS = 600;
const PART_COUNT = RECORDING_SECONDS / PART_SECONDS;

/** Too large for its size to prove it shorter than one part. */
const RECORDING_BYTES = 1024 * 1024;

const recording = partial<TFile>({
	name: 'lesson.mp4',
	extension: 'mp4',
	path: 'lesson.mp4',
});

/** A line of the lesson, in the recording's own seconds. */
interface Spoken {
	readonly start: number;
	readonly end: number;
	readonly who: 'Olga' | 'Anatol';
	readonly text: string;
}

/**
 * What is said around the seam at the given second: the tutor's question
 * before it, and the student's answer across it.
 * @param seam - Where one part ends and the next begins
 * @returns The two lines
 */
function aroundSeam(seam: number): Spoken[] {
	return [
		{
			start: seam - 20,
			end: seam - 10,
			who: 'Olga',
			text: `Question before ${String(seam)}.`,
		},
		{
			start: seam - 5,
			end: seam + 5,
			who: 'Anatol',
			text: `Answer across ${String(seam)}.`,
		},
	];
}

/** Everything said in the lesson: a line inside each part, and each seam. */
const LESSON: Spoken[] = Array.from({ length: PART_COUNT }, (_, index) => [
	{
		start: index * PART_SECONDS + 100,
		end: index * PART_SECONDS + 110,
		who: 'Olga' as const,
		text: `Inside part ${String(index + 1)}.`,
	},
	...(index + 1 < PART_COUNT ? aroundSeam((index + 1) * PART_SECONDS) : []),
]).flat();

/** The stretch a `generateContent` request asked for, in seconds. */
function stretchOf(body: {
	contents: {
		parts: { audioMetadata?: { startOffset: string; endOffset: string } }[];
	}[];
}): { from: number; to: number } {
	const metadata = body.contents[0]?.parts[0]?.audioMetadata;
	return {
		from: Number.parseFloat(metadata?.startOffset ?? 'NaN'),
		to: Number.parseFloat(metadata?.endOffset ?? 'NaN'),
	};
}

/**
 * The model's answer for a stretch: every line that sounds in it, cut where
 * the stretch ends. The part that opens the lesson hears the names; every
 * other numbers the speakers, the odd parts the other way round. Odd parts
 * count their timecodes from the start of the recording.
 * @param from - Where the stretch starts
 * @param to - Where it ends
 * @returns The `generateContent` response text
 */
function answerFor(from: number, to: number): string {
	const index = Math.round(to / PART_SECONDS) - 1;
	const numbered =
		index % 2 === 1
			? { Olga: 'Speaker 1', Anatol: 'Speaker 2' }
			: { Olga: 'Speaker 2', Anatol: 'Speaker 1' };
	const base = index % 2 === 1 ? 0 : from;
	const segments = LESSON.filter(
		(line) => line.start < to && line.end > from,
	).map((line) => ({
		start: line.start - base,
		end: Math.min(line.end, to) - base,
		speaker: index === 0 ? line.who : numbered[line.who],
		text: line.end > to ? line.text.replace(/\.$/, '') : line.text,
	}));
	return JSON.stringify({
		candidates: [
			{
				finishReason: 'STOP',
				content: { parts: [{ text: JSON.stringify({ segments }) }] },
			},
		],
		usageMetadata: { candidatesTokenCount: 100 },
	});
}

/** What the scripted endpoint saw. */
interface Wire {
	uploadedBytes: number[];
	uploadTypes: string[];
	stretches: { from: number; to: number }[];
	outputLimits: number[];
	deleted: string[];
	mostAtOnce: number;
}

/**
 * Scripts the File API and `generateContent`, answering each stretch a turn
 * later so the requests in flight at the same time can be counted.
 * @param refuseEveryPart - Answers every stretch with a refusal that is not
 *   tried again, so the run has nothing to return
 * @param refusedAfter - Stretches refused the same way, by where each starts,
 *   with how many further turns its refusal takes to arrive
 * @returns What was asked
 */
function scriptGemini(
	refuseEveryPart = false,
	refusedAfter: ReadonlyMap<number, number> = new Map(),
): Wire {
	const wire: Wire = {
		uploadedBytes: [],
		uploadTypes: [],
		stretches: [],
		outputLimits: [],
		deleted: [],
		mostAtOnce: 0,
	};
	let inFlight = 0;
	const file = { name: 'files/lesson', uri: 'https://files/lesson' };
	withRequestUrl(async (param) => {
		const ok = { status: 200, headers: {}, text: '' };
		if (param.url.endsWith('/upload/v1beta/files')) {
			wire.uploadTypes.push(
				param.headers?.['X-Goog-Upload-Header-Content-Type'] ?? '',
			);
			return { ...ok, headers: { 'x-goog-upload-url': 'https://up' } };
		}
		if (param.url === 'https://up') {
			wire.uploadedBytes.push((param.body as ArrayBuffer).byteLength);
			return { ...ok, text: JSON.stringify({ file }) };
		}
		if (param.method === 'DELETE') {
			wire.deleted.push(param.url);
			return ok;
		}
		if (!param.url.includes(':generateContent')) {
			return {
				...ok,
				text: JSON.stringify({ ...file, state: 'ACTIVE' }),
			};
		}
		const body = jsonBody<
			Parameters<typeof stretchOf>[0] & {
				generationConfig: { maxOutputTokens: number };
			}
		>(param);
		const stretch = stretchOf(body);
		wire.stretches.push(stretch);
		wire.outputLimits.push(body.generationConfig.maxOutputTokens);
		inFlight++;
		wire.mostAtOnce = Math.max(wire.mostAtOnce, inFlight);
		await tick();
		const wait = refusedAfter.get(stretch.from);
		for (let turn = 0; turn < (wait ?? 0); turn++) {
			await tick();
		}
		inFlight--;
		if (refuseEveryPart || wait !== undefined) {
			return { ...ok, status: 400, text: '{"error":{"message":"bad"}}' };
		}
		return { ...ok, text: answerFor(stretch.from, stretch.to) };
	});
	return wire;
}

/**
 * Transcribes the lesson with speaker labels through a real Gemini provider.
 * @param durationSeconds - What the recording's container says its length
 *   is, or null when it does not say
 * @param bytes - How large the recording's file is
 * @returns What the run returned
 */
function transcribe(
	durationSeconds: number | null = RECORDING_SECONDS,
	bytes = RECORDING_BYTES,
): ReturnType<TranscriptionService['run']> {
	const { app } = createMockApp();
	app.vault.readBinary = jest.fn(() =>
		Promise.resolve(new ArrayBuffer(bytes)),
	);
	const service = new TranscriptionService(
		app,
		() =>
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				transcriptionDiarize: true,
				geminiApiKey: 'gm-test',
			}),
		{
			createProvider: () =>
				new GeminiProvider({
					baseUrl: 'https://gemini.example',
					apiKey: 'gm-test',
					model: 'gemini-4-hydrogen',
				}),
			readDurationSeconds: () => Promise.resolve(durationSeconds),
		},
	);
	return service.run(recording, {
		notePathForLinks: 'lesson.md',
		token: NEVER_CANCELLED,
	});
}

describe('an hour-long lesson Gemini transcribes as stretches of one upload', () => {
	it('uploads the recording once, in the container it was recorded in', async () => {
		const wire = scriptGemini();

		await transcribe();

		expect(wire.uploadedBytes).toEqual([RECORDING_BYTES]);
		expect(wire.uploadTypes).toEqual(['audio/mp4']);
	});

	it('asks for six ten-minute parts, each later one with the half minute before it', async () => {
		const wire = scriptGemini();

		await transcribe();

		expect([...wire.stretches].sort((a, b) => a.from - b.from)).toEqual([
			{ from: 0, to: 600 },
			{ from: 570, to: 1200 },
			{ from: 1170, to: 1800 },
			{ from: 1770, to: 2400 },
			{ from: 2370, to: 3000 },
			{ from: 2970, to: 3600 },
		]);
	});

	it('has four parts in flight at once and no more', async () => {
		const wire = scriptGemini();

		await transcribe();

		expect(wire.mostAtOnce).toBe(4);
	});

	it('limits what each part may answer by the audio it covers', async () => {
		const wire = scriptGemini();

		await transcribe();

		expect([...new Set(wire.outputLimits)].sort((a, b) => a - b)).toEqual([
			36_000, 37_800,
		]);
	});

	it('writes every line once, under the name its speaker was first given', async () => {
		scriptGemini();

		const result = await transcribe();

		expect(
			result.transcript.segments.map(
				(segment) => `${segment.speaker ?? '?'}: ${segment.text}`,
			),
		).toEqual(LESSON.map((line) => `${line.who}: ${line.text}`));
		expect(result.transcript.speakers).toEqual(['Olga', 'Anatol']);
	});

	it('puts every line where it was spoken, whichever way the model counted', async () => {
		scriptGemini();

		const result = await transcribe();

		expect(
			result.transcript.segments.map(({ start, end }) => [start, end]),
		).toEqual(LESSON.map(({ start, end }) => [start, end]));
	});

	it('reports no missing part and no warning about speakers across parts', async () => {
		scriptGemini();

		const result = await transcribe();

		expect(result.missingParts).toEqual([]);
		expect(noticeMessages()).toEqual([]);
	});

	it('deletes the upload when the run is over', async () => {
		const wire = scriptGemini();

		await transcribe();

		expect(wire.deleted).toEqual([
			'https://gemini.example/v1beta/files/lesson',
		]);
	});

	it('bills the lead-ins with the parts they were sent with', async () => {
		scriptGemini();

		const result = await transcribe();

		expect(result.sentSeconds).toBe(RECORDING_SECONDS + 5 * 30);
	});

	// The upload outlives the requests that read it, so a run that ends in an
	// error would otherwise leave the recording on Google's side.
	it('deletes the upload when every part was refused and the run failed', async () => {
		const wire = scriptGemini(true);

		await expect(transcribe()).rejects.toThrow('status 400');

		expect(wire.deleted).toHaveLength(1);
	});
});

// Four requests are in flight together, so parts fail in the order their
// requests end. The warning names the parts and quotes the first failure, and
// both read as the recording runs only when the failures are in its order.
describe('parts of the lesson that fail while others are in flight', () => {
	it('reports them in the order of the recording, whichever failed first', async () => {
		scriptGemini(
			false,
			new Map([
				[570, 3],
				[1170, 0],
			]),
		);

		const result = await transcribe();

		expect(result.missingParts.map((part) => part.startSeconds)).toEqual([
			600, 1200,
		]);
	});
});

// A file this small is proven shorter than one part by its size alone, and
// used to be sent whole without the length its container states. With no
// length its request carried no output limit, so a looping answer ran on to
// the model's own ceiling.
describe('a short memo Gemini transcribes in one request', () => {
	it('limits what the answer may spend by the length of the memo', async () => {
		const wire = scriptGemini();

		await transcribe(120, 100 * 1024);

		expect(wire.outputLimits).toEqual([120 * 60]);
	});
});
