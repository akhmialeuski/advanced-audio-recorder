/**
 * Tests for the pure speaker-rewriting helpers: note Markdown scoped by
 * line, subtitle/plain-text/JSON sidecar bodies, and the read-back that says
 * whether a note still shows a rendered speaker at all.
 */

import type { SpeakerRename } from 'src/speakers/speakerRename';
import {
	noteShowsAnySpeaker,
	renameSpeakersInMarkdown,
	renameSpeakersInNoteLines,
	renameSpeakersInPlainText,
	renameSpeakersInSubtitles,
	renameSpeakersInTranscriptJson,
} from 'src/speakers/transcriptRewrite';

const FORMAT = '**{speaker}**';

const NOTE = [
	'![[rec.wav]]', // 0
	'', // 1
	'[00:00](rec.wav#t=0) **Speaker 1** hello', // 2
	'', // 3
	'[00:05](rec.wav#t=5) **Speaker 2** hi there', // 4
	'', // 5
	'[00:00](other.wav#t=0) **Speaker 1** different meeting', // 6
].join('\n');

describe('renameSpeakersInNoteLines', () => {
	const renames: SpeakerRename[] = [
		{ from: 'Speaker 1', to: 'Alex' },
		{ from: 'Speaker 2', to: 'Bob' },
	];

	it('rewrites only the marked audio lines, leaving other transcripts alone', () => {
		const out = renameSpeakersInNoteLines(
			NOTE,
			FORMAT,
			renames,
			new Set([2, 4]),
		);
		const lines = out.split('\n');
		expect(lines[2]).toContain('**Alex** hello');
		expect(lines[4]).toContain('**Bob** hi there');
		// The other recording's identical label is untouched.
		expect(lines[6]).toContain('**Speaker 1** different meeting');
	});

	it('swaps two names on a scoped line without chaining', () => {
		const content = '[00:00](rec.wav#t=0) **Alex** then **Bob**';
		const out = renameSpeakersInNoteLines(
			content,
			FORMAT,
			[
				{ from: 'Alex', to: 'Bob' },
				{ from: 'Bob', to: 'Alex' },
			],
			new Set([0]),
		);
		expect(out).toBe('[00:00](rec.wav#t=0) **Bob** then **Alex**');
	});

	it('is a no-op when no audio lines are given', () => {
		expect(
			renameSpeakersInNoteLines(NOTE, FORMAT, renames, new Set()),
		).toBe(NOTE);
	});
});

