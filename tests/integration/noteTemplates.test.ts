/**
 * Tests that a run with the template task builds the note from the selected
 * note template: the parts asked for in as few calls as their settings allow,
 * the answers written by their formats, a part that comes back empty removed
 * with its heading, and the transcript kept whenever the template cannot be
 * used.
 * @module tests/integration/noteTemplates.test
 */

import { App } from 'obsidian';
import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionCancelledError,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId, type Profile } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { CancellationSource } from 'src/utils/cancellation';
import { partial, silenceConsole } from '../helpers/doubles';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { completed } from '../helpers/llmDoubles';
import { asMockVault } from '../helpers/obsidianMock';
import { EngineLabel } from 'src/providers/providers';
import { noticeMessages } from '../mocks/obsidian';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import {
	ARCHITECTURE_TEMPLATE,
	DAILY_SYNC_TEMPLATE,
} from 'src/templates/shippedTemplates';

const recording = partial<TFile>({
	name: 'standup.webm',
	basename: 'standup',
	extension: 'webm',
	path: 'Meetings/standup.webm',
	stat: { ctime: 0, mtime: 0, size: 8 },
});

/** The note the result goes to. */
const NOTE_PATH = 'Meetings/Weekly sync.md';

/** A custom instruction a part takes by name. */
const ACTION_ITEMS: Profile = {
	id: 'actions',
	kind: 'llmCustom',
	name: 'Action items',
	body: 'Who does what for {{title}}.',
};

/**
 * Settings that build the note from a template.
 * @param body - The template; omitted for no template selected
 * @param profiles - The prompt profiles its parts may name
 */
function withTemplate(
	body?: string,
	profiles: readonly Profile[] = [ACTION_ITEMS],
): AudioRecorderSettings {
	const template: Profile = {
		id: 'tpl',
		kind: 'llmTemplate',
		name: 'Meeting',
		body: body ?? '',
	};
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		whisperApiKey: 'sk-test',
		transcriptIncludeTimestamps: false,
		llmPostProcessEnabled: true,
		llmPostProcessTask: 'template',
		profiles: [template, ...profiles],
	});
	if (body !== undefined) {
		setSelectedProfileId(settings, 'llmTemplate', template.id);
	}
	return settings;
}

/** Where a prompt profile a part names is kept as a note. */
const PROMPT_NOTE = 'Prompts/Action items.md';

/** An app whose vault holds the recording, the note and a prompt note. */
function vault(): App {
	const app = new App();
	asMockVault(app.vault).seed([
		{ path: recording.path, data: new ArrayBuffer(8) },
		{ path: NOTE_PATH, content: 'Notes' },
		{ path: PROMPT_NOTE, content: 'From the note, for {{title}}.' },
	]);
	app.metadataCache.getFileCache = jest.fn(() => ({
		frontmatter: {},
		tags: [],
	}));
	return app;
}

/**
 * An LLM answering each call with the next of the given answers; an Error
 * among them is thrown instead.
 * @param answers - The answers, in the order of the calls
 */
function scriptedLlm(
	...answers: (string | Error)[]
): LlmProvider & { complete: jest.Mock } {
	const queue = [...answers];
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: EngineLabel.Gemini,
		complete: jest.fn(() => {
			const next = queue.shift() ?? '{}';
			return next instanceof Error
				? Promise.reject(next)
				: Promise.resolve(completed(next));
		}),
	};
}

/**
 * Transcribes the recording with the given settings and LLM.
 * @param settings - The settings the run reads
 * @param llm - The LLM the parts are asked of
 * @param token - Cancellation for the run
 * @param segments - What the recording says
 * @returns The note's Markdown, what the template decided about its
 *   timestamps, and the prompts the LLM was sent
 */
