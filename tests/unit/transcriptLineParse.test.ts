/**
 * Tests for reading a rendered transcript line back into its parts, and for
 * undoing the wikilink escaping the renderer adds. Every line under test is
 * produced by the renderer itself, so the parser is held to exactly what the
 * plugin writes.
 */

import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	parseTranscriptLine,
	restoreWikilinks,
	type TranscriptMarkdownOptions,
} from 'src/transcription/transcriptFormat';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';

const wikiLink = (seconds: number, label: string): string =>
	`[[rec.m4a#t=${String(Math.floor(seconds))}|${label}]]`;

const markdownLink = (seconds: number, label: string): string =>
	`[${label}](rec%20one.m4a#t=${String(Math.floor(seconds))})`;

/** Renders one segment into a single line with the given options. */
function renderLine(
	segment: TranscriptSegment,
	overrides: Partial<TranscriptMarkdownOptions> = {},
	link = wikiLink,
): string {
	return formatTranscriptMarkdown(
		{ segments: [segment], speakers: [] },
		{ ...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS, ...overrides },
		link,
	);
}

/** The spoken text a parse points at. */
function textOf(
	line: string,
	overrides: Partial<TranscriptMarkdownOptions> = {},
	speakers: string[] = [],
): string | null {
	const parsed = parseTranscriptLine(
		line,
		{ ...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS, ...overrides },
		speakers,
	);
	return parsed ? line.slice(parsed.textStart, parsed.textEnd) : null;
}

describe('parseTranscriptLine', () => {
	it('reads the speaker of a line in the default layout', () => {
		const line = renderLine({
			start: 12,
			end: 15,
			text: 'Hello there',
			speaker: 'Speaker 1',
		});

		const parsed = parseTranscriptLine(
			line,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			[],
		);

		expect(parsed?.speaker).toBe('Speaker 1');
	});

	it('points at the spoken text of a line in the default layout', () => {
		const line = renderLine({
			start: 12,
			end: 15,
			text: 'Hello there',
			speaker: 'Speaker 1',
		});

		expect(textOf(line)).toBe('Hello there');
	});

	it('reads a Markdown timecode link', () => {
		const line = renderLine(
			{ start: 75, end: 80, text: 'Fine, thanks', speaker: 'Anna' },
			{},
			markdownLink,
		);

		expect(textOf(line)).toBe('Fine, thanks');
	});

	it('reads a plain timecode label', () => {
		const line = renderLine(
			{ start: 3725, end: 3730, text: 'Late remark', speaker: 'Anna' },
			{ timestampLinks: false },
		);

		expect(textOf(line, { timestampLinks: false })).toBe('Late remark');
	});

	it('reads a line whose timestamp template wraps the time', () => {
		const options = { timestampFormat: '({time})' };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Wrapped', speaker: 'Anna' },
			options,
		);

		expect(textOf(line, options)).toBe('Wrapped');
	});

	it('reads a line that shows no speaker', () => {
		const line = renderLine({ start: 5, end: 6, text: 'No label here' });

		const parsed = parseTranscriptLine(
			line,
			DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			[],
		);

		expect(parsed?.speaker).toBeUndefined();
	});

	it('keeps the whole text of a line that shows no speaker', () => {
		const line = renderLine({ start: 5, end: 6, text: 'No label here' });

		expect(textOf(line)).toBe('No label here');
	});

	it('recognizes a bare speaker template by the names it is given', () => {
		const options = { speakerFormat: '{speaker}' };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Good morning', speaker: 'Anna Lee' },
			options,
		);

		expect(textOf(line, options, ['Anna', 'Anna Lee'])).toBe(
			'Good morning',
		);
	});

	it('reads a speaker template with a trailing delimiter', () => {
		const options = { speakerFormat: '{speaker}:' };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Agreed', speaker: 'Bob' },
			options,
		);

		const parsed = parseTranscriptLine(
			line,
			{ ...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS, ...options },
			[],
		);

		expect(parsed?.speaker).toBe('Bob');
	});

	it('reads a layout that puts the text before the speaker', () => {
		const options = { lineFormat: '{text} ({speaker}, {timestamp})' };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Text first', speaker: 'Bob' },
			options,
		);

		expect(textOf(line, options)).toBe('Text first');
	});

	it('reads a line written without timestamps', () => {
		const options = { includeTimestamps: false };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Untimed', speaker: 'Bob' },
			options,
		);

		expect(textOf(line, options)).toBe('Untimed');
	});

	it('reads the whole line as text when speakers were left out', () => {
		const options = { includeSpeakers: false };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Unlabelled', speaker: 'Bob' },
			options,
		);

		expect(textOf(line, options)).toBe('Unlabelled');
	});

	it('reads a layout with a token the renderer does not know', () => {
		const options = { lineFormat: '{timestamp} {mood} {text}' };
		const line = renderLine(
			{ start: 5, end: 6, text: 'Plain', speaker: 'Bob' },
			options,
		);

		expect(textOf(line, options)).toBe('Plain');
	});

	it('rejects a line that does not start with its timestamp', () => {
		expect(
			parseTranscriptLine(
				'See [[rec.m4a#t=5|0:05]] for the start',
				DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
				[],
			),
		).toBeNull();
	});

	it('rejects a line that has only a timestamp and a speaker', () => {
		expect(
			parseTranscriptLine(
				'[[rec.m4a#t=5|0:05]] **Bob**',
				DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
				['Bob'],
			),
		).toBeNull();
	});
});

describe('restoreWikilinks', () => {
	it('takes back the escaping the renderer adds to transcript text', () => {
		const text = 'See [[Project]] notes';
		const line = renderLine({ start: 0, end: 1, text, speaker: 'Anna' });

		expect(restoreWikilinks(textOf(line) ?? '')).toBe(text);
	});
});
