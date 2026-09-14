/**
 * Tests that a transcription run names a profile it applies whose note has
 * gone from the vault, and goes ahead on the text last read from that note.
 * @module tests/integration/transcriptionLostProfileNote.test
 */

import type { TFile } from 'obsidian';
import {
	NEVER_CANCELLED,
	TranscriptionService,
} from 'src/transcription/TranscriptionService';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { setSelectedProfileId } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';
import { noticeMessages } from '../mocks/obsidian';

const GLOSSARY_NOTE = 'Glossaries/Standup.md';

const standup = partial<TFile>({
	name: 'standup.webm',
	extension: 'webm',
	path: 'Meetings/standup.webm',
});

/**
 * Settings that transcribe with a glossary read from a note, as the advanced
 * settings apply it.
 * @param body - The text last read from the note
 */
function glossaryFromNote(body: string): AudioRecorderSettings {
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: 'whisper-api',
		whisperApiKey: 'sk-glossary',
		profiles: [
			{
				id: 'g1',
				kind: 'dictionary',
				name: 'Standup',
				body,
				sourcePath: GLOSSARY_NOTE,
			},
		],
	});
	settings.transcriptionAdvancedSettingsEnabled = true;
	setSelectedProfileId(settings, 'dictionary', 'g1');
	return settings;
}

describe('a transcription whose glossary note is gone', () => {
	it('names the note, and transcribes with the text last read from it', async () => {
		const transcribe = jest.fn(() =>
			Promise.resolve({
				segments: [{ start: 0, end: 2, text: 'kubectl' }],
			}),
		);
		// The vault answers no file for any path, the note's included.
		const vaultWithoutNote = createMockApp({
			vault: { readBinary: () => Promise.resolve(new ArrayBuffer(8)) },
		}).app;
		const service = new TranscriptionService(
			vaultWithoutNote,
			() => glossaryFromNote('- Kubernetes'),
			{
				createProvider: () =>
					fakeProvider({ capabilities: NO_DIARIZATION, transcribe }),
			},
		);

		const result = (await service.run(standup, {
			notePathForLinks: 'Meetings/Standup.md',
			token: NEVER_CANCELLED,
		})) as { markdown: string };

		expect(noticeMessages()).toContain(
			'The note of profile "Standup" (Glossaries/Standup.md) is missing, so the text last read from it is used.',
		);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(result.markdown).toContain('kubectl');
	});
});
