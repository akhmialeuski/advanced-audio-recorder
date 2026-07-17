/**
 * Tests for the pure speaker-rename rewriting of existing transcript
 * outputs: note Markdown, SRT/VTT subtitles, plain text, and transcript
 * JSON.
 */

import {
	renameSpeakersInMarkdown,
	renameSpeakersInPlainText,
	renameSpeakersInSubtitles,
	renameSpeakersInTranscriptJson,
} from 'src/speakers/transcriptRewrite';

const SPEAKER_FORMAT = '**{speaker}**';

describe('renameSpeakersInMarkdown', () => {
	it('rewrites rendered speaker fragments only', () => {
		const content =
			'[[rec#t=0|0:00]] **Speaker 1** Hello Speaker 1, how are you?\n\n' +
			'[[rec#t=5|0:05]] **Speaker 2** Fine.';
		const result = renameSpeakersInMarkdown(content, SPEAKER_FORMAT, [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		// The bold fragment is renamed; the plain-text mention is not.
		expect(result).toContain('**Alex** Hello Speaker 1');
		expect(result).toContain('**Speaker 2** Fine.');
	});

	it('swaps two names simultaneously without chaining', () => {
		const content = '**Alex** hi\n\n**Kim** hello\n\n**Alex** bye';
		const result = renameSpeakersInMarkdown(content, SPEAKER_FORMAT, [
			{ from: 'Alex', to: 'Kim' },
			{ from: 'Kim', to: 'Alex' },
		]);
		expect(result).toBe('**Kim** hi\n\n**Alex** hello\n\n**Kim** bye');
	});

	it('prefers the longer name when one is a prefix of another', () => {
		const content = '**Anna Lee** hi\n\n**Anna** hello';
		const result = renameSpeakersInMarkdown(content, SPEAKER_FORMAT, [
			{ from: 'Anna', to: 'A' },
			{ from: 'Anna Lee', to: 'AL' },
		]);
		expect(result).toBe('**AL** hi\n\n**A** hello');
	});

	it('returns the content unchanged for empty or no-op renames', () => {
		const content = '**Speaker 1** hi';
		expect(renameSpeakersInMarkdown(content, SPEAKER_FORMAT, [])).toBe(
			content,
		);
		expect(
			renameSpeakersInMarkdown(content, SPEAKER_FORMAT, [
				{ from: 'Speaker 1', to: 'Speaker 1' },
			]),
		).toBe(content);
	});

	it('escapes regex metacharacters in names and formats', () => {
		const content = '[Speaker 1] (hi)';
		const result = renameSpeakersInMarkdown(content, '[{speaker}]', [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		expect(result).toBe('[Alex] (hi)');
	});
});

describe('renameSpeakersInSubtitles', () => {
	const srt =
		'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: Hello Speaker 1\n\n' +
		'2\n00:00:01,000 --> 00:00:02,000\nSpeaker 2: Hi';

	it('rewrites cue-line speaker prefixes only', () => {
		const result = renameSpeakersInSubtitles(srt, [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		expect(result).toContain('Alex: Hello Speaker 1');
		expect(result).toContain('Speaker 2: Hi');
	});

	it('handles VTT bodies the same way', () => {
		const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSpeaker 1: Hello';
		expect(
			renameSpeakersInSubtitles(vtt, [{ from: 'Speaker 1', to: 'Alex' }]),
		).toContain('Alex: Hello');
	});

	it('swaps two names simultaneously', () => {
		const content = 'Alex: hi\nKim: hello';
		expect(
			renameSpeakersInSubtitles(content, [
				{ from: 'Alex', to: 'Kim' },
				{ from: 'Kim', to: 'Alex' },
			]),
		).toBe('Kim: hi\nAlex: hello');
	});
});

describe('renameSpeakersInPlainText', () => {
	it('rewrites the speaker after the leading timecode only', () => {
		const content =
			'[0:00] Speaker 1: Hello Speaker 1\n[0:05] Speaker 2: Hi';
		const result = renameSpeakersInPlainText(content, [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		expect(result).toBe(
			'[0:00] Alex: Hello Speaker 1\n[0:05] Speaker 2: Hi',
		);
	});

	it('leaves lines without a timecode alone', () => {
		const content = 'Speaker 1: freeform line';
		expect(
			renameSpeakersInPlainText(content, [
				{ from: 'Speaker 1', to: 'Alex' },
			]),
		).toBe(content);
	});
});

describe('renameSpeakersInTranscriptJson', () => {
	const transcript = {
		language: 'en',
		segments: [
			{ start: 0, end: 1, text: 'hi', speaker: 'Speaker 1' },
			{ start: 1, end: 2, text: 'hello', speaker: 'Speaker 2' },
		],
		speakers: ['Speaker 1', 'Speaker 2'],
	};

	it('renames segment speakers and re-derives the speaker list', () => {
		const result = renameSpeakersInTranscriptJson(
			JSON.stringify(transcript, null, 2),
			[{ from: 'Speaker 1', to: 'Alex' }],
		);
		expect(result).not.toBeNull();
		const parsed = JSON.parse(result ?? '') as typeof transcript;
		expect(parsed.segments.map((s) => s.speaker)).toEqual([
			'Alex',
			'Speaker 2',
		]);
		expect(parsed.speakers).toEqual(['Alex', 'Speaker 2']);
		expect(parsed.language).toBe('en');
	});

	it('merges the roster when two labels are renamed to one name', () => {
		const result = renameSpeakersInTranscriptJson(
			JSON.stringify(transcript),
			[
				{ from: 'Speaker 1', to: 'Alex' },
				{ from: 'Speaker 2', to: 'Alex' },
			],
		);
		const parsed = JSON.parse(result ?? '') as typeof transcript;
		expect(parsed.speakers).toEqual(['Alex']);
	});

	it('returns null for invalid JSON or a non-transcript document', () => {
		const renames = [{ from: 'Speaker 1', to: 'Alex' }];
		expect(renameSpeakersInTranscriptJson('not json', renames)).toBeNull();
		expect(renameSpeakersInTranscriptJson('{"a": 1}', renames)).toBeNull();
	});

	it('tolerates malformed segment entries', () => {
		const raw = JSON.stringify({
			segments: [null, 'text', { start: 0, speaker: 'Speaker 1' }],
		});
		const result = renameSpeakersInTranscriptJson(raw, [
			{ from: 'Speaker 1', to: 'Alex' },
		]);
		const parsed = JSON.parse(result ?? '') as {
			segments: unknown[];
		};
		expect(parsed.segments[2]).toEqual({ start: 0, speaker: 'Alex' });
	});

	it('returns the raw content unchanged for no-op renames', () => {
		const raw = JSON.stringify(transcript);
		expect(renameSpeakersInTranscriptJson(raw, [])).toBe(raw);
	});
});