describe('renameSpeakersInMarkdown (broad)', () => {
	it('rewrites every matching fragment in the content', () => {
		const out = renameSpeakersInMarkdown(NOTE, FORMAT, [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		const lines = out.split('\n');
		expect(lines[2]).toContain('**Alex** hello');
		// Broad mode also rewrites the other transcript's identical label.
		expect(lines[6]).toContain('**Alex** different meeting');
	});
});

describe('sidecar rewriters', () => {
	const renames: SpeakerRename[] = [{ from: 'Speaker 1', to: 'Alex' }];

	it('rewrites SRT/VTT cue prefixes only at line start', () => {
		const srt = '1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: hi Speaker 1';
		expect(renameSpeakersInSubtitles(srt, renames)).toBe(
			'1\n00:00:00,000 --> 00:00:01,000\nAlex: hi Speaker 1',
		);
	});

	it('rewrites plain-text prefixes after the timecode', () => {
		const txt = '[0:00] Speaker 1: hello Speaker 1';
		expect(renameSpeakersInPlainText(txt, renames)).toBe(
			'[0:00] Alex: hello Speaker 1',
		);
	});

	it('rewrites transcript JSON structurally and re-derives speakers', () => {
		const json = JSON.stringify({
			segments: [{ start: 0, end: 1, text: 'hi', speaker: 'Speaker 1' }],
			speakers: ['Speaker 1'],
		});
		const out = renameSpeakersInTranscriptJson(json, renames);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out ?? '{}');
		expect(parsed.segments[0].speaker).toBe('Alex');
		expect(parsed.speakers).toEqual(['Alex']);
	});

	it.each([
		{ name: 'is not JSON at all', raw: 'not json' },
		{ name: 'is not an object', raw: '"a string"' },
		{ name: 'has no segments list', raw: '{"foo":1}' },
		{ name: 'has segments that are not a list', raw: '{"segments":"one"}' },
	])('returns null for a sidecar that $name', ({ raw }) => {
		// A hand-edited or truncated sidecar must leave the rewrite as a
		// no-op rather than replacing the file with something invalid.
		expect(renameSpeakersInTranscriptJson(raw, renames)).toBeNull();
	});

	it('passes a segment that is not an object through untouched', () => {
		const json = JSON.stringify({
			segments: ['stray', null],
			speakers: [],
		});

		const out = renameSpeakersInTranscriptJson(json, renames);

		expect(JSON.parse(out ?? '{}').segments).toEqual(['stray', null]);
	});

	it('leaves a speaker the rename does not name alone', () => {
		const json = JSON.stringify({
			segments: [
				{ text: 'hi', speaker: 'Speaker 1' },
				{ text: 'yes', speaker: 'Speaker 2' },
				{ text: 'no speaker at all' },
				{ text: 'odd', speaker: 7 },
			],
			speakers: ['Speaker 1', 'Speaker 2'],
		});

		const parsed = JSON.parse(
			renameSpeakersInTranscriptJson(json, renames) ?? '{}',
		);

		expect(parsed.speakers).toEqual(['Alex', 'Speaker 2']);
		expect(parsed.segments[3].speaker).toBe(7);
	});

	it.each([
		{
			name: 'markdown',
			rewrite: (text: string): string =>
				renameSpeakersInMarkdown(text, FORMAT, []),
		},
		{
			name: 'subtitles',
			rewrite: (text: string): string =>
				renameSpeakersInSubtitles(text, []),
		},
		{
			name: 'plain text',
			rewrite: (text: string): string =>
				renameSpeakersInPlainText(text, []),
		},
	])(
		'leaves $name untouched when nothing is being renamed',
		({ rewrite }) => {
			// An apply with no changes still runs the rewrite over every
			// output; building a regex from an empty alternation would match
			// everything.
			const content = 'Speaker 1: hello';

			expect(rewrite(content)).toBe(content);
		},
	);

	it.each([
		{
			name: 'names nothing to rename from',
			rename: { from: '', to: 'Alex' },
		},
		{
			name: 'renames a speaker to itself',
			rename: { from: 'Speaker 1', to: 'Speaker 1' },
		},
	])('drops a rename that $name', ({ rename }) => {
		// An apply carries one entry per speaker, most of them unchanged;
		// rewriting on those would touch files for no reason.
		const content = 'Speaker 1: hello';

		expect(renameSpeakersInSubtitles(content, [rename])).toBe(content);
	});

	it('keeps a sidecar that carries no speaker list without one', () => {
		// The list is derived from the segments, so writing one into a
		// sidecar that never had it would change the file's shape.
		const json = JSON.stringify({
			segments: [{ text: 'hi', speaker: 'Speaker 1' }],
		});

		const parsed = JSON.parse(
			renameSpeakersInTranscriptJson(json, renames) ?? '{}',
		);

		expect(parsed.speakers).toBeUndefined();
		expect(parsed.segments[0].speaker).toBe('Alex');
	});

	it('leaves transcript JSON untouched when nothing is being renamed', () => {
		const json = JSON.stringify({
			segments: [{ text: 'hi', speaker: 'Speaker 1' }],
			speakers: ['Speaker 1'],
		});

		expect(renameSpeakersInTranscriptJson(json, [])).toBe(json);
	});
});

describe('noteShowsAnySpeaker', () => {
	it('finds a rendered speaker on a scoped line', () => {
		expect(
			noteShowsAnySpeaker(NOTE, FORMAT, ['Speaker 1'], new Set([2])),
		).toBe(true);
	});

	it('ignores a rendered speaker outside the scope', () => {
		// Line 6 belongs to another recording. Letting it answer for this one
		// would vouch for a transcript the rename can no longer reach.
		expect(
			noteShowsAnySpeaker(NOTE, FORMAT, ['Speaker 1'], new Set([2])),
		).toBe(true);
		expect(
			noteShowsAnySpeaker(NOTE, FORMAT, ['Speaker 2'], new Set([6])),
		).toBe(false);
	});

	it('searches the whole note without a scope', () => {
		expect(noteShowsAnySpeaker(NOTE, FORMAT, ['Speaker 2'], null)).toBe(
			true,
		);
	});

	it('is false when the name appears only as prose', () => {
		// The bare name is not a rendered fragment, which is exactly the shape
		// a restructuring pass leaves behind.
		const note = '[00:00](rec.wav#t=0) Alex opened the meeting.';
		expect(noteShowsAnySpeaker(note, FORMAT, ['Alex'], new Set([0]))).toBe(
			false,
		);
	});

	it('is false for an empty or blank speaker list', () => {
		// A blank name renders to a bare template ("****") that would match
		// arbitrary emphasis, so it must never be searched for.
		expect(noteShowsAnySpeaker('**** hi', FORMAT, [''], null)).toBe(false);
		expect(noteShowsAnySpeaker(NOTE, FORMAT, [], null)).toBe(false);
	});

	it('matches the longer name when one is a prefix of another', () => {
		const note = '[00:00](rec.wav#t=0) **Anna Lee** hello';
		expect(noteShowsAnySpeaker(note, FORMAT, ['Anna'], new Set([0]))).toBe(
			false,
		);
		expect(
			noteShowsAnySpeaker(note, FORMAT, ['Anna Lee'], new Set([0])),
		).toBe(true);
	});

	it('answers per line rather than sticking at the first match', () => {
		// A global regex would carry lastIndex from one line to the next and
		// silently miss the second.
		const note = ['**Speaker 1** a', '**Speaker 1** b'].join('\n');
		expect(
			noteShowsAnySpeaker(note, FORMAT, ['Speaker 1'], new Set([1])),
		).toBe(true);
	});
});