async function transcribe(
	settings: AudioRecorderSettings,
	llm: LlmProvider & { complete: jest.Mock },
	token = NEVER_CANCELLED,
	segments: readonly TranscriptSegment[] = [
		{ start: 0, end: 62, text: 'Ben sends the deck.' },
	],
): Promise<{
	markdown: string;
	timestamps: boolean | undefined;
	prompts: LlmPrompt[];
}> {
	const provider = fakeProvider({
		capabilities: NO_DIARIZATION,
		transcribe: () => Promise.resolve({ segments: [...segments] }),
	});
	const service = new TranscriptionService(vault(), () => settings, {
		createProvider: () => provider,
		createLlm: () => llm,
	});
	const result = await service.run(recording, {
		notePathForLinks: NOTE_PATH,
		token,
	});
	return {
		markdown: result.markdown,
		timestamps: result.noteTimestamps,
		prompts: llm.complete.mock.calls.map(([prompt]) => prompt as LlmPrompt),
	};
}

describe('a run with a note template', () => {
	it('fills every part in one call and writes the note', async () => {
		const llm = scriptedLlm(
			'{"summary": ["Deck is late", "Ship Friday"], "actions": "Ben sends the deck."}',
		);

		const { markdown, prompts } = await transcribe(
			withTemplate(
				[
					'# {{title}}',
					'',
					'## Summary',
					'',
					'{{#part "summary" format="bullets" max=1}}The points of {{title}}.{{/part}}',
					'',
					'## Action items',
					'',
					'{{part "actions" profile="Action items"}}',
					'',
					'{{transcript}}',
				].join('\n'),
			),
			llm,
		);

		expect(markdown).toBe(
			'# Weekly sync\n\n## Summary\n\n- Deck is late\n\n## Action items\n\nBen sends the deck.\n\nBen sends the deck.',
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.system).toContain(
			'"summary": an array of strings, one per point, without list markers.\nAt most 1 items, the most important first.\nThe points of Weekly sync.',
		);
		expect(prompts[0]?.system).toContain(
			'"actions": a string of Markdown paragraphs.\nWho does what for Weekly sync.',
		);
		expect(prompts[0]?.user).toBe('[0:00] Ben sends the deck.');
	});

	it('reads a profile a part names from its note as the run starts', async () => {
		const llm = scriptedLlm('{"actions": "A"}');

		const { prompts } = await transcribe(
			withTemplate('{{part "actions" profile="Action items"}}', [
				{ ...ACTION_ITEMS, sourcePath: PROMPT_NOTE },
			]),
			llm,
		);

		expect(prompts[0]?.system).toContain(
			'"actions": a string of Markdown paragraphs.\nFrom the note, for Weekly sync.',
		);
	});

	it('writes a part only where the template names it when it is not inline', async () => {
		const { markdown, prompts } = await transcribe(
			withTemplate(
				[
					'# {{parts.title}}',
					'',
					'{{#part "title" inline=false}}A title in five words.{{/part}}',
					'',
					'{{transcript}}',
				].join('\n'),
			),
			scriptedLlm(JSON.stringify({ title: 'Ben sends the deck' })),
		);

		expect(markdown).toBe('# Ben sends the deck\n\nBen sends the deck.');
		expect(prompts).toHaveLength(1);
	});

	it('writes each format, linking a quote to its moment in the recording', async () => {
		const llm = scriptedLlm(
			JSON.stringify({
				actions: [
					{ text: 'Send the deck', owner: 'Ben', due: '2026-10-01' },
				],
				said: [
					{
						quote: 'Ben sends the deck.',
						speaker: 'Ben',
						time: '0:42',
					},
				],
				owners: [{ Owner: 'Ben', Task: 'Deck' }],
			}),
		);

		const { markdown, prompts } = await transcribe(
			withTemplate(
				[
					'{{#part "actions" format="tasks" style="dataview"}}Actions.{{/part}}',
					'',
					'{{#part "said" format="quotes"}}Quotes.{{/part}}',
					'',
					'{{#part "owners" format="table" columns="Owner, Task"}}Who.{{/part}}',
				].join('\n'),
			),
			llm,
		);

		expect(markdown).toBe(
			[
				'- [ ] Send the deck [owner:: Ben] [due:: 2026-10-01]',
				'',
				'> Ben sends the deck.',
				'> - Ben, [[standup.webm#t=42|0:42]]',
				'',
				'| Owner | Task |',
				'| --- | --- |',
				'| Ben | Deck |',
			].join('\n'),
		);
		expect(prompts[0]?.system).toContain(
			'"owners": an array of objects, one per item, with "Owner" (a short text), "Task" (a short text).',
		);
	});

	it('asks for a separate part on its own and writes the rest when it fails', async () => {
		silenceConsole('warn');
		const llm = scriptedLlm(
			'{"summary": "All good."}',
			new Error('timeout'),
		);

		const { markdown, prompts } = await transcribe(
			withTemplate(
				'## Summary\n\n{{#part "summary"}}Summary.{{/part}}\n\n## Risks\n\n{{#part "risks" separate=true}}Risks.{{/part}}',
			),
			llm,
		);

		expect(prompts).toHaveLength(2);
		expect(markdown).toBe('## Summary\n\nAll good.');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				'The note template "Meeting" was written without "risks": the model could not be reached for it.',
			]),
		);
	});

	it('names every part it lost', async () => {
		silenceConsole('warn');
		const llm = scriptedLlm(new Error('timeout'), '{"c": "C"}');

		const { markdown } = await transcribe(
			withTemplate(
				'{{#part "a"}}A{{/part}} {{#part "b"}}B{{/part}} {{#part "c" separate=true}}C{{/part}}',
			),
			llm,
		);

		expect(markdown).toBe('C');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'without "a", "b": the model could not be reached for them.',
				),
			]),
		);
	});

	it('keeps the transcript when every call failed', async () => {
		silenceConsole('warn');

		const { markdown } = await transcribe(
			withTemplate('{{#part "a"}}A{{/part}}'),
			scriptedLlm(new Error('down')),
		);

		expect(markdown).toBe('Ben sends the deck.');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				'LLM post-processing failed; saving the raw transcript. no part of the note template "Meeting" could be filled',
			]),
		);
	});

	it('leaves out a part whose profile is gone', async () => {
		const llm = scriptedLlm('{"a": "A"}');

		const { markdown, prompts } = await transcribe(
			withTemplate(
				'{{#part "a"}}A{{/part}}\n\n## Gone\n\n{{part "b" profile="Gone"}}',
			),
			llm,
		);

		expect(markdown).toBe('A');
		expect(prompts[0]?.system).not.toContain('"b"');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				'The note template "Meeting" names prompt profiles that do not exist: Gone. Those parts were left out.',
			]),
		);
	});

	it('writes a template without parts with no call at all', async () => {
		const llm = scriptedLlm();

		const { markdown } = await transcribe(
			withTemplate('# {{title}}\n\n{{transcript}}'),
			llm,
		);

		expect(markdown).toBe('# Weekly sync\n\nBen sends the deck.');
		expect(llm.complete).toHaveBeenCalledTimes(0);
	});

	it('keeps the transcript, with a notice, when no template is selected', async () => {
		const llm = scriptedLlm();

		const { markdown } = await transcribe(withTemplate(), llm);

		expect(markdown).toBe('Ben sends the deck.');
		expect(llm.complete).toHaveBeenCalledTimes(0);
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				'No note template is selected, so the transcript was saved as it is.',
			]),
		);
	});

	it('keeps the transcript, with a notice, when the template cannot be rendered', async () => {
		const llm = scriptedLlm();

		const { markdown } = await transcribe(
			withTemplate('{{#part "a"}}x{{/part}}{{#part "a"}}y{{/part}}'),
			llm,
		);

		expect(markdown).toBe('Ben sends the deck.');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					'The note template "Meeting" could not be rendered (Two parts are named "a"',
				),
			]),
		);
	});

	it('ends the run when it is cancelled during a call', async () => {
		const source = new CancellationSource();
		const llm = scriptedLlm();
		llm.complete.mockImplementation(() => {
			source.cancel();
			return Promise.reject(new Error('aborted'));
		});

		await expect(
			transcribe(
				withTemplate('{{#part "a"}}A{{/part}}'),
				llm,
				source.token,
			),
		).rejects.toBeInstanceOf(TranscriptionCancelledError);
	});
});

