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

import { Menu } from 'obsidian';
import type { Plugin } from 'obsidian';
import { ContextMenu } from 'src/ui/ContextMenu';
import { FILE_ACTIONS } from 'src/actions/fileActions';
import type { ActionServices } from 'src/actions/PluginAction';
import {
	FakePlugin,
	makeApp,
	makeFile,
	makePopoutDoc,
} from '../helpers/popoutHarness';

afterEach(() => {
	document.body.innerHTML = '';
	jest.restoreAllMocks();
});

describe('context menu works inside a pop-out window', () => {
	it('shows the player menu from a right-click in the pop-out document', () => {
		const showAtPosition = jest.spyOn(Menu.prototype, 'showAtPosition');
		const file = makeFile();
		const plugin = new FakePlugin();
		plugin.app = makeApp(plugin, file);
		// registerPlayerMenu only reads services.app; the rest is unused because
		// the file-menu is populated by other plugins, not this handler.
		const services = { app: plugin.app } as unknown as ActionServices;

		const contextMenu = new ContextMenu(
			plugin as unknown as Plugin,
			services,
			FILE_ACTIONS,
		);
		// Load first so the primitive's per-window child components attach their
		// listeners immediately.
		plugin.load();
		contextMenu.register();

		// A pop-out window opens after load: the primitive must bind the
		// contextmenu handler to its separate document.
		const popoutDoc = makePopoutDoc();
		plugin.emit('window-open', popoutDoc);

		// The note's audio embed rendered inside the pop-out document.
		const embed = popoutDoc.createElement('div');
		embed.className = 'internal-embed';
		embed.setAttribute('src', 'rec.mp4');
		popoutDoc.body.appendChild(embed);

		embed.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

		// The right-click reached the handler bound to the pop-out's own
		// document, resolved the recording, and showed the menu.
		expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
			'file-menu',
			expect.anything(),
			file,
			'audio-recorder-player-context-menu',
		);
		expect(showAtPosition).toHaveBeenCalled();
	});
});
