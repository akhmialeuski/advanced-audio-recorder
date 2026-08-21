/**
 * Renaming a speaker, from the palette entry the plugin registers to the
 * note on disk.
 *
 * Every part of this has a suite of its own, and every one of those suites
 * stops at the seam: the dialog's tests replace the rename itself, the rename's
 * tests build their own section, and the sidecar's tests never see a dialog.
 * What nothing covered is the one thing the user does - open a transcript,
 * put a name on "Speaker 1", and expect the note and the stored roster to
 * agree afterwards - driven through the plugin's own services.
 * @module tests/e2e/speakerRename.e2e.test
 */

import { App } from 'obsidian';
// The dialogs and files a test reads here are the mock's own objects, and its
// affordances (contentEl already rendered, seeded paths) are deliberately
// absent from the published type definitions.
import type { Modal, TFile } from '../mocks/obsidian';
import { COMMAND_IDS } from 'src/constants';
import { at } from '../helpers/assertions';
import { rowButton, rowInput, settingRow } from '../helpers/settingRows';
import { asMockApp, asMockPlugin } from '../helpers/obsidianMock';
import { loadPlugin } from '../helpers/pluginHarness';
import { modalInstances, noticeMessages } from '../mocks/obsidian';
import { tick } from '../helpers/async';

const AUDIO = 'Audio/meeting.wav';
const NOTE = 'Notes/meeting.md';
const SIDECAR = `${AUDIO}.markers.json`;

/** The note the transcription wrote: an embed, then one line per turn. */
const NOTE_BODY = [
	'# Meeting',
	'',
	`![[meeting.wav#t=0]]`,
	'',
	'**Speaker 1** Shall we start?',
	'**Speaker 2** Go ahead.',
	'**Speaker 1** Right.',
	'',
].join('\n');

/** The sidecar that transcription left beside the recording. */
const SIDECAR_BODY = JSON.stringify({
	// The version the store writes today; a sidecar it cannot read would be
	// treated as corrupt rather than as a roster.
	version: 2,
	markers: [],
	transcript: {
		speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
		participants: [],
		noteOutputs: [
			{
				path: NOTE,
				templates: {
					lineFormat: '{timestamp} {speaker} {text}',
					speakerFormat: '**{speaker}**',
					includeTimestamps: false,
					timestampLinks: true,
					mergeConsecutiveSpeaker: true,
				},
				heading: 'Transcript',
				writtenAt: '2026-08-01T10:00:00Z',
			},
		],
		fileOutputs: [],
		history: [],
	},
});

/**
 * A vault holding a transcribed recording: the audio, its sidecar, and the
 * note the transcript went into, with the embed indexed so the rename can
 * tell which lines belong to this recording.
 * @returns The app, and the audio file the command runs over
 */
function vaultWithATranscribedRecording(): { app: App; audio: TFile } {
	const app = new App();
	const mock = asMockApp(app);
	const [audio, note] = mock.vault.seed([
		{ path: AUDIO, data: new ArrayBuffer(8) },
		{ path: NOTE, content: NOTE_BODY },
		{ path: SIDECAR, content: SIDECAR_BODY },
	]);
	if (!audio || !note) {
		throw new Error('the vault did not seed');
	}
	// The embed is what scopes the rewrite to this recording's own lines,
	// so a note holding two transcripts only has one of them renamed.
	mock.metadataCache.getFileCache.mockImplementation((file: TFile) =>
		file.path === NOTE
			? {
					embeds: [
						{
							link: 'meeting.wav#t=0',
							position: {
								start: { line: 2 },
								end: { line: 6 },
							},
						},
					],
				}
			: null,
	);
	mock.metadataCache.getFirstLinkpathDest.mockReturnValue(audio);
	mock.workspace.seedActiveFile(audio);
	return { app, audio };
}

/** The dialog the command opened, asserting it opened exactly one. */
function openDialog(): Modal {
	expect(modalInstances).toHaveLength(1);
	return at(modalInstances, 0);
}

