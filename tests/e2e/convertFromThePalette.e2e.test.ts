/**
 * Converting a recording, from the palette entry the plugin registers to the
 * note that embeds it.
 *
 * Conversion is three parts that each have their own suite and each stop at
 * the seam: the dialog's tests replace the vault-wide link rewrite, the link
 * rewriter's tests never see a dialog, and the action registry's tests replace
 * the dialog itself. The thing the user does - pick a format, press Convert,
 * and expect the note to point at the new file - was covered nowhere.
 *
 * Only the codec is stood in for: encoding a real container needs a browser
 * API jsdom does not have, and the pipelines that do it have their own suites.
 * @module tests/e2e/convertFromThePalette.e2e.test
 */

import { App } from 'obsidian';
// The dialogs and files a test reads here are the mock's own objects, and its
// affordances (contentEl already rendered, seeded paths) are deliberately
// absent from the published type definitions.
import type { Modal, TFile } from '../mocks/obsidian';
import { COMMAND_IDS } from 'src/constants';
import { at } from '../helpers/assertions';
import { asMockApp, asMockPlugin } from '../helpers/obsidianMock';
import { loadPlugin } from '../helpers/pluginHarness';
import { modalInstances, noticeMessages } from '../mocks/obsidian';
import { rowButton, rowSelect, settingRow } from '../helpers/settingRows';
import { tick, tickTimes } from '../helpers/async';

// The codec boundary, and only that: decoding and re-encoding audio needs
// WebAudio and a container writer, neither of which jsdom has.
jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({}),
	convertBlobToFormatBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(64)),
}));
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
}));
jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest.fn().mockReturnValue([128000, 192000]),
	getSupportedSampleRates: jest.fn().mockReturnValue([44100, 48000]),
}));

const AUDIO = 'Recordings/meeting.wav';
const NOTE = 'Notes/meeting.md';
const NOTE_BODY = ['# Meeting', '', '![[meeting.wav]]', ''].join('\n');

/**
 * A vault holding one recording and the note that embeds it, with that
 * recording open so the palette entry applies to it.
 * @returns The app, and the recording the command runs over
 */
function vaultWithARecording(): { app: App; audio: TFile } {
	const app = new App();
	const mock = asMockApp(app);
	const [audio] = mock.vault.seed([
		{ path: AUDIO, data: new ArrayBuffer(128) },
		{ path: NOTE, content: NOTE_BODY },
	]);
	if (!audio) {
		throw new Error('the vault did not seed');
	}
	mock.workspace.seedActiveFile(audio);
	// The link graph and the embed's position: the vault-wide rewrite starts
	// from the graph to find the note, then rewrites at the recorded offset.
	mock.metadataCache.resolvedLinks = { [NOTE]: { [AUDIO]: 1 } };
	const start = NOTE_BODY.indexOf('![[meeting.wav]]');
	mock.metadataCache.getFileCache.mockImplementation((file: TFile) =>
		file.path === NOTE
			? {
					embeds: [
						{
							link: 'meeting.wav',
							original: '![[meeting.wav]]',
							position: {
								start: { line: 2, col: 0, offset: start },
								end: {
									line: 2,
									col: 16,
									offset: start + '![[meeting.wav]]'.length,
								},
							},
						},
					],
				}
			: null,
	);
	mock.metadataCache.getFirstLinkpathDest.mockImplementation(
		(linkpath: string) =>
			linkpath === 'meeting.wav'
				? audio
				: app.vault.getFileByPath(linkpath),
	);
	return { app, audio };
}

/**
 * Opens the conversion dialog from the palette.
 * @param app - The vault the plugin loads into
 * @param stored - Settings the plugin loads with
 */
async function openConversionDialog(
	app: App,
	stored: Record<string, unknown> = {},
): Promise<Modal> {
	const { plugin } = await loadPlugin(stored, app);
	const offered = asMockPlugin(plugin).invokeCommand(
		COMMAND_IDS.convertAudioFormat,
	);

	expect(offered).toBe(true);
	await tick();
	expect(modalInstances).toHaveLength(1);
	return at(modalInstances, 0);
}

/**
 * Picks a target format and presses Convert.
 * @param dialog - The open conversion dialog
 * @param format - The format to convert to
 */
async function convertTo(dialog: Modal, format: string): Promise<void> {
	const select = rowSelect(settingRow(dialog.contentEl, 'Target format'));
	select.value = format;
	select.dispatchEvent(new Event('change'));
	rowButton(dialog.contentEl, 'Convert').click();
	// The conversion reads the file, encodes, writes, and rewrites links.
	await tickTimes(6);
}

describe('converting a recording from the palette', () => {
	it('writes the converted file beside the original', async () => {
		const { app } = vaultWithARecording();
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: false,
			conversionLinkAction: 'replace',
		});

		await convertTo(dialog, 'mp3');

		expect(
			app.vault.getFileByPath('Recordings/meeting.mp3'),
		).not.toBeNull();
	});

	// The note is the only place the recording is referenced from, so a
	// conversion that leaves the link behind loses the audio for the reader.
	it('points the note at the file that now exists', async () => {
		const { app } = vaultWithARecording();
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: true,
			conversionLinkAction: 'replace',
		});

		await convertTo(dialog, 'mp3');

		const note = await app.vault.adapter.read(NOTE);
		expect(note).toContain('![[meeting.mp3]]');
		expect(note).not.toContain('![[meeting.wav]]');
	});

	it('leaves the note alone when the user asked for no link changes', async () => {
		const { app } = vaultWithARecording();
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: false,
			conversionLinkAction: 'none',
		});

		await convertTo(dialog, 'mp3');

		expect(await app.vault.adapter.read(NOTE)).toContain(
			'![[meeting.wav]]',
		);
	});

	it('removes the original only when the user asked for that', async () => {
		const { app, audio } = vaultWithARecording();
		const trashFile = jest.mocked(app.fileManager.trashFile);
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: true,
			conversionLinkAction: 'replace',
		});

		await convertTo(dialog, 'mp3');

		expect(trashFile).toHaveBeenCalledWith(audio);
	});

	it('keeps the original when the user asked to keep it', async () => {
		const { app } = vaultWithARecording();
		const trashFile = jest.mocked(app.fileManager.trashFile);
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: false,
			conversionLinkAction: 'replace',
		});

		await convertTo(dialog, 'mp3');

		expect(trashFile).not.toHaveBeenCalled();
	});

	it('says what it produced', async () => {
		const { app } = vaultWithARecording();
		const dialog = await openConversionDialog(app, {
			deleteSourceAfterConversion: false,
			conversionLinkAction: 'replace',
		});

		await convertTo(dialog, 'mp3');

		expect(noticeMessages().join('\n')).toContain('meeting.mp3');
	});
});

describe('the conversion command itself', () => {
	it('is not offered with no audio file open', async () => {
		const { plugin } = await loadPlugin({}, new App());

		expect(
			asMockPlugin(plugin).invokeCommand(COMMAND_IDS.convertAudioFormat),
		).toBe(false);
		expect(modalInstances).toHaveLength(0);
	});
});
