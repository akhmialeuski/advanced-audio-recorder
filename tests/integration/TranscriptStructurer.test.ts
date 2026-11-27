/**
 * Tests structuring a recording's existing transcript with a note template:
 * the note it inserts under the transcript heading, the chapters it offers
 * the template, the record of the template applied, and what it says when it
 * cannot finish.
 * @module tests/integration/TranscriptStructurer.test
 */

import { App } from 'obsidian';
import type { TranscriptLinesSource } from 'src/chapters/transcriptSources';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type { PlayerMarker } from 'src/markers/markerModel';
import { EngineLabel } from 'src/providers/providers';
import type { Profile } from 'src/settings/profiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import {
	TranscriptStructurer,
	transcriptFromLines,
} from 'src/transcription/TranscriptStructurer';
import { completed } from '../helpers/llmDoubles';
import { asMockVault, fileAt } from '../helpers/obsidianMock';

const recording = fileAt('Meetings/standup.webm');

/** The note the result goes into. */
const NOTE_PATH = 'Meetings/Weekly sync.md';

/** What the recording said, as a note held it. */
const SOURCE: TranscriptLinesSource = {
	lines: [
		{ time: 0, text: 'Anna: The deck is late.' },
		{ time: 65, text: 'Ben: I send it Friday.' },
	],
	origin: NOTE_PATH,
};

/** A template that writes the chapters it is given and a summary. */
const TEMPLATE: Profile = {
	id: 'tpl',
	kind: 'llmTemplate',
	name: 'Sync',
	body: [
		'{{#if chapters}}### Chapters',
		'',
		'{{chapters}}',
		'',
		'{{/if}}### Summary',
		'',
		'{{#part "summary" format="bullets"}}The points.{{/part}}',
	].join('\n'),
};

/** One chapter and one bookmark, of which only the chapter is listed. */
const MARKERS: PlayerMarker[] = [
	{ id: 'c1', time: 65, label: 'Deck', kind: 'chapter' },
	{ id: 'b1', time: 10, label: 'Funny', kind: 'bookmark' },
];

/**
 * A structurer over a vault holding the recording and the note.
 * @param options - The markers the recording has and the LLM's answer
 */
function build(
	options: {
		markers?: PlayerMarker[];
		answer?: string | Error;
		body?: string;
	} = {},
) {
	const app = new App();
	asMockVault(app.vault).seed([
		{ path: recording.path, data: new ArrayBuffer(8) },
		{ path: NOTE_PATH, content: 'Notes' },
	]);
	app.metadataCache.getFileCache = jest.fn(() => ({
		frontmatter: {},
		tags: [],
	}));
	const settings = mergeSettings({ transcriptHeading: '## Meeting' });
	settings.profiles = [
		...settings.profiles,
		{ ...TEMPLATE, body: options.body ?? TEMPLATE.body },
	];
	const answer = options.answer ?? '{"summary": ["Deck moves to Friday"]}';
	const llm: LlmProvider & { complete: jest.Mock } = {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: EngineLabel.Gemini,
		complete: jest.fn(() =>
			answer instanceof Error
				? Promise.reject(answer)
				: Promise.resolve(completed(answer)),
		),
	};
	const sidecar = {
		getMarkers: jest.fn().mockResolvedValue(options.markers ?? []),
		recordAppliedTemplate: jest.fn().mockResolvedValue(undefined),
	};
	const structurer = new TranscriptStructurer(app, () => settings, sidecar, {
		createLlm: () => llm,
	});
	return { app, structurer, sidecar, llm };
}

/**
 * The note's text after a run.
 * @param app - The app the run wrote through
 */
async function noteText(app: App): Promise<string> {
	const note = app.vault.getFileByPath(NOTE_PATH);
	return note ? app.vault.read(note) : '';
}

