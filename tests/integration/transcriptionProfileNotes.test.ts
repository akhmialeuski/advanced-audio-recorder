/**
 * Tests that a transcription run reads the note of every profile it applies as
 * the run starts (the glossary, the cleanup and translation prompts, and the
 * roster), names a profile it reads whose note has gone from the vault or could
 * not be read, goes ahead on the text last read from that note, and says nothing
 * about a profile whose text the run does not read.
 * @module tests/integration/transcriptionProfileNotes.test
 */

import { App } from 'obsidian';
import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
	type TranscribeRunOptions,
	type TranscriptionSidecarAccess,
} from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId, type Profile } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { emptyTranscriptSection } from 'src/sidecar/recordingSidecarModel';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { completed } from '../helpers/llmDoubles';
import { noticeMessages } from '../mocks/obsidian';
import { asMockVault } from '../helpers/obsidianMock';

const standup = partial<TFile>({
	name: 'standup.webm',
	extension: 'webm',
	path: 'Meetings/standup.webm',
});

/**
 * What a run says about the missing note of one profile.
 * @param name - The profile's name
 * @param path - The path of the note it was read from
 */
const lostNoteNotice = (name: string, path: string): string =>
	`The note of profile "${name}" (${path}) is missing, so the text last read from it is used.`;

/** The glossary in use, last read from its note as one term. */
const STANDUP_GLOSSARY: Profile = {
	id: 'g1',
	kind: 'dictionary',
	name: 'Standup',
	body: '- Kubernetes',
	sourcePath: 'Glossaries/Standup.md',
};

/** The cleanup prompt in use, last read from its note. */
const CLEANUP_PROMPT: Profile = {
	id: 'c1',
	kind: 'llmCleanup',
	name: 'Cleanup',
	body: 'Tidy the transcript.',
	sourcePath: 'Prompts/Cleanup.md',
};

/** The roster in use, last read from its note as one name. */
const TEAM_ROSTER: Profile = {
	id: 'p1',
	kind: 'participants',
	name: 'Team',
	body: 'Alex',
	sourcePath: 'People/Team.md',
};

/**
 * Settings that transcribe on the Whisper API with one profile in use, read
 * from a note.
 * @param profile - The profile, read from that note
 * @param overrides - What the run is configured with besides it
 */
function withNoteProfile(
	profile: Profile,
	overrides: Partial<AudioRecorderSettings> = {},
): AudioRecorderSettings {
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: 'whisper-api',
		whisperApiKey: 'sk-glossary',
		profiles: [profile],
	});
	Object.assign(settings, overrides);
	setSelectedProfileId(settings, profile.kind, profile.id);
	return settings;
}

/**
 * An app whose vault holds the recording and the given notes.
 * @param notes - The text of each note, by its vault path
 */
function vaultWith(notes: Record<string, string>): App {
	const app = new App();
	asMockVault(app.vault).seed([
		...Object.entries(notes).map(([path, content]) => ({ path, content })),
		{ path: standup.path, data: new ArrayBuffer(8) },
	]);
	return app;
}

/**
 * An LLM that answers every prompt with the text it was sent, so a cleanup
 * keeps the transcript and a translation parses, and whose calls hold the
 * system prompts a run sent.
 */
function echoingLlm(): LlmProvider & { complete: jest.Mock } {
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Fake LLM',
		complete: jest.fn((prompt: LlmPrompt) =>
			Promise.resolve(completed(prompt.user)),
		),
	};
}

/** What a test run is given besides its settings. */
interface RunSetup {
	/** Run options besides the note for links and the token. */
	readonly options?: Partial<TranscribeRunOptions>;
	/** The app whose vault holds the notes; by default a vault holding none. */
	readonly app?: App;
	/** The LLM a post-processing pass calls. */
	readonly llm?: LlmProvider;
	/** Whether the engine labels the speakers of what it transcribes. */
	readonly speakers?: boolean;
}

/**
 * Transcribes the standup recording, by default over a vault that answers no
 * file for any path, so every profile note is missing.
 * @param settings - The settings the run reads
 * @param setup - The options, the app, the LLM and the engine of the run
 * @returns The Markdown the run wrote, and the terms it sent the engine
 */
async function transcribe(
	settings: AudioRecorderSettings,
	{
		options = {},
		app = createMockApp({
			vault: { readBinary: () => Promise.resolve(new ArrayBuffer(8)) },
		}).app,
		llm,
		speakers = false,
	}: RunSetup = {},
): Promise<{ markdown: string; dictionary: string[] | undefined }> {
	const provider = fakeProvider({
		...(speakers ? {} : { capabilities: NO_DIARIZATION }),
		transcribe: () =>
			Promise.resolve({
				segments: [
					{
						start: 0,
						end: 2,
						text: 'kubectl',
						...(speakers ? { speaker: 'Speaker 1' } : {}),
					},
				],
			}),
	});
	const service = new TranscriptionService(app, () => settings, {
		createProvider: () => provider,
		...(llm ? { createLlm: () => llm } : {}),
	});
	const result = (await service.run(standup, {
		notePathForLinks: 'Meetings/Standup.md',
		token: NEVER_CANCELLED,
		...options,
	})) as { markdown: string };
	const [, request] = provider.transcribe.mock.calls[0] as [
		unknown,
		{ dictionary?: string[] },
	];
	return { markdown: result.markdown, dictionary: request.dictionary };
}

