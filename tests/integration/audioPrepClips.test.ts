/**
 * Tests the preparation of a recording for an engine that cuts each part out
 * of the file it is sent once: parts planned from the length the container
 * states, with no decode, each later part started early by its lead-in, and
 * the decode path taken whenever the plan cannot be made.
 * @module tests/integration/audioPrepClips.test
 */

// The decode needs Web Audio. Mocked so a case can say it never ran.
jest.mock('src/transcription/audioChunks', () => ({
	...jest.requireActual<object>('src/transcription/audioChunks'),
	decodeToMono16k: jest.fn(),
}));

import {
	audioContainerFromExtension,
	audioPrepOptions,
	ownStartSeconds,
	prepareAudio,
	type AudioPrepOptions,
	type PreparedPayload,
} from 'src/transcription/audioPrep';
import { decodeToMono16k } from 'src/transcription/audioChunks';
import { GEMINI_CAPABILITIES } from 'src/transcription/providers/capabilities';
import { MIN_SUBDIVIDE_SECONDS, TRANSCRIBE_SAMPLE_RATE } from 'src/constants';
import { at, defined } from '../helpers/assertions';

const decodeMock = jest.mocked(decodeToMono16k);

/** An hour-long lesson, in a file too large to be proven short by its size. */
const LESSON_SECONDS = 3600;
const LESSON = new ArrayBuffer(1024 * 1024);

/**
 * Gemini's preparation options for a recording of a known length.
 * @param overrides - What a case varies
 * @returns The options
 */
function geminiOptions(
	overrides: Partial<AudioPrepOptions> = {},
): AudioPrepOptions {
	return {
		...audioPrepOptions(
			GEMINI_CAPABILITIES,
			'Google Gemini',
			true,
			24 * 1024 * 1024,
			true,
		),
		knownDurationSeconds: LESSON_SECONDS,
		...overrides,
	};
}

/**
 * Prepares the lesson as an `mp4` unless a case says otherwise.
 * @param options - Preparation options
 * @param extension - The container the lesson is in
 * @returns The prepared parts
 */
async function prepareLesson(
	options: AudioPrepOptions = geminiOptions(),
	extension = 'mp4',
): Promise<PreparedPayload[]> {
	const prepared = await prepareAudio(
		LESSON,
		`lesson.${extension}`,
		audioContainerFromExtension(extension),
		options,
	);
	return prepared.payloads;
}

/**
 * Where each part starts and ends, as it is sent.
 * @param payloads - The prepared parts
 * @returns The sent stretch of each
 */
function stretches(payloads: readonly PreparedPayload[]): number[][] {
	return payloads.map((payload) => [
		payload.offsetSeconds,
		payload.endSeconds ?? Number.NaN,
	]);
}

describe('audioPrepOptions for Gemini', () => {
	it('plans by clips, with a lead-in when the run labels speakers', () => {
		expect(geminiOptions()).toMatchObject({
			clipsUploadedFile: true,
			leadInSeconds: 30,
			chunkSeconds: 600,
		});
	});

	it('plans no lead-in for a run without speaker labels', () => {
		const options = audioPrepOptions(
			GEMINI_CAPABILITIES,
			'Google Gemini',
			true,
			24 * 1024 * 1024,
			false,
		);

		expect(options.leadInSeconds).toBe(0);
	});
});

