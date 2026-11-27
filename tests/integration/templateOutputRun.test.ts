/**
 * Tests where a transcription run whose note a template writes puts it: the
 * properties its parts send to the frontmatter, the note written apart and
 * linked from the recording's note, and a run with no note to go into.
 * @module tests/integration/templateOutputRun.test
 */

import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { EngineLabel } from 'src/providers/providers';
import type { Profile } from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { transcribeFile } from 'src/transcription/runTranscription';
import { recordingVault } from '../helpers/recordingVault';
import { completed } from '../helpers/llmDoubles';
import { fakeProvider, NO_DIARIZATION } from '../helpers/providerFixtures';

const STANDUP = 'Recordings/standup.webm';
const MEETING = 'Meetings/standup.md';
const OWN_NOTE = 'Recordings/standup - Sync.md';

/**
 * A template that writes a summary into the body, sends the decision to a
 * property, and the meeting's title, which no model is asked for, to another.
 */
const SYNC: Profile = {
	id: 'sync',
	kind: 'llmTemplate',
	name: 'Sync',
	body: [
		'## Summary',
		'',
		'{{#part "summary"}}The points.{{/part}}',
		'',
		'## Decision',
		'',
		'{{#part "decision" property="decision"}}What was decided.{{/part}}',
		'',
		'{{#part "meeting" property="meeting" model=false}}{{title}}{{/part}}',
	].join('\n'),
};

/**
 * Runs a transcription of the recording into the meeting note, or into none.
 * @param notePath - The recording's note; '' for none
 * @param settings - Settings over the template run's
 */
async function run(
	notePath: string,
	settings: Partial<AudioRecorderSettings> = {},
) {
	const vault = recordingVault({
		recordings: [STANDUP],
		notes: { [MEETING]: '---\nstatus: draft\n---\n![[standup.webm]]' },
		settings: {
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			whisperApiKey: 'sk-test',
			transcriptIncludeTimestamps: false,
			transcriptHeading: '## Notes',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'template',
			...settings,
		},
	});
	vault.settings.profiles = [...vault.settings.profiles, SYNC];
	vault.settings.selectedProfileIds.llmTemplate = SYNC.id;
	const complete = jest
		.fn()
		.mockResolvedValue(
			completed('{"summary": "Ship Friday.", "decision": "Go."}'),
		);
	const sidecar = {
		...vault.services.recordingSidecar,
		getSpeakers: jest.fn().mockResolvedValue([]),
		recordNoteOutput: jest.fn().mockResolvedValue(undefined),
		recordFileOutput: jest.fn().mockResolvedValue(undefined),
		recordProvenance: jest.fn().mockResolvedValue(undefined),
		setFailedParts: jest.fn().mockResolvedValue(undefined),
	};
	await transcribeFile(
		vault.app,
		() => vault.settings,
		vault.file(STANDUP),
		{ notePathForLinks: notePath, sidecar: sidecar as never },
		{
			createProvider: () =>
				fakeProvider({
					capabilities: NO_DIARIZATION,
					transcribe: () =>
						Promise.resolve({
							segments: [
								{ start: 0, end: 5, text: 'We ship Friday.' },
							],
						}),
				}),
			createLlm: () => ({
				id: LLM_PROVIDER_IDS.GEMINI,
				label: EngineLabel.Gemini,
				complete,
			}),
		},
	);
	return {
		read: (path: string): Promise<string> =>
			vault.app.vault.read(vault.file(path)),
		sidecar,
		complete,
	};
}

describe('a template run writing into the recording note', () => {
	it('writes the properties its parts name and leaves them out of the body', async () => {
		const { read, complete } = await run(MEETING);

		const note = await read(MEETING);
		expect(note).toMatch(
			/^---\nstatus: draft\ndecision: "Go\."\nmeeting: "standup"\n---\n/,
		);
		expect(note).toContain('## Notes\n\n## Summary\n\nShip Friday.');
		expect(note).not.toContain('## Decision');
		// The title is filled in, not asked for.
		expect(complete).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(complete.mock.calls[0])).not.toContain(
			'"meeting"',
		);
	});
});

describe('a template run writing its note apart', () => {
	it('creates the note next to the recording, with the properties, and links it', async () => {
		const { read, sidecar } = await run(MEETING, {
			llmTemplateOutput: 'separate',
		});

		const own = await read(OWN_NOTE);
		expect(own).toMatch(/^---\ndecision: "Go\."\n/);
		expect(own).toContain('## Summary\n\nShip Friday.');
		expect(await read(MEETING)).toBe(
			'---\nstatus: draft\n---\n![[standup.webm]]\n\n## Notes\n\n[[standup - Sync]]\n',
		);
		// A later rename of speakers finds the transcript where it went.
		expect(sidecar.recordNoteOutput).toHaveBeenCalledWith(
			STANDUP,
			expect.objectContaining({ path: OWN_NOTE }),
		);
	});

	it('writes it apart when the run has no note to go into', async () => {
		const { read } = await run('');

		expect(await read(OWN_NOTE)).toContain('## Summary\n\nShip Friday.');
	});
});
