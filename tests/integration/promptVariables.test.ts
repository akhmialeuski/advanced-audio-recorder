/**
 * Tests that a transcription run fills the facts it holds into the prompt it
 * sends: the note the result goes to and the properties a prompt names, the
 * recording, its participants, and that a name it does not know reaches the
 * model as it was typed.
 * @module tests/integration/promptVariables.test
 */

import { App } from 'obsidian';
import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId, type Profile } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { partial } from '../helpers/doubles';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { echoingLlm } from '../helpers/llmDoubles';
import { asMockVault } from '../helpers/obsidianMock';
import { noticeMessages } from '../mocks/obsidian';

/** 22 September 2026, when the recording was made. */
const RECORDED_AT = new Date(2026, 8, 22, 10, 0).getTime();

const recording = partial<TFile>({
	name: 'standup.webm',
	basename: 'standup',
	extension: 'webm',
	path: 'Meetings/standup.webm',
	stat: { ctime: RECORDED_AT, mtime: RECORDED_AT, size: 8 },
});

/** The note the result goes to. */
const NOTE_PATH = 'Meetings/Weekly sync.md';

/**
 * Settings that run one post-processing task with a prompt of their own.
 * @param kind - The kind of prompt profile
 * @param task - The task it serves
 * @param body - The prompt
 */
function withPrompt(
	kind: Profile['kind'],
	task: AudioRecorderSettings['llmPostProcessTask'],
	body: string,
): AudioRecorderSettings {
	const prompt: Profile = { id: 'p', kind, name: 'Prompt', body };
	const team: Profile = {
		id: 't',
		kind: 'participants',
		name: 'Team',
		body: 'Anna\nBen',
	};
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		whisperApiKey: 'sk-test',
		llmPostProcessEnabled: true,
		llmPostProcessTask: task,
		profiles: [prompt, team],
	});
	setSelectedProfileId(settings, kind, prompt.id);
	setSelectedProfileId(settings, 'participants', team.id);
	return settings;
}

/**
 * An app whose vault holds the recording and, optionally, the note with the
 * given properties.
 * @param frontmatter - The note's properties; omitted for no note at all
 */
function vaultWith(frontmatter?: Record<string, unknown>): App {
	const app = new App();
	asMockVault(app.vault).seed([
		{ path: recording.path, data: new ArrayBuffer(8) },
		...(frontmatter ? [{ path: NOTE_PATH, content: 'Notes' }] : []),
	]);
	app.metadataCache.getFileCache = jest.fn(() =>
		frontmatter ? { frontmatter, tags: [] } : null,
	);
	return app;
}

/**
 * Transcribes the recording and answers the system prompt the LLM was sent.
 * @param settings - The settings the run reads
 * @param app - The app whose vault holds the recording and the note
 */
async function systemPromptOf(
	settings: AudioRecorderSettings,
	app: App,
): Promise<string> {
	const llm = echoingLlm();
	const provider = fakeProvider({
		capabilities: NO_DIARIZATION,
		transcribe: () =>
			Promise.resolve({ segments: [{ start: 0, end: 62, text: 'Hi' }] }),
	});
	const service = new TranscriptionService(app, () => settings, {
		createProvider: () => provider,
		createLlm: () => llm,
	});
	await service.run(recording, {
		notePathForLinks: NOTE_PATH,
		token: NEVER_CANCELLED,
	});
	const [prompt] = llm.complete.mock.calls[0] as [LlmPrompt];
	return prompt.system;
}

describe('a prompt that names facts of the run', () => {
	it('is sent with the note, the date, the length and the participants', async () => {
		const settings = withPrompt(
			'llmSummary',
			'summary',
			'Summarize "{{title}}" of {{date recordedAt format="D MMMM YYYY"}} ({{duration}}) with {{join participants ", "}}.',
		);

		const system = await systemPromptOf(settings, vaultWith({}));

		expect(system).toContain(
			'Summarize "Weekly sync" of 22 September 2026 (1:02) with Anna, Ben.',
		);
	});

	it('reads only the properties the prompt names', async () => {
		const settings = withPrompt(
			'llmCustom',
			'custom',
			'Project {{properties.project}}.',
		);

		const system = await systemPromptOf(
			settings,
			vaultWith({ project: 'Atlas', salary: 'private' }),
		);

		expect(system).toBe('Project Atlas.');
	});

	it('leaves a name it does not know as typed', async () => {
		const settings = withPrompt(
			'llmCustom',
			'custom',
			'Answer {"owner": "{{owner}}"} for {{title}}.',
		);

		const system = await systemPromptOf(settings, vaultWith({}));

		expect(system).toBe('Answer {"owner": "{{owner}}"} for Weekly sync.');
	});

	it('is titled after the recording when there is no note', async () => {
		const settings = withPrompt('llmCustom', 'custom', 'About {{title}}.');

		const system = await systemPromptOf(settings, vaultWith());

		expect(system).toBe('About standup.');
	});

	it('is sent as typed, with a notice, when it cannot be rendered', async () => {
		const settings = withPrompt('llmCustom', 'custom', 'Broken {{#if}}');
		jest.spyOn(console, 'warn').mockImplementation();

		const system = await systemPromptOf(settings, vaultWith({}));

		expect(system).toBe('Broken {{#if}}');
		expect(noticeMessages()).toEqual(
			expect.arrayContaining([
				expect.stringContaining('could not be filled in'),
			]),
		);
	});

	it('fills a translation prompt the same way', async () => {
		const settings = withPrompt(
			'llmTranslate',
			'translate',
			'Translate the meeting "{{title}}".',
		);

		const system = await systemPromptOf(settings, vaultWith({}));

		expect(system).toContain('Translate the meeting "Weekly sync".');
	});
});
