/**
 * Unit tests for how a note template writes the transcript: the settings of
 * `{{transcript}}`, and the turns `{{#each turns}}` repeats.
 * @module tests/unit/transcriptPart.test
 */

import { noteTemplateEngine } from 'src/templates/noteTemplate';
import {
	TRANSCRIPT_HELPER,
	transcriptHelper,
	transcriptOverrides,
} from 'src/templates/transcriptPart';
import { noteRendering } from 'src/transcription/templatePass';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	transcriptTurns,
} from 'src/transcription/transcriptFormat';

/** Two turns of one speaker and one of another. */
const TRANSCRIPT: Parameters<typeof noteRendering>[0] = {
	segments: [
		{ start: 0, end: 5, text: 'Hello.', speaker: 'Ann' },
		{ start: 5, end: 9, text: 'Again.', speaker: 'Ann' },
		{ start: 65, end: 70, text: 'See [[x]].', speaker: '[[Ben]]' },
	],
	speakers: ['Ann', '[[Ben]]'],
};

/** A link to a moment, as the tests read it. */
const link = (seconds: number, label: string): string =>
	`[${label}](#${String(seconds)})`;

/**
 * What a template writes with the run's transcript.
 * @param source - The template
 * @param render - Writes the transcript lines
 */
function written(
	source: string,
	render = (overrides: object): string => JSON.stringify(overrides),
): string {
	return noteTemplateEngine().render(source, { transcript: 'T' }, undefined, {
		[TRANSCRIPT_HELPER]: transcriptHelper(render),
	});
}

describe('{{transcript}}', () => {
	it('passes what the template changes about the lines', () => {
		expect(written('{{transcript}}')).toBe('{}');
		expect(written('{{transcript timestamps=false speakers=true}}')).toBe(
			'{"timestamps":false,"speakers":true}',
		);
		expect(transcriptOverrides({ timestamps: 'no' })).toEqual({
			timestamps: undefined,
			speakers: undefined,
		});
	});

	it.each([
		['{{transcript callout=true}}', '> [!note]\n> A\n>\n> B'],
		['{{transcript callout=false}}', 'A\n\nB'],
		[
			'{{transcript callout="Quote" title="Said" folded=false}}',
			'> [!quote]+ Said\n> A\n>\n> B',
		],
	])('writes %s', (source, expected) => {
		expect(written(source, () => 'A\n\nB')).toBe(expected);
	});

	it('writes the transcript it was given outside a run', () => {
		expect(
			noteTemplateEngine().render('{{transcript callout="quote"}}', {
				transcript: 'Lines',
			}),
		).toBe('> [!quote]\n> Lines');
		expect(noteTemplateEngine().render('[{{transcript}}]', {})).toBe('[]');
	});
});

describe('the run transcript in a template', () => {
	const rendering = noteRendering(
		TRANSCRIPT,
		{ ...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS, timestampLinks: true },
		link,
	);

	it('writes the lines with the template overrides over the settings', () => {
		expect(rendering.renderTranscript({})).toBe(
			'[0:00](#0) **Ann** Hello. Again.\n\n[1:05](#65) **\\[\\[Ben\\]\\]** See \\[\\[x\\]\\].',
		);
		expect(
			rendering.renderTranscript({ timestamps: false, speakers: false }),
		).toBe('Hello. Again.\n\nSee \\[\\[x\\]\\].');
		expect(rendering.links(65)).toBe('[1:05](#65)');
	});

	it('gives the turns with who spoke, when, and a link there', () => {
		expect(rendering.turns).toEqual([
			{
				speaker: 'Ann',
				start: 0,
				time: '0:00',
				link: '[0:00](#0)',
				text: 'Hello. Again.',
			},
			{
				speaker: '\\[\\[Ben\\]\\]',
				start: 65,
				time: '1:05',
				link: '[1:05](#65)',
				text: 'See \\[\\[x\\]\\].',
			},
		]);
		expect(transcriptTurns(TRANSCRIPT, false, link)).toHaveLength(3);
	});
});
