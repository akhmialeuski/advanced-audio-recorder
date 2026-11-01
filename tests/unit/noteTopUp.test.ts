/**
 * Tests for splicing what a top-up brought back into a transcript inserted
 * into a note. The properties that matter: the recovered lines land in time
 * order, only the lines of the stretch that was asked for are replaced, and
 * everything else in the note, the user's own text above all, stays as it was.
 */

import { spliceTranscriptNote } from 'src/transcription/noteTopUp';
import {
	MISSING_PARTS_CALLOUT_HEAD,
	missingPartsWarning,
	type PartFailure,
} from 'src/transcription/partFailure';

/** Reads the `#t=` second of a `[[rec.m4a#t=N|...]]` link, as the note holds it. */
function secondsOf(line: string): number | null {
	const match = /\[\[rec\.m4a#t=(\d+)\|/.exec(line);
	return match ? Number(match[1]) : null;
}

/** A rendered transcript line at a second. */
function row(seconds: number, text: string): string {
	return `[[rec.m4a#t=${String(seconds)}|${String(seconds)}s]] **Alice** ${text}`;
}

const LOST: PartFailure = {
	label: '0:30-2:00',
	message: 'rate limited',
	startSeconds: 30,
	endSeconds: 120,
};

const WARNING = missingPartsWarning([LOST])?.callout ?? '';

/** The heading the run inserted the transcript under. */
const HEADING = '## Transcript';

/** A note holding a transcript with the stretch of {@link LOST} missing. */
const NOTE = [
	'# Meeting',
	'',
	HEADING,
	'',
	WARNING.trimEnd(),
	'',
	row(0, 'the opening'),
	'',
	row(150, 'the closing'),
	'',
].join('\n');

const GAP = { startSeconds: 30, endSeconds: 120 };

describe('spliceTranscriptNote', () => {
	it('places the recovered lines between the lines around the gap', () => {
		const spliced = spliceTranscriptNote(
			NOTE,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle'), row(90, 'more')] }],
			null,
		);

		expect(spliced).toBe(
			[
				'# Meeting',
				'',
				'## Transcript',
				'',
				row(0, 'the opening'),
				'',
				row(31, 'the middle'),
				'',
				row(90, 'more'),
				'',
				row(150, 'the closing'),
				'',
			].join('\n'),
		);
	});

	it('keeps what the user wrote below the line before the gap with that line', () => {
		const edited = NOTE.replace(
			row(0, 'the opening'),
			`${row(0, 'the opening, reworded')}\n\nMy own remark.`,
		);

		const spliced = spliceTranscriptNote(
			edited,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).toContain(
			[
				row(0, 'the opening, reworded'),
				'',
				'My own remark.',
				'',
				row(31, 'the middle'),
				'',
				row(150, 'the closing'),
			].join('\n'),
		);
	});

	it('replaces the lines a partly answered stretch kept where they stood', () => {
		const partial = NOTE.replace(
			row(150, 'the closing'),
			`${row(40, 'a fragment')}\n\n${row(150, 'the closing')}`,
		);

		const spliced = spliceTranscriptNote(
			partial,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle'), row(40, 'whole')] }],
			null,
		);

		expect(spliced).not.toContain('a fragment');
		expect(spliced).toContain(
			[
				row(31, 'the middle'),
				'',
				row(40, 'whole'),
				'',
				row(150, 'the closing'),
			].join('\n'),
		);
	});

	it('keeps a line in the second a fractional stretch starts in', () => {
		const seam = NOTE.replace(
			row(150, 'the closing'),
			`${row(29, 'the seam')}\n\n${row(150, 'the closing')}`,
		);

		const spliced = spliceTranscriptNote(
			seam,
			secondsOf,
			HEADING,
			[
				{
					range: { startSeconds: 29.6, endSeconds: 120 },
					rows: [row(31, 'the middle')],
				},
			],
			null,
		);

		expect(spliced).toContain(row(29, 'the seam'));
	});

	it('appends after the last line when the gap is the end of the recording', () => {
		const spliced = spliceTranscriptNote(
			NOTE,
			secondsOf,
			HEADING,
			[
				{
					range: { startSeconds: 160, endSeconds: 200 },
					rows: [row(161, 'the very end')],
				},
			],
			WARNING,
		);

		expect(spliced).toContain(
			[row(150, 'the closing'), '', row(161, 'the very end'), ''].join(
				'\n',
			),
		);
	});

	it('puts adjacent stretches in time order before the same next line', () => {
		const spliced = spliceTranscriptNote(
			NOTE,
			secondsOf,
			HEADING,
			[
				{
					range: { startSeconds: 75, endSeconds: 120 },
					rows: [row(80, 'second')],
				},
				{
					range: { startSeconds: 30, endSeconds: 75 },
					rows: [row(31, 'first')],
				},
			],
			null,
		);

		expect(spliced).toContain(
			[
				row(31, 'first'),
				'',
				row(80, 'second'),
				'',
				row(150, 'the closing'),
			].join('\n'),
		);
	});

	it('rewrites the callout with what is still missing', () => {
		const still: PartFailure = {
			...LOST,
			label: '1:00-2:00',
			message: 'timed out',
		};
		const callout = missingPartsWarning([still])?.callout ?? null;

		const spliced = spliceTranscriptNote(
			NOTE,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			callout,
		);

		expect(spliced).toContain('1:00-2:00: timed out');
		expect(spliced).not.toContain('rate limited');
		expect(spliced?.split(MISSING_PARTS_CALLOUT_HEAD)).toHaveLength(2);
	});

	it('removes the callout and the blank line under it once nothing is missing', () => {
		const spliced = spliceTranscriptNote(
			NOTE,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).not.toContain(MISSING_PARTS_CALLOUT_HEAD);
		expect(spliced).toContain(
			['## Transcript', '', row(0, 'the opening')].join('\n'),
		);
	});

	it('does not give a callout back to a note whose callout was deleted', () => {
		const noCallout = NOTE.replace(`${WARNING.trimEnd()}\n\n`, '');

		const spliced = spliceTranscriptNote(
			noCallout,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			WARNING,
		);

		expect(spliced).not.toContain(MISSING_PARTS_CALLOUT_HEAD);
	});

	it('leaves a warning callout that does not head this transcript alone', () => {
		const foreign = `${WARNING}My own notes.\n\n${NOTE.replace(`${WARNING.trimEnd()}\n\n`, '')}`;

		const spliced = spliceTranscriptNote(
			foreign,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced?.startsWith(WARNING)).toBe(true);
	});

	it('deletes the lines of a stretch that came back silent', () => {
		const partial = NOTE.replace(
			row(150, 'the closing'),
			`${row(40, 'noise')}\n\n${row(150, 'the closing')}`,
		);

		const spliced = spliceTranscriptNote(
			partial,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [] }],
			null,
		);

		expect(spliced).toContain(
			[row(0, 'the opening'), '', row(150, 'the closing')].join('\n'),
		);
	});

	it('refuses a note with no line of the recording', () => {
		expect(
			spliceTranscriptNote(
				'# Meeting\n\nThe LLM rewrote everything.',
				secondsOf,
				HEADING,
				[{ range: GAP, rows: [row(31, 'the middle')] }],
				null,
			),
		).toBeNull();
	});
	it('keeps text written right under a replaced line', () => {
		const partial = NOTE.replace(
			row(150, 'the closing'),
			`${row(40, 'a fragment')}\nMy note on it.\n\n${row(150, 'the closing')}`,
		);

		const spliced = spliceTranscriptNote(
			partial,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(40, 'whole')] }],
			null,
		);

		expect(spliced).toContain(
			[row(40, 'whole'), '', 'My note on it.'].join('\n'),
		);
	});
});

