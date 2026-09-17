/**
 * Tests that a transcription run reads the note of a profile it applies as the
 * run starts, names a profile it reads whose note has gone from the vault, goes
 * ahead on the text last read from that note, and says nothing about a profile
 * whose text the run does not read.
 * @module tests/integration/transcriptionProfileNotes.test
 */

import { App } from 'obsidian';
import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
	type TranscribeRunOptions,
} from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId, type Profile } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
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
 * Transcribes the standup recording, by default over a vault that answers no
 * file for any path, so every profile note is missing.
 * @param settings - The settings the run reads
 * @param options - Run options besides the note for links and the token
 * @param app - The app whose vault holds the notes and the recording
 * @returns The Markdown the run wrote, and the terms it sent the engine
 */
async function transcribe(
	settings: AudioRecorderSettings,
	options: Partial<TranscribeRunOptions> = {},
	app: App = createMockApp({
		vault: { readBinary: () => Promise.resolve(new ArrayBuffer(8)) },
	}).app,
): Promise<{ markdown: string; dictionary: string[] | undefined }> {
	const provider = fakeProvider({
		capabilities: NO_DIARIZATION,
		transcribe: () =>
			Promise.resolve({
				segments: [{ start: 0, end: 2, text: 'kubectl' }],
			}),
	});
	const service = new TranscriptionService(app, () => settings, {
		createProvider: () => provider,
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

describe('a transcription whose profile is read from a note', () => {
	it('biases toward the terms the note holds as the run starts', async () => {
		// The body still holds the term read before the note was edited.
		const app = new App();
		asMockVault(app.vault).seed([
			{ path: 'Glossaries/Standup.md', content: '- Kubernetes\n- Helm' },
			{ path: standup.path, data: new ArrayBuffer(8) },
		]);

		const { dictionary } = await transcribe(
			withNoteProfile(STANDUP_GLOSSARY, {
				transcriptionAdvancedSettingsEnabled: true,
			}),
			{},
			app,
		);

		expect(dictionary).toEqual(['Kubernetes', 'Helm']);
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
			withNoteProfile(
				{
					id: 'c1',
					kind: 'llmCleanup',
					name: 'Cleanup',
					body: 'Tidy the transcript.',
					sourcePath: 'Prompts/Cleanup.md',
				},
				{ llmPostProcessEnabled: true, llmPostProcessTask: 'cleanup' },
			),
			{ skipPostProcessing: true },
		);

		expect(noticeMessages()).not.toContain(
			lostNoteNotice('Cleanup', 'Prompts/Cleanup.md'),
		);
	});

	it('says nothing about the roster note on an engine that labels no speakers', async () => {
		// Speaker labels are switched on, and the Whisper API cannot produce
		// them, so the run reads no participant names.
		await transcribe(
			withNoteProfile(
				{
					id: 'p1',
					kind: 'participants',
					name: 'Team',
					body: 'Alex',
					sourcePath: 'People/Team.md',
				},
				{ transcriptionDiarize: true },
			),
		);

		expect(noticeMessages()).not.toContain(
			lostNoteNotice('Team', 'People/Team.md'),
		);
	});
});