/**
 * The system prompts an LLM double was sent, in order.
 * @param llm - The double
 */
const systemPrompts = (llm: { complete: jest.Mock }): string[] =>
	llm.complete.mock.calls.map(([prompt]) => (prompt as LlmPrompt).system);

describe('a transcription whose profile is read from a note', () => {
	it('biases toward the terms the note holds as the run starts', async () => {
		// The body still holds the term read before the note was edited.
		const { dictionary } = await transcribe(
			withNoteProfile(STANDUP_GLOSSARY, {
				transcriptionAdvancedSettingsEnabled: true,
			}),
			{
				app: vaultWith({
					'Glossaries/Standup.md': '- Kubernetes\n- Helm',
				}),
			},
		);

		expect(dictionary).toEqual(['Kubernetes', 'Helm']);
	});

	it('cleans up with the prompt its note holds as the run starts', async () => {
		const llm = echoingLlm();

		await transcribe(
			withNoteProfile(CLEANUP_PROMPT, {
				llmPostProcessEnabled: true,
				llmPostProcessTask: 'cleanup',
			}),
			{
				app: vaultWith({ 'Prompts/Cleanup.md': 'Fix every name.' }),
				llm,
			},
		);

		expect(systemPrompts(llm)).toEqual([
			expect.stringContaining('Fix every name.'),
		]);
	});

	it('translates with the prompt its note holds as the run starts', async () => {
		const llm = echoingLlm();

		await transcribe(
			withNoteProfile(
				{
					id: 't1',
					kind: 'llmTranslate',
					name: 'Translate',
					body: 'Translate word for word.',
					sourcePath: 'Prompts/Translate.md',
				},
				{
					llmPostProcessEnabled: true,
					llmPostProcessTask: 'translate',
					llmTranslateTargetLanguage: 'Spanish',
				},
			),
			{
				app: vaultWith({ 'Prompts/Translate.md': 'Keep it formal.' }),
				llm,
			},
		);

		expect(systemPrompts(llm)).toEqual([
			expect.stringContaining('Keep it formal.'),
		]);
	});

	it('stores with the recording the roster its note holds as the run starts', async () => {
		const sidecar = partial<TranscriptionSidecarAccess>({
			getTranscript: jest
				.fn()
				.mockResolvedValue(emptyTranscriptSection()),
			setSpeakers: jest.fn().mockResolvedValue(undefined),
		});

		await transcribe(
			withNoteProfile(TEAM_ROSTER, {
				transcriptionProvider: 'deepgram',
				deepgramApiKey: 'dg-roster',
				transcriptionDiarize: true,
			}),
			{
				app: vaultWith({ 'People/Team.md': '- Alex\n- Maria' }),
				options: { sidecar },
				speakers: true,
			},
		);

		expect(sidecar.setSpeakers).toHaveBeenCalledWith(
			standup.path,
			expect.any(Array),
			{ names: ['Alex', 'Maria'], profileId: TEAM_ROSTER.id },
		);
	});
});

describe('a transcription whose profile note is gone', () => {
	it('names the glossary note, and transcribes with the text last read from it', async () => {
		const { markdown, dictionary } = await transcribe(
			withNoteProfile(STANDUP_GLOSSARY, {
				transcriptionAdvancedSettingsEnabled: true,
			}),
		);

		expect(noticeMessages()).toContain(
			lostNoteNotice('Standup', 'Glossaries/Standup.md'),
		);
		expect(markdown).toContain('kubectl');
		expect(dictionary).toEqual(['Kubernetes']);
	});

	it('says nothing about the prompt note of a pass the run skips', async () => {
		// Retrying failed parts transcribes without post-processing, whatever
		// the settings switch on.
		await transcribe(
			withNoteProfile(CLEANUP_PROMPT, {
				llmPostProcessEnabled: true,
				llmPostProcessTask: 'cleanup',
			}),
			{ options: { skipPostProcessing: true } },
		);

		expect(noticeMessages()).not.toContain(
			lostNoteNotice('Cleanup', 'Prompts/Cleanup.md'),
		);
	});

	it('says nothing about the roster note on an engine that labels no speakers', async () => {
		// Speaker labels are switched on, and the Whisper API cannot produce
		// them, so the run reads no participant names.
		await transcribe(
			withNoteProfile(TEAM_ROSTER, { transcriptionDiarize: true }),
		);

		expect(noticeMessages()).not.toContain(
			lostNoteNotice('Team', 'People/Team.md'),
		);
	});
});

describe('a transcription whose profile note cannot be read', () => {
	it('names the glossary note, and transcribes with the text last read from it', async () => {
		// The note is in the vault and locked by another program, so its read
		// fails while every lookup of its path succeeds.
		const app = vaultWith({ 'Glossaries/Standup.md': '- Helm' });
		asMockVault(app.vault).read.mockRejectedValueOnce(new Error('EBUSY'));
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const { dictionary } = await transcribe(
			withNoteProfile(STANDUP_GLOSSARY, {
				transcriptionAdvancedSettingsEnabled: true,
			}),
			{ app },
		);

		expect(noticeMessages()).toContain(
			'The note of profile "Standup" (Glossaries/Standup.md) could not be read, so the text last read from it is used.',
		);
		expect(dictionary).toEqual(['Kubernetes']);
	});
});
