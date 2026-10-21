/**
 * Tests that splitting or merging transcript lines keeps the language of each
 * segment in the JSON output. The edit runs through the real row timing, the
 * real piece builders and the real file rewrite over an in-memory vault, and
 * the JSON is read back the way the next edit reads it.
 * @module tests/integration/transcriptEditLanguage.test
 */

import { applyTranscriptEdit } from 'src/speakers/applyTranscriptEdit';
import { rowTiming, type RowSpan } from 'src/speakers/transcriptRows';
import { buildSplitPieces } from 'src/speakers/transcriptSplit';
import { buildMergedSegment } from 'src/speakers/transcriptMerge';
import {
	readRecordedTranscript,
	type RecordedTranscript,
} from 'src/transcription/recordedTranscript';
import { serializeTranscriptFile } from 'src/transcription/transcriptFormat';
import { buildTranscript } from 'src/transcription/transcriptModel';
import {
	TranscriptFileFormat,
	type TranscriptSegment,
} from 'src/transcription/TranscriptTypes';
import type { TranscriptSection } from 'src/sidecar/recordingSidecarModel';
import { partial } from '../helpers/doubles';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';

const JSON_PATH = 'lesson.json';

const OUTPUTS = [
	{
		path: JSON_PATH,
		format: TranscriptFileFormat.Json,
		writtenAt: '2026-10-21T00:00:00.000Z',
	},
];

/** A lesson that opens in Ukrainian and goes on in Polish. */
const LESSON = buildTranscript([
	{ start: 0, end: 4, text: 'Добрий день, як справи?', language: 'uk' },
	{ start: 4, end: 6, text: 'Все добре.', language: 'uk' },
	{
		start: 6,
		end: 12,
		text: 'Mieszkam i pracuję w Warszawie.',
		language: 'pl',
	},
]);

/**
 * One speaker's turn that switches from Polish to Ukrainian mid-line, then a
 * Belarusian aside the engine tagged as none of the expected languages.
 */
const SWITCHING_TURN = buildTranscript([
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
	{ start: 40, end: 42, text: 'Я крыху разумею.', language: 'other' },
	{ start: 42, end: 44, text: 'Але не ўсё.', language: 'other' },
]);

/**
 * Writes a transcript's JSON output into an in-memory vault, edits the lines
 * at `span` into `pieces`, and reads the JSON back.
 * @param edit - Builds the pieces from the recorded transcript
 * @param transcript - The transcript the JSON output holds
 * @returns The language of every segment in the rewritten JSON
 */
async function editAndReadBack(
	edit: (recorded: RecordedTranscript) => {
		span: RowSpan;
		pieces: TranscriptSegment[];
	},
	transcript = LESSON,
): Promise<(string | undefined)[] | undefined> {
	const files = fakeVaultFiles([
		[
			JSON_PATH,
			serializeTranscriptFile(transcript, TranscriptFileFormat.Json),
		],
	]);
	const { app } = createMockApp({ vault: files.vault });
	const recorded = await readRecordedTranscript(app, OUTPUTS);
	if (!recorded) {
		throw new Error('the seeded JSON output was not read');
	}
	const { span, pieces } = edit(recorded);
	await applyTranscriptEdit(
		app,
		{ addSpeakers: jest.fn() },
		{
			audioPath: 'lesson.m4a',
			section: partial<TranscriptSection>({ fileOutputs: OUTPUTS }),
			recorded,
			span,
			pieces,
			added: [],
		},
	);
	const reread = await readRecordedTranscript(app, OUTPUTS);
	return reread?.transcript.segments.map((segment) => segment.language);
}

describe('a transcript edit on a recording whose segments name their language', () => {
	it('keeps the language on every piece of a split line', async () => {
		const languages = await editAndReadBack(({ transcript }) => {
			const span = { first: 2, last: 2 };
			return {
				span,
				pieces: buildSplitPieces(
					rowTiming(transcript, span),
					{
						before: 'Mieszkam i pracuję',
						selected: 'w Warszawie.',
						after: '',
					},
					{ start: 9, end: 12 },
					{ row: undefined, selected: 'Speaker 2', after: undefined },
				),
			};
		});

		expect(languages).toEqual(['uk', 'uk', 'pl', 'pl']);
	});

	it('keeps the language of the lines merged into one', async () => {
		const languages = await editAndReadBack(({ transcript }) => {
			const span = { first: 0, last: 1 };
			return {
				span,
				pieces: [
					buildMergedSegment(
						rowTiming(transcript, span),
						['Добрий день, як справи?', 'Все добре.'],
						undefined,
					),
				],
			};
		});

		expect(languages).toEqual(['uk', 'pl']);
	});

	it('gives each piece of a line that switches language the language spoken there', async () => {
		// The Ukrainian half handed to another speaker stays Ukrainian, though
		// most of the line is Polish.
		const languages = await editAndReadBack(({ transcript }) => {
			const span = { first: 0, last: 1 };
			return {
				span,
				pieces: buildSplitPieces(
					rowTiming(transcript, span),
					{
						before: 'Możemy od razu po polsku, czy chciałby pan na początku',
						selected: 'по-українськи щось мені повідомити?',
						after: '',
					},
					{ start: 35, end: 37 },
					{ row: undefined, selected: 'Speaker 1', after: undefined },
				),
			};
		}, SWITCHING_TURN);

		expect(languages).toEqual(['pl', 'uk', 'other', 'other']);
	});

	it('keeps a line spoken outside the expected languages tagged as such when merged', async () => {
		// Without the tag the merged aside would read as the transcript's
		// own language, a code it is not in.
		const languages = await editAndReadBack(({ transcript }) => {
			const span = { first: 2, last: 3 };
			return {
				span,
				pieces: [
					buildMergedSegment(
						rowTiming(transcript, span),
						['Я крыху разумею.', 'Але не ўсё.'],
						undefined,
					),
				],
			};
		}, SWITCHING_TURN);

		expect(languages).toEqual(['pl', 'uk', 'other']);
	});
});
