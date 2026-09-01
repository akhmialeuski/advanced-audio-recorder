/**
 * Tests for topping up a transcript with the parts that failed. The two
 * properties that matter: exactly the missing stretches are asked for, so the
 * top-up is billed for those alone, and what comes back is spliced onto the
 * timeline without touching or doubling what was already there.
 */

import { TFile } from 'obsidian';
import {
	FailedPartRetry,
	serviceRunner,
	spliceSegments,
	type RetrySidecar,
} from 'src/transcription/retryFailedParts';
import type { PartFailure } from 'src/transcription/partFailure';
import type { TranscribeRunCost } from 'src/transcription/TranscriptionService';
import type {
	Transcript,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import { createMockApp } from '../helpers/createApp';
import { partial } from '../helpers/doubles';
import { at } from '../helpers/assertions';

/** A transcript of the given segments. */
function transcriptOf(segments: TranscriptSegment[]): Transcript {
	return { segments, speakers: [], language: 'en' };
}

const HEARD: TranscriptSegment[] = [
	{ start: 0, end: 30, text: 'the opening' },
	{ start: 120, end: 150, text: 'the closing' },
];

/** What the engine reported for a top-up run. */
const RUN_COST: TranscribeRunCost = {
	engineId: 'deepgram',
	usd: 0.02,
	usage: {},
};

const LOST: PartFailure = {
	label: '0:30-2:00',
	message: 'rate limited',
	startSeconds: 30,
	endSeconds: 120,
};

interface Sut {
	retry: FailedPartRetry;
	written: Map<string, string>;
	asked: { startSeconds: number; endSeconds: number }[][];
	recorded: PartFailure[][];
}

/**
 * A retry over a recording whose JSON transcript holds the two parts that
 * succeeded, and whose sidecar records the one that did not.
 * @param options - What this case varies
 * @returns The retry, what it wrote, and what it asked for
 */
function createSut(
	options: {
		failed?: PartFailure[] | null;
		outputs?: { path: string; format: string; language?: string }[];
		recovered?: TranscriptSegment[];
		stillMissing?: PartFailure[];
		files?: Record<string, string>;
		cost?: TranscribeRunCost;
	} = {},
): Sut {
	const written = new Map<string, string>();
	const asked: { startSeconds: number; endSeconds: number }[][] = [];
	const recorded: PartFailure[][] = [];
	const files: Record<string, string> = options.files ?? {
		'rec.transcript.json': JSON.stringify(transcriptOf(HEARD)),
	};
	const app = createMockApp({
		vault: {
			getAbstractFileByPath: (path: string) =>
				path in files
					? Object.assign(Object.create(TFile.prototype), { path })
					: null,
			read: (file: TFile) => Promise.resolve(files[file.path] ?? ''),
			modify: (file: TFile, data: string) => {
				written.set(file.path, data);
				return Promise.resolve();
			},
		},
	}).app;
	const sidecar = partial<RetrySidecar>({
		getFailedParts: () =>
			Promise.resolve(
				options.failed === null
					? null
					: {
							parts: options.failed ?? [LOST],
							recordedAt: '2026-08-31T10:00:00.000Z',
						},
			),
		setFailedParts: (_p: string, parts: readonly PartFailure[]) => {
			recorded.push([...parts]);
			return Promise.resolve();
		},
		getTranscript: () =>
			Promise.resolve({
				fileOutputs: (
					options.outputs ?? [
						{ path: 'rec.transcript.json', format: 'json' },
					]
				).map((o) => ({ ...o, writtenAt: '' })),
			} as Awaited<ReturnType<RetrySidecar['getTranscript']>>),
	});
	const retry = new FailedPartRetry(
		app,
		Object.assign(Object.create(TFile.prototype), {
			path: 'rec.webm',
		}) as TFile,
		sidecar,
		(_file, ranges) => {
			asked.push([...ranges]);
			return Promise.resolve({
				transcript: transcriptOf(
					options.recovered ?? [
						{ start: 60, end: 90, text: 'the middle' },
					],
				),
				missingParts: options.stillMissing ?? [],
				cost: options.cost ?? RUN_COST,
			});
		},
	);
	return { retry, written, asked, recorded };
}

describe('splicing recovered segments into a transcript', () => {
	/** The stretch the top-up asked for in these cases. */
	const ASKED = [{ startSeconds: 30, endSeconds: 120 }];

	it('puts them in time order among the ones already there', () => {
		const { transcript, spliced } = spliceSegments(
			transcriptOf(HEARD),
			[{ start: 60, end: 90, text: 'the middle' }],
			ASKED,
		);

		expect(transcript.segments.map((s) => s.text)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
		expect(spliced).toBe(1);
	});

	it('replaces whatever the transcript held inside the asked stretch', () => {
		// A stretch was asked for again because what was there is not wanted,
		// so what comes back for it is what it holds afterwards
		const { transcript } = spliceSegments(
			transcriptOf([
				...HEARD,
				{ start: 60, end: 90, text: 'a garbled attempt' },
			]),
			[{ start: 60, end: 90, text: 'the middle' }],
			ASKED,
		);

		expect(transcript.segments.map((s) => s.text)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
	});

	it('drops what the answer carried from outside the asked stretch', () => {
		// The part plan is a function of the settings in force, so a chunk
		// size changed between the run and the top-up sends neighbouring
		// parts again. They come back a fraction of a second off the stored
		// offsets, and taking them writes the same speech into the transcript
		// twice.
		const { transcript, spliced } = spliceSegments(
			transcriptOf(HEARD),
			[
				{ start: 0.4, end: 30, text: 'the opening, again' },
				{ start: 60, end: 90, text: 'the middle' },
			],
			ASKED,
		);

		expect(transcript.segments.map((s) => s.text)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
		expect(spliced).toBe(1);
	});

	it('keeps everything else about the transcript', () => {
		const { transcript } = spliceSegments(transcriptOf(HEARD), [], ASKED);

		expect(transcript.language).toBe('en');
		expect(transcript.segments).toHaveLength(2);
	});
});

describe('topping up a transcript', () => {
	it('asks for exactly the stretches that failed', async () => {
		const { retry, asked } = createSut();

		await retry.retry();

		expect(at(asked, 0)).toEqual([{ startSeconds: 30, endSeconds: 120 }]);
	});

	it('rewrites the transcript file with the completed transcript', async () => {
		const { retry, written } = createSut();

		const outcome = await retry.retry();

		expect(outcome.recovered).toBe(1);
		expect(outcome.rewritten).toBe(1);
		const rewritten = JSON.parse(
			written.get('rec.transcript.json') ?? '{}',
		) as Transcript;
		expect(rewritten.segments.map((s) => s.text)).toEqual([
			'the opening',
			'the middle',
			'the closing',
		]);
	});

	it('rewrites every recorded output, each in its own format', async () => {
		const { retry, written } = createSut({
			outputs: [
				{ path: 'rec.transcript.json', format: 'json' },
				{ path: 'rec.srt', format: 'srt' },
			],
			files: {
				'rec.transcript.json': JSON.stringify(transcriptOf(HEARD)),
				'rec.srt': 'stale',
			},
		});

		const outcome = await retry.retry();

		expect(outcome.rewritten).toBe(2);
		expect(written.get('rec.srt')).toContain('the middle');
	});

	it('records what failed again, and clears the record when nothing did', async () => {
		const stillMissing = [{ ...LOST, message: 'refused again' }];
		const { retry, recorded } = createSut({ stillMissing });

		const outcome = await retry.retry();

		expect(at(recorded, 0)).toEqual(stillMissing);
		expect(outcome.stillMissing).toEqual(stillMissing);

		const clean = createSut();
		await clean.retry.retry();
		expect(at(clean.recorded, 0)).toEqual([]);
	});

	it('keeps a part it had no bounds to ask for on the record', async () => {
		// It was never sent, so it is still missing. Writing only what came
		// back erased it, and an absent record means "nothing is missing":
		// the recording then reported itself complete with a gap in it.
		const WHOLE_FILE: PartFailure = {
			label: 'the recording',
			message: 'too big',
			startSeconds: 0,
		};
		const { retry, recorded, asked } = createSut({
			failed: [WHOLE_FILE, LOST],
		});

		const outcome = await retry.retry();

		expect(at(asked, 0)).toEqual([{ startSeconds: 30, endSeconds: 120 }]);
		expect(at(recorded, 0)).toEqual([WHOLE_FILE]);
		expect(outcome.stillMissing).toEqual([WHOLE_FILE]);
	});

	it('reports what the engine charged for the stretches it sent', async () => {
		// A top-up calls the same paid engine a full run does, and the
		// session total covered every other surface but not this one
		const { retry } = createSut();

		const outcome = await retry.retry();

		expect(outcome.cost).toEqual(RUN_COST);
		expect(outcome.sentSeconds).toBe(90);
	});

	it('leaves a translation alone, since it is a second document', async () => {
		const { retry, written } = createSut({
			outputs: [
				{ path: 'rec.transcript.json', format: 'json' },
				{ path: 'rec.Spanish.srt', format: 'srt', language: 'Spanish' },
			],
			files: {
				'rec.transcript.json': JSON.stringify(transcriptOf(HEARD)),
				'rec.Spanish.srt': 'la apertura',
			},
		});

		await retry.retry();

		expect(written.has('rec.Spanish.srt')).toBe(false);
	});

	it('counts out an output that has since been removed', async () => {
		const { retry } = createSut({
			outputs: [
				{ path: 'rec.transcript.json', format: 'json' },
				{ path: 'gone.srt', format: 'srt' },
			],
		});

		expect((await retry.retry()).rewritten).toBe(1);
	});
});

describe('a top-up that cannot be attempted', () => {
	it('says so when nothing is missing', async () => {
		const { retry, asked } = createSut({ failed: null });

		const outcome = await retry.retry();

		expect(outcome.blocked).toContain('Nothing is missing');
		expect(asked).toHaveLength(0);
	});

	it('says so when the parts that failed carry no measured end', async () => {
		// The whole-file path never measures a duration, so its one part has
		// nothing smaller to ask for
		const { retry, asked } = createSut({
			failed: [
				{ label: 'the recording', message: 'too big', startSeconds: 0 },
			],
		});

		const outcome = await retry.retry();

		expect(outcome.blocked).toContain('cannot be asked for on their own');
		expect(asked).toHaveLength(0);
	});

	it.each([
		{
			case: 'no JSON output was recorded',
			outputs: [{ path: 'rec.srt', format: 'srt' }],
			files: { 'rec.srt': 'subtitles' },
		},
		{
			case: 'the recorded JSON is gone',
			outputs: [{ path: 'gone.transcript.json', format: 'json' }],
			files: {},
		},
		{
			case: 'the recorded JSON does not parse',
			outputs: [{ path: 'rec.transcript.json', format: 'json' }],
			files: { 'rec.transcript.json': '{ not json' },
		},
		{
			case: 'the recorded JSON is not a transcript',
			outputs: [{ path: 'rec.transcript.json', format: 'json' }],
			files: { 'rec.transcript.json': '{"hello":true}' },
		},
	])('says so when $case', async ({ outputs, files }) => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The refusal is the assertion.
		});
		const { retry, asked } = createSut({ outputs, files });

		expect((await retry.retry()).blocked).toContain('JSON transcript');
		expect(asked).toHaveLength(0);
		warn.mockRestore();
	});
});

describe('the runner a top-up drives the service through', () => {
	/** A service double, and the recording a top-up is asked for. */
	function runnerSut(): {
		run: jest.Mock;
		file: TFile;
		ranges: { startSeconds: number; endSeconds: number }[];
	} {
		return {
			run: jest.fn().mockResolvedValue({
				transcript: transcriptOf([]),
				missingParts: [],
			}),
			file: Object.assign(Object.create(TFile.prototype), {
				path: 'rec.webm',
			}) as TFile,
			ranges: [{ startSeconds: 30, endSeconds: 120 }],
		};
	}

	it('asks the service for exactly the stretches, on the recording', async () => {
		const { run, file, ranges } = runnerSut();

		const result = await serviceRunner({ run })(file, ranges);

		expect(run).toHaveBeenCalledWith(file, {
			// The recording's own path: a top-up reads segments and renders
			// no Markdown for those links to appear in
			notePathForLinks: 'rec.webm',
			onlyRanges: ranges,
			skipPostProcessing: true,
		});
		expect(result).toEqual({
			transcript: transcriptOf([]),
			missingParts: [],
		});
	});

	it('refuses the LLM document pass, whose answer it would discard', async () => {
		// The runner keeps the transcript and drops the Markdown, so a cleanup
		// or translation pass here is a paid call for an answer nothing reads,
		// made over a handful of recovered segments rather than the document.
		const { run, file, ranges } = runnerSut();

		await serviceRunner({ run })(file, ranges);

		expect(run.mock.calls[0]?.[1]).toMatchObject({
			skipPostProcessing: true,
		});
	});

	it('hands the sidecar through so recovered speakers keep their names', async () => {
		// Without it the engine's own labels come back and splice into a
		// transcript whose speakers the user has since renamed, leaving one
		// document that calls the same person both "Alice" and "Speaker 1".
		const { run, file, ranges } = runnerSut();
		const sidecar = {
			getTranscript: jest.fn(),
			setSpeakers: jest.fn(),
		};

		await serviceRunner({ run }, sidecar)(file, ranges);

		expect(run.mock.calls[0]?.[1]).toMatchObject({ sidecar });
	});
});
