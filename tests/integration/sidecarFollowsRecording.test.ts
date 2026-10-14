/**
 * A recording's sidecar following the recording through the vault, from the
 * vault event to the files the vault holds afterwards.
 *
 * The store's own suite calls its rename and delete handlers directly, and
 * the registrar's suite replaces the store with a double. Neither closes the
 * loop the running plugin closes: the vault reports that the recording moved,
 * the store moves the sidecar through the same vault, and the vault reports
 * that second move back to the registrar's own handlers. Those have to let it
 * pass - a sidecar is neither a recording nor a recorded transcript output -
 * or one rename turns into a cascade.
 * @module tests/integration/sidecarFollowsRecording.test
 */

import { App } from 'obsidian';
// The files a test seeds and reads back are the mock's own objects, and its
// affordances (seed, the spied file manager) are deliberately absent from the
// published type definitions.
import type { TFile } from '../mocks/obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { asMockApp, partialPlugin } from '../helpers/obsidianMock';
import { waitFor } from '../helpers/async';

const AUDIO = 'Audio/meeting.wav';
const SIDECAR = `${AUDIO}.markers.json`;
const MOVED_AUDIO = 'Archive/meeting.wav';
const MOVED_SIDECAR = `${MOVED_AUDIO}.markers.json`;

/** The sidecar a marked recording carries: one bookmark. */
const SIDECAR_BODY = JSON.stringify({
	version: 2,
	markers: [{ id: 'm1', time: 12, label: 'Intro', kind: 'bookmark' }],
});

/**
 * A vault holding one recording with markers, with the registrar listening to
 * it and the real sidecar store behind the registrar.
 * @returns The app, the recording, its sidecar, and the console.warn spy
 */
function createSut(): {
	app: App;
	audio: TFile;
	sidecar: TFile;
	warn: jest.SpyInstance;
} {
	// jsdom has no embed registry, so the registrar warns that it falls back
	// to the post-processor; the spy also catches any sidecar failure.
	const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
		// Asserted on where it matters.
	});
	const app = new App();
	const [audio, sidecar] = asMockApp(app).vault.seed([
		{ path: AUDIO, data: new ArrayBuffer(8) },
		{ path: SIDECAR, content: SIDECAR_BODY },
	]);
	if (!audio || !sidecar) {
		throw new Error('the vault did not seed');
	}
	// Only the registrations the registrar makes on load; the vault events
	// reach it through app.vault.on whatever the plugin does with the ref.
	const plugin = partialPlugin({
		registerMarkdownPostProcessor: jest.fn(),
		registerEvent: jest.fn(),
		addChild: jest.fn(),
	});
	new EnhancedPlayerRegistrar(
		plugin,
		app,
		() => ({ ...DEFAULT_SETTINGS, enhancedPlayerEnabled: true }),
		new RecordingSidecarStore(app),
	).register();
	return { app, audio, sidecar, warn };
}

/** Every path the vault index lists, sorted. */
function vaultPaths(app: App): string[] {
	return app.vault
		.getFiles()
		.map((file) => file.path)
		.sort((a, b) => a.localeCompare(b));
}

describe('a recording with markers, moved in the vault', () => {
	it('takes its sidecar to the new path', async () => {
		const { app, audio } = createSut();

		await asMockApp(app).vault.rename(audio, MOVED_AUDIO);
		await waitFor(() => app.vault.getFileByPath(MOVED_SIDECAR) !== null, {
			message: 'the sidecar never followed the recording',
		});

		await expect(app.vault.adapter.read(MOVED_SIDECAR)).resolves.toBe(
			SIDECAR_BODY,
		);
	});

	// The store's own move fires the vault's rename event a second time,
	// for the sidecar. Read as a recording, it would be moved again under a
	// doubled suffix; read as a transcript output, it would send the store
	// rewriting sidecars for it. Either would leave the vault holding
	// something other than these two files.
	it('leaves exactly the moved recording and its sidecar behind', async () => {
		const { app, audio } = createSut();

		await asMockApp(app).vault.rename(audio, MOVED_AUDIO);
		await waitFor(() => app.vault.getFileByPath(MOVED_SIDECAR) !== null, {
			message: 'the sidecar never followed the recording',
		});

		expect(vaultPaths(app)).toEqual([MOVED_AUDIO, MOVED_SIDECAR]);
	});

	it('reports no sidecar failure along the way', async () => {
		const { app, audio, warn } = createSut();

		await asMockApp(app).vault.rename(audio, MOVED_AUDIO);
		await waitFor(() => app.vault.getFileByPath(MOVED_SIDECAR) !== null, {
			message: 'the sidecar never followed the recording',
		});

		expect(warn).not.toHaveBeenCalledWith(
			expect.stringMatching(/sidecar/i),
			expect.anything(),
		);
	});
});

describe('a recording with markers, deleted in the vault', () => {
	it('sends its sidecar to the trash with it', async () => {
		const { app, audio, sidecar } = createSut();
		const { fileManager } = asMockApp(app);

		await fileManager.trashFile(audio);
		await waitFor(() => app.vault.getFileByPath(SIDECAR) === null, {
			message: 'the sidecar outlived its recording',
		});

		expect(fileManager.trashFile).toHaveBeenCalledWith(sidecar);
	});
});
