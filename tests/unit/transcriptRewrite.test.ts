/**
 * Tests for the pure speaker-rewriting helpers: note Markdown scoped by
 * line, and subtitle/plain-text/JSON sidecar bodies.
 */

import type { SpeakerRename } from 'src/speakers/speakerRename';
import {
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

	it('returns null for non-transcript JSON', () => {
		expect(renameSpeakersInTranscriptJson('{"foo":1}', renames)).toBeNull();
	});
});
