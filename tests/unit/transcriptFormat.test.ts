/**
 * Tests for transcript Markdown rendering and file serialization.
 */

import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	serializeTranscriptFile,
} from 'src/transcription/transcriptFormat';
import { buildTranscript } from 'src/transcription/transcriptModel';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';

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
		expect(md).toContain('[[[rec#t=0|0:00]]] **Alice** Hello there');
		expect(md).toContain('[[[rec#t=65|1:05]]] **Bob** Hi');
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
		expect(md).toBe('[0:05] x');
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
});