/** The name field of one speaker's row. */
function nameField(dialog: Modal, label: string): HTMLInputElement {
	return rowInput(settingRow(dialog.contentEl, label));
}

/** Types a name into a speaker's field and presses Apply. */
async function rename(
	dialog: Modal,
	label: string,
	name: string,
): Promise<void> {
	nameField(dialog, label).value = name;
	rowButton(dialog.contentEl, 'Apply').click();
	await tick();
}

/**
 * Runs the rename command over the open recording and waits for the dialog
 * to finish loading the stored roster.
 * @param app - The vault the plugin loads into
 */
async function openRenameDialog(app: App): Promise<Modal> {
	const { plugin } = await loadPlugin(
		{ transcriptionSpeakerRenameEnabled: true },
		app,
	);
	const offered = asMockPlugin(plugin).invokeCommand(
		COMMAND_IDS.renameSpeakers,
	);

	expect(offered).toBe(true);
	await tick();
	return openDialog();
}

describe('renaming a speaker from the palette', () => {
	it('offers one field per speaker the transcript recorded', async () => {
		const { app } = vaultWithATranscribedRecording();

		const dialog = await openRenameDialog(app);

		expect(nameField(dialog, 'Speaker 1').value).toBe('');
		expect(nameField(dialog, 'Speaker 2').value).toBe('');
	});

	it('writes the name into the note the transcript went into', async () => {
		const { app } = vaultWithATranscribedRecording();
		const dialog = await openRenameDialog(app);

		await rename(dialog, 'Speaker 1', 'Alex');

		const note = await app.vault.adapter.read(NOTE);
		expect(note).toContain('**Alex** Shall we start?');
		expect(note).toContain('**Alex** Right.');
		// The speaker nobody renamed keeps its label.
		expect(note).toContain('**Speaker 2** Go ahead.');
	});

	it('remembers the name so the next rename starts from it', async () => {
		const { app } = vaultWithATranscribedRecording();
		const dialog = await openRenameDialog(app);

		await rename(dialog, 'Speaker 1', 'Alex');

		const stored = JSON.parse(await app.vault.adapter.read(SIDECAR)) as {
			transcript: { speakers: { label: string; name?: string }[] };
		};
		expect(stored.transcript.speakers).toContainEqual(
			expect.objectContaining({ label: 'Speaker 1', name: 'Alex' }),
		);
	});

	it('says what it changed', async () => {
		const { app } = vaultWithATranscribedRecording();
		const dialog = await openRenameDialog(app);

		await rename(dialog, 'Speaker 1', 'Alex');

		expect(noticeMessages().join('\n')).toContain('1 note');
	});
});

describe('the rename command itself', () => {
	it('is not offered while the feature is switched off', async () => {
		const { app } = vaultWithATranscribedRecording();
		const { plugin } = await loadPlugin(
			{ transcriptionSpeakerRenameEnabled: false },
			app,
		);

		expect(
			asMockPlugin(plugin).invokeCommand(COMMAND_IDS.renameSpeakers),
		).toBe(false);
		expect(modalInstances).toHaveLength(0);
	});

	it('is not offered with no audio file open', async () => {
		const app = new App();
		const { plugin } = await loadPlugin(
			{ transcriptionSpeakerRenameEnabled: true },
			app,
		);

		expect(
			asMockPlugin(plugin).invokeCommand(COMMAND_IDS.renameSpeakers),
		).toBe(false);
	});

	it('explains itself when the recording carries no roster', async () => {
		const app = new App();
		const mock = asMockApp(app);
		const [audio] = mock.vault.seed([
			{ path: AUDIO, data: new ArrayBuffer(8) },
		]);
		mock.workspace.seedActiveFile(audio ?? null);

		const dialog = await openRenameDialog(app);

		expect(dialog.contentEl.textContent).toContain('diarization');
	});
});
