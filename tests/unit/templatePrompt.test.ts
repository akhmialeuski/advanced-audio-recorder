/**
 * Unit tests for the prompt the parts of a note template are asked for with.
 * @module tests/unit/templatePrompt.test
 */

import type { PartSpec } from 'src/templates/noteTemplate';
import type { RunFacts } from 'src/templates/runVariables';
import {
	buildTemplatePrompt,
	readTemplateAnswer,
	transcriptForModel,
} from 'src/transcription/templatePrompt';

const facts: RunFacts = {
	title: 'Weekly sync',
	notePath: '',
	recordingName: 'a.webm',
	recordingPath: 'a.webm',
	recordingLink: '[[a.webm]]',
	recordedAt: Date.UTC(2026, 8, 22, 10),
	durationSeconds: 125,
	language: 'de',
	participants: ['Anna', 'Ben'],
	speakers: [],
	dictionary: [],
	tags: [],
	properties: {},
};

/**
 * A part with the settings every part has and the ones given.
 * @param overrides - The settings that differ
 */
function spec(overrides: Partial<PartSpec>): PartSpec {
	return {
		name: 'summary',
		instruction: '',
		format: 'prose',
		empty: 'remove',
		separate: false,
		asksModel: true,
		options: {},
		...overrides,
	};
}

const transcript = {
	speakers: ['Anna'],
	segments: [
		{ start: 0, end: 4, text: ' Hello. ', speaker: 'Anna' },
		{ start: 65, end: 70, text: 'Bye.' },
	],
};

describe('buildTemplatePrompt', () => {
	it('describes every part with its contract, limit, language and instruction', () => {
		const prompt = buildTemplatePrompt({
			parts: [
				{ spec: spec({}), instruction: 'What matters.' },
				{
					spec: spec({
						name: 'actions',
						format: 'bullets',
						max: 5,
						language: 'English',
					}),
					instruction: 'Who does what.',
				},
				{
					spec: spec({ name: 'odd', format: 'nope' }),
					instruction: '',
				},
			],
			facts,
			glossary: ['Kubernetes'],
			transcript,
		});

		expect(prompt.system).toContain('Answer with one JSON object');
		expect(prompt.system).toContain(
			'Title: Weekly sync\nRecorded: 2026-09-22\nLength: 2:05\nParticipants: Anna, Ben',
		);
		expect(prompt.system).toContain(
			'spell it as in this list: Kubernetes.',
		);
		expect(prompt.system).toContain('Write every value in de, unless');
		expect(prompt.system).toContain(
			'"summary": a string of Markdown paragraphs.\nWhat matters.',
		);
		expect(prompt.system).toContain(
			'"actions": an array of strings, one per point, without list markers.\nAt most 5 items, the most important first.\nWrite it in English.\nWho does what.',
		);
		expect(prompt.system).toContain(
			'"odd": a string of Markdown paragraphs.',
		);
		expect(prompt.user).toBe('[0:00] Anna: Hello.\n[1:05] Bye.');
	});

	it('leaves out the facts and terms it does not have', () => {
		const prompt = buildTemplatePrompt({
			parts: [{ spec: spec({}), instruction: 'x' }],
			facts: {
				...facts,
				recordedAt: null,
				durationSeconds: null,
				participants: [],
				language: '',
			},
			glossary: [],
			transcript: { speakers: [], segments: [] },
		});

		expect(prompt.system).toContain(
			'About the recording:\nTitle: Weekly sync\n\n',
		);
		expect(prompt.system).not.toContain('spell it');
		expect(prompt.system).toContain('in the language of the transcript');
		expect(prompt.user).toBe('');
	});
});

describe('transcriptForModel', () => {
	it('writes hours when the recording runs that long', () => {
		expect(
			transcriptForModel({
				speakers: [],
				segments: [
					{ start: 5, end: 6, text: 'a' },
					{ start: 3700, end: 3720, text: 'b' },
				],
			}),
		).toBe('[0:00:05] a\n[1:01:40] b');
	});
});

describe('readTemplateAnswer', () => {
	it('reads the value of every part the model answered', () => {
		const answers = readTemplateAnswer(
			'```json\n{"summary": "S", "actions": ["a"], "extra": 1}\n```',
			['summary', 'actions', 'missing'],
		);

		expect([...answers]).toEqual([
			['summary', 'S'],
			['actions', ['a']],
		]);
	});

	it.each([
		['plain text', 'Just the summary.', 'Just the summary.'],
		['a bare list', 'Sure: ["a", "b"]', ['a', 'b']],
		['an object under another key', '{"result": ["a"]}', ['a']],
	])(
		'reads %s as the answer of a call of one part',
		(_title, output, value) => {
			expect(
				readTemplateAnswer(output, ['summary']).get('summary'),
			).toEqual(value);
		},
	);

	it('reads nothing it cannot place', () => {
		expect(readTemplateAnswer('text', ['a', 'b']).size).toBe(0);
		expect(readTemplateAnswer('{"x": 1, "y": 2}', ['a']).size).toBe(0);
	});
});