describe('prepareAudio for an engine that clips an uploaded recording', () => {
	it('plans ten-minute parts from the stated length without decoding', async () => {
		const payloads = await prepareLesson();

		expect(payloads).toHaveLength(6);
		expect(decodeMock).not.toHaveBeenCalled();
	});

	it('lends every part the recording itself, in its own container', async () => {
		const payloads = await prepareLesson();

		expect(payloads.map((payload) => payload.createData())).toEqual(
			payloads.map(() => LESSON),
		);
		expect(new Set(payloads.map((payload) => payload.contentType))).toEqual(
			new Set(['audio/mp4']),
		);
	});

	it('starts every later part half a minute early', async () => {
		const payloads = await prepareLesson();

		expect(stretches(payloads).slice(0, 3)).toEqual([
			[0, 600],
			[570, 1200],
			[1170, 1800],
		]);
		expect(payloads.map((payload) => payload.clip)).toEqual(
			stretches(payloads).map(([startSeconds, endSeconds]) => ({
				startSeconds,
				endSeconds,
			})),
		);
	});

	it('marks the lead-in, so the part still answers for its own stretch', async () => {
		const payloads = await prepareLesson();

		expect(payloads.map(ownStartSeconds)).toEqual([
			0, 600, 1200, 1800, 2400, 3000,
		]);
		expect(at(payloads, 0).leadInSeconds).toBeUndefined();
	});

	it('does not warn about speakers when the parts overlap to be matched', async () => {
		const prepared = await prepareAudio(
			LESSON,
			'lesson.mp4',
			audioContainerFromExtension('mp4'),
			geminiOptions(),
		);

		expect(prepared.diarizationSplitWarning).toBe(false);
	});

	it('plans parts that tile the recording when no speakers are labelled', async () => {
		const payloads = await prepareLesson(
			geminiOptions({ diarize: false, leadInSeconds: 0 }),
		);

		expect(stretches(payloads).slice(0, 2)).toEqual([
			[0, 600],
			[600, 1200],
		]);
	});

	it('sends a recording within one part whole, with its end known', async () => {
		const payloads = await prepareLesson(
			geminiOptions({ knownDurationSeconds: 480 }),
		);

		expect(payloads).toHaveLength(1);
		expect(at(payloads, 0)).toMatchObject({
			offsetSeconds: 0,
			endSeconds: 480,
		});
		expect(at(payloads, 0).clip).toBeUndefined();
	});

	it('splits a part that overran into halves, the second with a lead-in', async () => {
		const payloads = await prepareLesson();

		const halves = defined(at(payloads, 1).subdivide)();

		expect(stretches(halves)).toEqual([
			[570, 900],
			[870, 1200],
		]);
		expect(halves.map(ownStartSeconds)).toEqual([600, 900]);
	});

	it('stops splitting once a half would be shorter than the floor', async () => {
		const payloads = await prepareLesson(
			geminiOptions({
				knownDurationSeconds: MIN_SUBDIVIDE_SECONDS * 3,
				chunkSeconds: MIN_SUBDIVIDE_SECONDS * 1.5,
			}),
		);

		expect(defined(at(payloads, 0).subdivide)()).toEqual([]);
	});
});

describe('prepareAudio when the plan cannot be made from the file', () => {
	beforeEach(() => {
		decodeMock.mockResolvedValue(
			new Float32Array(1200 * TRANSCRIBE_SAMPLE_RATE),
		);
	});

	it.each([
		{
			why: 'the length is not known',
			options: { knownDurationSeconds: undefined },
		},
		{
			why: 'the stated length is zero',
			options: { knownDurationSeconds: 0 },
		},
		{
			why: 'the engine does not clip',
			options: { clipsUploadedFile: false },
		},
		{
			why: 'the file is over the byte limit',
			options: { maxRequestBytes: 1000 },
		},
	])('decodes the recording when $why', async ({ options }) => {
		const payloads = await prepareLesson(geminiOptions(options));

		expect(decodeMock).toHaveBeenCalledTimes(1);
		expect(at(payloads, 0).contentType).toBe('audio/wav');
	});

	it('decodes a container the engine does not read', async () => {
		const payloads = await prepareLesson(geminiOptions(), '3gp');

		expect(at(payloads, 0).contentType).toBe('audio/wav');
	});

	it('gives the decoded parts the same lead-in, cut from the samples', async () => {
		const payloads = await prepareLesson(
			geminiOptions({ knownDurationSeconds: undefined }),
		);

		expect(stretches(payloads)).toEqual([
			[0, 600],
			[570, 1200],
		]);
		expect(at(payloads, 1).leadInSeconds).toBe(30);
		expect(at(payloads, 1).clip).toBeUndefined();
	});
});

// A request for a recording of one part carries an output limit like any
// other, so an answer cut at it has to be recoverable in halves, as a part of
// a longer recording is.
describe('prepareAudio for a recording that fits one request', () => {
	it('splits it into two stretches of the same upload when its answer was cut', async () => {
		const payloads = await prepareLesson(
			geminiOptions({ knownDurationSeconds: 540 }),
		);

		const halves = defined(at(payloads, 0).subdivide)();

		expect(stretches(halves)).toEqual([
			[0, 270],
			[240, 540],
		]);
		expect(halves.map((half) => half.clip)).toEqual([
			{ startSeconds: 0, endSeconds: 270 },
			{ startSeconds: 240, endSeconds: 540 },
		]);
	});
});