describe('the transcript in a note template', () => {
	/** Two turns of one meeting. */
	const MEETING: readonly TranscriptSegment[] = [
		{ start: 0, end: 30, text: 'Ben sends the deck.' },
		{ start: 65, end: 90, text: 'Anna books [[the room]].' },
	];

	it('writes it in a folded callout with the timestamps it asks for', async () => {
		const { markdown, timestamps } = await transcribe(
			withTemplate(
				[
					'{{#part "summary"}}Points.{{/part}}',
					'',
					'{{transcript callout="quote" title="Transcript" folded=true timestamps=true}}',
				].join('\n'),
			),
			scriptedLlm('{"summary": "Short."}'),
			NEVER_CANCELLED,
			MEETING,
		);

		expect(markdown).toBe(
			[
				'Short.',
				'',
				'> [!quote]- Transcript',
				'> [[standup.webm#t=0|0:00]] Ben sends the deck.',
				'>',
				'> [[standup.webm#t=65|1:05]] Anna books \\[\\[the room\\]\\].',
			].join('\n'),
		);
		expect(timestamps).toBe(true);
	});

	it('keeps the settings where the template says nothing', async () => {
		const { markdown, timestamps } = await transcribe(
			withTemplate(
				'{{#part "summary"}}Points.{{/part}}\n\n{{transcript}}',
			),
			scriptedLlm('{"summary": "Short."}'),
			NEVER_CANCELLED,
			MEETING,
		);

		expect(markdown).toBe(
			'Short.\n\nBen sends the deck.\n\nAnna books \\[\\[the room\\]\\].',
		);
		expect(timestamps).toBeUndefined();
	});

	it('repeats a block of its own for every turn', async () => {
		const { markdown } = await transcribe(
			withTemplate(
				[
					'{{#part "summary"}}Points.{{/part}}',
					'{{#each turns}}',
					'- {{link}} {{text}}',
					'{{/each}}',
				].join('\n'),
			),
			scriptedLlm('{"summary": "Short."}'),
			NEVER_CANCELLED,
			MEETING,
		);

		expect(markdown).toBe(
			[
				'Short.',
				'- [[standup.webm#t=0|0:00]] Ben sends the deck.',
				'- [[standup.webm#t=65|1:05]] Anna books \\[\\[the room\\]\\].',
			].join('\n'),
		);
	});

	it('writes the transcript in one piece in a run, which has no chapters yet', async () => {
		const { markdown } = await transcribe(
			withTemplate('{{transcript chapters=true}}'),
			scriptedLlm('{}'),
		);

		expect(markdown).toBe('Ben sends the deck.');
	});
});

