/**
 * Pop-out window context-menu regression guard. The headline symptom of issue
 * #12 is that the audio player's right-click menu ("Delete recording", "Audio
 * file info") stops appearing once a note is moved into a pop-out window. This
 * drives the REAL ContextMenu through the REAL registerDomEventOnAllWindows
 * primitive against a second document and asserts that a contextmenu event
 * there still resolves the recording and shows the plugin menu. It does NOT
 * mock the primitive, because the point is that the real per-window binding
 * reaches the pop-out's own document.
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian';
import { ContextMenu } from 'src/actions/ContextMenu';
import type { ActionServices } from 'src/actions/core/actionServices';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { registeredMenus } from '../helpers/menuFamilies';
import { menuInstances } from '../mocks/obsidian';
import {
	FakePlugin,
	makeApp,
	makeFile,
	makePopoutDoc,
} from '../helpers/popoutHarness';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { partial } from '../helpers/doubles';
import { mountLiveEditor, rangeOf } from '../helpers/liveEditor';
import { partialPlugin } from '../helpers/obsidianMock';

afterEach(() => {
	document.body.innerHTML = '';
});

/**
 * A loaded plugin with the context menu registered, and a pop-out window
 * opened after load, so the primitive has to bind the contextmenu handler to
 * that separate document.
 * @returns The app, the recording links resolve to, and the pop-out document
 */
function createSut(): { app: App; file: TFile; popoutDoc: Document } {
	const file = makeFile();
	const plugin = new FakePlugin();
	plugin.app = makeApp(plugin, file);
	// The player menu renders the file actions, which read the settings to
	// decide what is offered; nothing else of the services is reached.
	const services = partial<ActionServices>({
		app: plugin.app,
		getSettings: () => DEFAULT_SETTINGS,
	});
	const { registry, families } = registeredMenus(services);
	const contextMenu = new ContextMenu(
		partialPlugin(plugin),
		services,
		registry,
		families,
	);
	// Load first so the primitive's per-window child components attach their
	// listeners immediately.
	plugin.load();
	contextMenu.register();
	const popoutDoc = makePopoutDoc();
	plugin.emit('window-open', popoutDoc);
	return { app: plugin.app, file, popoutDoc };
}

describe('context menu works inside a pop-out window', () => {
	it('shows the player menu from a right-click in the pop-out document', () => {
		const { app, file, popoutDoc } = createSut();
		const embed = popoutDoc.createElement('div');
		embed.className = 'internal-embed';
		embed.setAttribute('src', 'rec.mp4');
		popoutDoc.body.appendChild(embed);
		const event = new MouseEvent('contextmenu', { bubbles: true });

		embed.dispatchEvent(event);

		// The right-click reached the handler bound to the pop-out's own
		// document, resolved the recording, and showed the menu.
		expect(app.workspace.trigger).toHaveBeenCalledWith(
			'file-menu',
			expect.anything(),
			file,
			'audio-recorder-player-context-menu',
		);
		// Opened from the event, which carries the pop-out's window, rather
		// than at page coordinates Obsidian would apply to the main window.
		expect(at(menuInstances, 0).shownAtEvent).toBe(event);
	});

	it('deletes the link the embed was rendered from in the pop-out note', async () => {
		const { app, file, popoutDoc } = createSut();
		const source = 'Intro\nSee ![[rec.mp4]] here';
		const live = mountLiveEditor({
			doc: source,
			file: partial<TFile>({ path: 'popout.md' }),
			parent: popoutDoc.body.appendChild(popoutDoc.createElement('div')),
			embeds: [{ ...rangeOf(source, '![[rec.mp4]]'), src: 'rec.mp4' }],
		});
		at(live.embeds(), 0).dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true }),
		);

		at(menuInstances, 0).click('Delete recording & link to file');
		await tick();

		expect(app.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(live.text()).toBe('Intro\nSee  here');
	});
});