describe('TranscriptStructurer', () => {
	it('inserts the note under the transcript heading, with the chapters the recording has', async () => {
		const { app, structurer, sidecar, llm } = build({ markers: MARKERS });

		const outcome = await structurer.structure({
			file: recording,
			notePath: NOTE_PATH,
			templateId: 'tpl',
			source: SOURCE,
		});

		expect(outcome).toEqual({
			written: true,
			message: `Structured standup.webm with "Sync" into ${NOTE_PATH}.`,
		});
		const text = await noteText(app);
		expect(text).toContain('## Meeting');
		expect(text).toContain(
			'### Chapters\n\n- [[standup.webm#t=65|1:05]] Deck\n\n### Summary\n\n- Deck moves to Friday',
		);
		expect(text).not.toContain('Funny');
		const prompt = llm.complete.mock.calls[0]?.[0] as LlmPrompt;
		expect(prompt.user).toBe(
			'[0:00] Anna: The deck is late.\n[1:05] Ben: I send it Friday.',
		);
		expect(sidecar.recordAppliedTemplate).toHaveBeenCalledWith(
			recording.path,
			expect.objectContaining({ profileId: 'tpl', name: 'Sync' }),
		);
	});

	it('writes the transcript under the chapters of the recording when asked', async () => {
		const { app, structurer } = build({
			markers: MARKERS,
			body: '{{transcript chapters=2}}',
		});

		await structurer.structure({
			file: recording,
			notePath: NOTE_PATH,
			templateId: 'tpl',
			source: SOURCE,
		});

		expect(await noteText(app)).toContain(
			'0:00 Anna: The deck is late.\n\n## Deck\n\n1:05 Ben: I send it Friday.',
		);
	});

	it('writes no chapters for a recording without them', async () => {
		const { app, structurer } = build();

		await structurer.structure({
			file: recording,
			notePath: NOTE_PATH,
			templateId: 'tpl',
			source: SOURCE,
		});

		const text = await noteText(app);
		expect(text).not.toContain('Chapters');
		expect(text).toContain('### Summary\n\n- Deck moves to Friday');
	});

	it.each([
		[
			'a template that is gone',
			{ templateId: 'gone' },
			{},
			'That note template no longer exists.',
		],
		[
			'a note that is gone',
			{ notePath: 'Meetings/Gone.md' },
			{},
			'Could not write to Meetings/Gone.md',
		],
		[
			'a model that cannot be reached',
			{},
			{ answer: new Error('timeout') },
			'Could not structure the transcript: no part of the note template "Sync" could be filled',
		],
	])(
		'says so for %s, and records nothing',
		async (_case, request, options, message) => {
			const { structurer, sidecar } = build(options);
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);

			const outcome = await structurer.structure({
				file: recording,
				notePath: NOTE_PATH,
				templateId: 'tpl',
				source: SOURCE,
				...request,
			});

			expect(outcome.written).toBe(false);
			expect(outcome.message).toContain(message);
			expect(sidecar.recordAppliedTemplate).not.toHaveBeenCalled();
			warn.mockRestore();
		},
	);

	it('says a cancelled run was cancelled', async () => {
		const { structurer, llm } = build();
		const abort = new AbortController();
		llm.complete.mockImplementation(() => {
			abort.abort();
			return Promise.reject(new Error('aborted'));
		});

		const outcome = await structurer.structure({
			file: recording,
			notePath: NOTE_PATH,
			templateId: 'tpl',
			source: SOURCE,
			signal: abort.signal,
		});

		expect(outcome).toEqual({
			written: false,
			message: 'Structuring cancelled.',
		});
	});
});

describe('transcriptFromLines', () => {
	it('makes a segment of each line, ending where the next begins', () => {
		expect(transcriptFromLines({ ...SOURCE, language: 'en' })).toEqual({
			segments: [
				{ start: 0, end: 65, text: 'Anna: The deck is late.' },
				{ start: 65, end: 65, text: 'Ben: I send it Friday.' },
			],
			speakers: [],
			language: 'en',
		});
	});
});
