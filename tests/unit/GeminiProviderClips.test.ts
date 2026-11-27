/**
 * Tests the Gemini provider on a recording asked for in stretches: the
 * recording uploaded once for all of them, each request naming its stretch,
 * the answer re-counted from the start of the stretch whichever way the model
 * counted it, the output limit a stretch is given, and the upload deleted
 * when the run disposes of the provider.
 * @module tests/unit/GeminiProviderClips.test
 */

import { GeminiProvider } from 'src/transcription/providers/GeminiProvider';
import type { AudioPayload } from 'src/transcription/providers/TranscriptionProvider';
import { jsonBody } from '../helpers/assertions';
import { withRequestUrl } from '../helpers/network';
import type { MockRequestUrlParam } from '../mocks/obsidian';

const BASE_URL = 'https://gemini.example';
const FILE_URI = 'https://files.example/lesson';

/** The second ten minutes of a lesson, sent with thirty seconds before it. */
const SECOND_PART = { startSeconds: 570, endSeconds: 1200 };

/** The recording every part of one run is lent. */
const RECORDING = new ArrayBuffer(64);

/** What a clipped `generateContent` request carries, as far as tests read. */
interface ClipRequest {
	contents: {
		parts: {
			fileData?: { mimeType: string; fileUri: string };
			audioMetadata?: { startOffset: string; endOffset: string };
			text?: string;
		}[];
	}[];
	generationConfig: { maxOutputTokens?: number };
}

/** A line of an answer, with the timecodes as the model writes them. */
type AnswerLine = readonly [start: string, end: string, text: string];

/**
 * A part of the recording.
 * @param clip - The stretch it is for
 * @param data - The recording it is cut from
 * @returns The payload the service would send
 */
function part(
	clip: { startSeconds: number; endSeconds: number },
	data: ArrayBuffer = RECORDING,
): AudioPayload {
	return {
		data,
		contentType: 'audio/mp4',
		filename: 'lesson.m4a',
		offsetSeconds: clip.startSeconds,
		durationSeconds: clip.endSeconds - clip.startSeconds,
		clip,
	};
}

/** What the scripted endpoint was asked, by kind of request. */
interface Wire {
	readonly uploads: MockRequestUrlParam[];
	readonly generates: MockRequestUrlParam[];
	readonly deletes: MockRequestUrlParam[];
}

/**
 * Scripts the File API and `generateContent`.
 * @param lines - The lines every `generateContent` answers with
 * @param failedUploads - How many uploads are refused before one succeeds
 * @param state - The state Gemini reports the uploaded file in
 * @param failedDeletes - Whether deleting the upload is refused
 * @returns What was asked
 */
function script(
	lines: readonly AnswerLine[] = [],
	failedUploads = 0,
	state = 'ACTIVE',
	failedDeletes = false,
): Wire {
	const wire: Wire = { uploads: [], generates: [], deletes: [] };
	const segments = lines.map(([start, end, text]) => ({ start, end, text }));
	const file = { name: 'files/lesson', uri: FILE_URI, state };
	withRequestUrl((param) => {
		const ok = { status: 200, headers: {}, text: '' };
		if (param.url.endsWith('/upload/v1beta/files')) {
			wire.uploads.push(param);
			return wire.uploads.length <= failedUploads
				? { ...ok, status: 500 }
				: {
						...ok,
						headers: { 'x-goog-upload-url': `${BASE_URL}/session` },
					};
		}
		if (param.method === 'DELETE') {
			wire.deletes.push(param);
			return failedDeletes ? { ...ok, status: 500 } : ok;
		}
		if (param.url.includes(':generateContent')) {
			wire.generates.push(param);
			const text = JSON.stringify({ segments });
			return {
				...ok,
				text: JSON.stringify({
					candidates: [
						{
							finishReason: 'STOP',
							content: { parts: [{ text }] },
						},
					],
				}),
			};
		}
		return { ...ok, text: JSON.stringify({ file, ...file }) };
	});
	return wire;
}

/**
 * The provider under test.
 * @returns A Gemini provider on the scripted endpoint
 */
function provider(): GeminiProvider {
	return new GeminiProvider({
		baseUrl: BASE_URL,
		apiKey: 'gm-test',
		model: 'gemini-4-hydrogen',
	});
}

/**
 * Transcribes one part with the options a diarized run sends.
 * @param gemini - The provider
 * @param payload - The part
 * @returns What the provider answered
 */
function transcribe(
	gemini: GeminiProvider,
	payload: AudioPayload,
): ReturnType<GeminiProvider['transcribe']> {
	return gemini.transcribe(payload, { diarize: true, wordTimestamps: false });
}

/**
 * The first `generateContent` request of a run, decoded.
 * @param wire - What was asked
 * @returns Its body
 */
function firstRequest(wire: Wire): ClipRequest {
	return jsonBody<ClipRequest>(wire.generates[0]);
}

