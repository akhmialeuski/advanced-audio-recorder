/**
 * Tests for transcript Markdown rendering and file serialization.
 */

import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptByChapters,
	formatTranscriptMarkdown,
	serializeTranscriptFile,
} from 'src/transcription/transcriptFormat';
import { buildTranscript } from 'src/transcription/transcriptModel';
import type {
	TranscriptFileFormat,
	TranscriptSegment,
} from 'src/transcription/TranscriptTypes';

function seg(
	start: number,
	end: number,
	text: string,
	speaker?: string,
): TranscriptSegment {
	return { start, end, text, ...(speaker ? { speaker } : {}) };
}

const stubLink = (seconds: number, label: string): string =>
	`[[rec#t=${String(Math.floor(seconds))}|${label}]]`;

describe('formatTranscriptMarkdown', () => {
	it('renders timestamp links, speakers, and text', () => {
		const transcript = buildTranscript([
			seg(0, 2, 'Hello there', 'Alice'),
			seg(65, 70, 'Hi', 'Bob'),
		]);
		const md = formatTranscriptMarkdown(
			transcript,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			stubLink,
		);
		// The default timestamp format is bare `{time}`, so a wikilink is not
		// wrapped in extra brackets (which would nest as `[[[...]]]`).
		expect(md).toContain('[[rec#t=0|0:00]] **Alice** Hello there');
		expect(md).toContain('[[rec#t=65|1:05]] **Bob** Hi');
	});

	it('merges consecutive same-speaker segments', () => {
		const transcript = buildTranscript([
			seg(0, 1, 'one', 'Alice'),
			seg(1, 2, 'two', 'Alice'),
		]);
		const md = formatTranscriptMarkdown(
			transcript,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			stubLink,
		);
		expect(md.split('\n\n')).toHaveLength(1);
		expect(md).toContain('one two');
	});

	it('does not merge segments without speakers (keeps timestamps)', () => {
		const transcript = buildTranscript([
			seg(0, 1, 'one'),
			seg(1, 2, 'two'),
		]);
		const md = formatTranscriptMarkdown(
			transcript,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			stubLink,
		);
		// Two separate lines, each with its own timecode link
		expect(md.split('\n\n')).toHaveLength(2);
		expect(md).toContain('[[rec#t=0|0:00]] one');
		expect(md).toContain('[[rec#t=1|0:01]] two');
	});

	it('omits timestamps and speakers when disabled', () => {
		const transcript = buildTranscript([seg(3, 4, 'text', 'Alice')]);
		const md = formatTranscriptMarkdown(
			transcript,
			{
				...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
				includeTimestamps: false,
				includeSpeakers: false,
			},
			stubLink,
		);
		expect(md).toBe('text');
	});

	it('renders plain timecodes when links are disabled', () => {
		const transcript = buildTranscript([seg(5, 6, 'x')]);
		const md = formatTranscriptMarkdown(
			transcript,
			{ ...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS, timestampLinks: false },
			stubLink,
		);
		expect(md).toBe('0:05 x');
	});

	it('honors a custom bracketed timestamp format', () => {
		const transcript = buildTranscript([seg(5, 6, 'x')]);
		const md = formatTranscriptMarkdown(
			transcript,
			{
				...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
				timestampLinks: false,
				timestampFormat: '[{time}]',
			},
			stubLink,
		);
		expect(md).toBe('[0:05] x');
	});

	it('neutralizes wikilink/transclusion syntax in transcript text and speakers', () => {
		const transcript = buildTranscript([
			seg(0, 1, 'see ![[secret-note]] and [[other]]', '[[host]]'),
		]);
		const md = formatTranscriptMarkdown(
			transcript,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			stubLink,
		);
		// No raw embed/wikilink survives from the content
		expect(md).not.toContain('![[');
		expect(md).not.toContain('[[secret-note]]');
		expect(md).not.toContain('[[other]]');
		expect(md).not.toContain('[[host]]');
		// The brackets are present but escaped
		expect(md).toContain('\\[\\[secret-note\\]\\]');
	});
});

describe('formatTranscriptByChapters', () => {
	const transcript = buildTranscript([
		seg(0, 5, 'Before the agenda', 'Alice'),
		seg(10, 20, 'The deck is late', 'Bob'),
		seg(30, 40, 'Budget is fine', 'Alice'),
	]);
	const options = {
		...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
		timestampLinks: false,
	};

	it('writes each chapter as a heading over its own lines', () => {
		expect(
			formatTranscriptByChapters(
				transcript,
				options,
				stubLink,
				[
					{ start: 30, title: 'Budget' },
					{ start: 10, title: 'Deck' },
				],
				3,
			),
		).toBe(
			[
				'0:00 **Alice** Before the agenda',
				'### Deck',
				'0:10 **Bob** The deck is late',
				'### Budget',
				'0:30 **Alice** Budget is fine',
			].join('\n\n'),
		);
	});

	// A transcription run has no chapters yet, so chapters= writes the
	// transcript in one piece there.
	it('writes the transcript in one piece without chapters', () => {
		expect(
			formatTranscriptByChapters(transcript, options, stubLink, [], 3),
		).toBe(formatTranscriptMarkdown(transcript, options, stubLink));
	});

	it('leaves out a chapter no line falls in, and shows a link a title holds as text', () => {
		expect(
			formatTranscriptByChapters(
				transcript,
				options,
				stubLink,
				[
					{ start: 10, title: '[[Deck]] review' },
					{ start: 12, title: 'Empty' },
					{ start: 30, title: 'Budget' },
				],
				2,
			),
		).not.toContain('Empty');
		expect(
			formatTranscriptByChapters(
				transcript,
				options,
				stubLink,
				[{ start: 10, title: '[[Deck]] review' }],
				2,
			),
		).toContain('## \\[\\[Deck\\]\\] review');
	});
});

describe('serializeTranscriptFile', () => {
	const transcript = buildTranscript([
		seg(0, 1.5, 'Hello', 'Alice'),
		seg(1.5, 3, 'World'),
	]);

	it('serializes SRT with comma millis and indices', () => {
		const srt = serializeTranscriptFile(transcript, 'srt');
		expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nAlice: Hello');
		expect(srt).toContain('2\n00:00:01,500 --> 00:00:03,000\nWorld');
	});

	it('serializes VTT with a header and dot millis', () => {
		const vtt = serializeTranscriptFile(transcript, 'vtt');
		expect(vtt.startsWith('WEBVTT')).toBe(true);
		expect(vtt).toContain('00:00:00.000 --> 00:00:01.500');
	});

	it('serializes plain text with timecodes', () => {
		const txt = serializeTranscriptFile(transcript, 'txt');
		expect(txt).toContain('[0:00] Alice: Hello');
		expect(txt).toContain('[0:01] World');
	});

	it('serializes JSON round-trippable to the transcript', () => {
		const json = serializeTranscriptFile(transcript, 'json');
		expect(JSON.parse(json)).toEqual(transcript);
	});

	it('carries milliseconds into seconds instead of overflowing to 1000', () => {
		// 12.9996s rounds to 13.000s, not "12,1000"
		const edge = buildTranscript([seg(0, 12.9996, 'x')]);
		const srt = serializeTranscriptFile(edge, 'srt');
		expect(srt).toContain('00:00:00,000 --> 00:00:13,000');
		expect(srt).not.toContain(',1000');
	});

	it('throws on an unsupported file format instead of writing undefined', () => {
		expect(() =>
			serializeTranscriptFile(
				transcript,
				'bogus' as unknown as TranscriptFileFormat,
			),
		).toThrow('Unsupported transcript file format');
	});
});