describe('the shipped templates', () => {
	it('writes a quiet daily sync as its header, three points and the folded transcript', async () => {
		const { markdown } = await transcribe(
			withTemplate(DAILY_SYNC_TEMPLATE.body),
			scriptedLlm(
				JSON.stringify({
					summary: [
						'Deck is late',
						'Ship Friday',
						'QA done',
						'Extra',
					],
					actions: [],
					blockers: [],
				}),
			),
		);

		expect(markdown).toBe(
			[
				'# Weekly sync',
				'',
				'Thursday, 1 January 1970 · 1:02',
				'',
				'## Summary',
				'',
				'- Deck is late',
				'- Ship Friday',
				'- QA done',
				'',
				'## Transcript',
				'',
				'> [!quote]- Full transcript',
				'> Ben sends the deck.',
			].join('\n'),
		);
	});

	it('puts the decisions of an architecture discussion in a callout', async () => {
		const { markdown } = await transcribe(
			withTemplate(ARCHITECTURE_TEMPLATE.body),
			scriptedLlm(
				JSON.stringify({
					decisions: [
						{
							decision: 'Use SQLite',
							reason: 'One file; Postgres was too much',
						},
					],
				}),
			),
		);

		expect(markdown).toContain(
			'## Decisions\n\n> [!success] Decided\n> - **Use SQLite**: One file; Postgres was too much\n\n## Transcript\n\n> [!quote]- Full transcript',
		);
	});
});