// A link into the recording appears outside the transcript too: in the
// user's own text through Copy timestamp link, and in the translation the
// run inserts below the transcript with the same links.
describe('spliceTranscriptNote outside the transcript section', () => {
	const remark = 'Decided at [[rec.m4a#t=40|40s]]: ship on Friday.';
	const translated = (text: string): string =>
		`${text}\n\n### de\n\n${row(0, 'die Eröffnung')}\n\n${row(40, 'ein Fragment')}\n\n${row(150, 'der Schluss')}\n`;

	it('keeps a linked remark above the heading and fills the gap below it', () => {
		const spliced = spliceTranscriptNote(
			NOTE.replace(HEADING, `${remark}\n\n${HEADING}`),
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).toContain(
			`${remark}\n\n${HEADING}\n\n${row(0, 'the opening')}`,
		);
		expect(spliced).toContain(
			[row(0, 'the opening'), '', row(31, 'the middle')].join('\n'),
		);
	});

	it('reads the section from the callout when the run wrote no heading', () => {
		const spliced = spliceTranscriptNote(
			NOTE.replace(`${HEADING}\n`, `${remark}\n`),
			secondsOf,
			'',
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).toContain(remark);
		expect(spliced).not.toContain(MISSING_PARTS_CALLOUT_HEAD);
	});

	it('appends a recovered end to the transcript rather than to the translation below it', () => {
		const spliced = spliceTranscriptNote(
			translated(NOTE.trimEnd()),
			secondsOf,
			HEADING,
			[
				{
					range: { startSeconds: 160, endSeconds: 200 },
					rows: [row(161, 'the very end')],
				},
			],
			null,
		);

		expect(spliced).toContain(
			[
				row(150, 'the closing'),
				'',
				row(161, 'the very end'),
				'',
				'### de',
			].join('\n'),
		);
	});

	it('leaves a translated line inside a retried stretch alone', () => {
		const spliced = spliceTranscriptNote(
			translated(NOTE.trimEnd()),
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).toContain(row(40, 'ein Fragment'));
		expect(spliced?.split(row(31, 'the middle'))).toHaveLength(2);
	});

	it('refuses a note whose transcript section lost every link', () => {
		expect(
			spliceTranscriptNote(
				`${remark}\n\n${HEADING}\n\nThe LLM rewrote everything.\n`,
				secondsOf,
				HEADING,
				[{ range: GAP, rows: [row(31, 'the middle')] }],
				null,
			),
		).toBeNull();
	});

	it('reads from the first linked line once the heading and the callout are gone', () => {
		const bare = NOTE.replace(`${HEADING}\n\n${WARNING.trimEnd()}\n\n`, '');

		const spliced = spliceTranscriptNote(
			bare,
			secondsOf,
			HEADING,
			[{ range: GAP, rows: [row(31, 'the middle')] }],
			null,
		);

		expect(spliced).toContain(
			[row(0, 'the opening'), '', row(31, 'the middle')].join('\n'),
		);
	});
});