describe('GeminiProvider on a recording asked for in stretches', () => {
	it('uploads the recording once however many parts are asked for at the same time', async () => {
		const wire = script();
		const gemini = provider();

		await Promise.all([
			transcribe(gemini, part({ startSeconds: 0, endSeconds: 600 })),
			transcribe(gemini, part(SECOND_PART)),
			transcribe(gemini, part({ startSeconds: 1170, endSeconds: 1800 })),
		]);

		expect(wire.uploads).toHaveLength(1);
		expect(wire.generates).toHaveLength(3);
	});

	it('points each request at the upload and names its stretch', async () => {
		const wire = script();

		await transcribe(provider(), part(SECOND_PART));

		expect(firstRequest(wire).contents[0]?.parts[0]).toEqual({
			fileData: { mimeType: 'audio/mp4', fileUri: FILE_URI },
			audioMetadata: { startOffset: '570s', endOffset: '1200s' },
		});
	});

	it('writes a boundary that is not a whole second to the millisecond', async () => {
		const wire = script();

		await transcribe(
			provider(),
			part({ startSeconds: 726.39999, endSeconds: 1452.7787 }),
		);

		expect(firstRequest(wire).contents[0]?.parts[0]?.audioMetadata).toEqual(
			{
				startOffset: '726.4s',
				endOffset: '1452.779s',
			},
		);
	});

	it('asks for timecodes counted from the start of the stretch', async () => {
		const wire = script();

		await transcribe(provider(), part(SECOND_PART));

		expect(firstRequest(wire).contents[0]?.parts[1]?.text).toContain(
			'Count every timecode from the start of this excerpt',
		);
	});

	it('re-counts an answer the model timed from the start of the recording', async () => {
		script([
			['09:35', '09:40', 'Lead-in.'],
			['14:27', '14:30', 'Andrzej to mój przyjaciel.'],
			['19:58', '20:00', 'Do widzenia.'],
		]);

		const result = await transcribe(provider(), part(SECOND_PART));

		expect(result.segments.map(({ start, end }) => [start, end])).toEqual([
			[5, 10],
			[297, 300],
			[628, 630],
		]);
	});

	it('leaves an answer timed from the start of the stretch as it is', async () => {
		script([
			['00:05', '00:10', 'Lead-in.'],
			['04:57', '05:00', 'Andrzej to mój przyjaciel.'],
			['10:28', '10:30', 'Do widzenia.'],
		]);

		const result = await transcribe(provider(), part(SECOND_PART));

		expect(result.segments.map(({ start }) => start)).toEqual([
			5, 297, 628,
		]);
	});

	it.each([
		{ seconds: 630, limit: 37_800 },
		{ seconds: 10, limit: 4096 },
	])(
		'lets a stretch of $seconds s spend $limit output tokens',
		async ({ seconds, limit }) => {
			const wire = script();

			await transcribe(
				provider(),
				part({ startSeconds: 600, endSeconds: 600 + seconds }),
			);

			expect(firstRequest(wire).generationConfig.maxOutputTokens).toBe(
				limit,
			);
		},
	);

	it('deletes the upload once when the run disposes of the provider', async () => {
		const wire = script();
		const gemini = provider();
		await transcribe(gemini, part(SECOND_PART));

		expect(wire.deletes).toHaveLength(0);

		await gemini.dispose();
		await gemini.dispose();

		expect(wire.deletes.map(({ url }) => url)).toEqual([
			`${BASE_URL}/v1beta/files/lesson`,
		]);
	});

	it('uploads again for the part sent after an upload that failed', async () => {
		const wire = script([], 1);
		const gemini = provider();

		await expect(transcribe(gemini, part(SECOND_PART))).rejects.toThrow(
			'500',
		);
		await transcribe(gemini, part(SECOND_PART));

		expect(wire.uploads).toHaveLength(2);
		expect(wire.generates).toHaveLength(1);
	});

	it('deletes an upload Gemini could not process, and says so', async () => {
		const wire = script([], 0, 'FAILED');

		await expect(transcribe(provider(), part(SECOND_PART))).rejects.toThrow(
			/process/i,
		);

		expect(wire.deletes).toHaveLength(1);
	});

	it('still reports the failed processing when the cleanup fails too', async () => {
		script([], 0, 'FAILED', true);

		await expect(transcribe(provider(), part(SECOND_PART))).rejects.toThrow(
			/process/i,
		);
	});

	it('has nothing to delete when no stretch was ever asked for', async () => {
		const wire = script();

		await provider().dispose();

		expect(wire.deletes).toHaveLength(0);
	});
});

/** A short recording sent as it is, its length never measured. */
const WHOLE_RECORDING: AudioPayload = {
	data: new ArrayBuffer(8),
	contentType: 'audio/wav',
	filename: 'rec.wav',
	offsetSeconds: 0,
};

describe('GeminiProvider on a recording sent in one request', () => {
	it('sends no output limit when the length of the audio was never measured', async () => {
		const wire = script();

		await transcribe(provider(), WHOLE_RECORDING);

		expect(firstRequest(wire).generationConfig).not.toHaveProperty(
			'maxOutputTokens',
		);
	});

	it('does not tell the model the audio is an excerpt', async () => {
		const wire = script();

		await transcribe(provider(), WHOLE_RECORDING);

		expect(firstRequest(wire).contents[0]?.parts[1]?.text).not.toContain(
			'excerpt',
		);
	});
});
