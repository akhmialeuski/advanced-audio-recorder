/**
 * Pop-out window playback regression guard. A note moved into an Obsidian
 * pop-out lives in a separate `document` whose events never bubble into the
 * main window, so a handler bound once to activeDocument silently dies there -
 * the cause of the "timecode click stops working in a pop-out" half of the
 * bug. This drives the REAL EnhancedPlayerRegistrar, its REAL
 * AudioPlayerRegistry, a REAL AudioPlayer, and the REAL
 * registerDomEventOnAllWindows primitive against a second document standing in
 * for the pop-out, and proves a timecode click there seeks the popped-out
 * embed. It deliberately does NOT mock the primitive (unlike the registrar
 * unit tests), because the whole point is that the real per-window binding
 * reaches the pop-out.
 * @jest-environment jsdom
 */

import { Component } from 'obsidian';
import { at } from '../helpers/assertions';
// Mock-only surface: these exist on the test double, not on Obsidian's
// API, so they are imported from the mock by path. Jest maps 'obsidian'
// to the same module, so both imports share one instance.
import { addObsidianDomExtensions } from '../mocks/obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import {
	installSharedAudio,
	makeMarkerStore,
	timeText,
	tick,
} from '../helpers/playbackHarness';
import {
	FakePlugin,
	makeApp,
	makeFile,
	makePopoutDoc,
	makePopoutLivePreview,
} from '../helpers/popoutHarness';
import { partialPlugin } from '../helpers/obsidianMock';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('timecode clicks work inside a pop-out window', () => {
	it('seeks the popped-out embed from a timecode link in its own document', async () => {
		const shared = installSharedAudio();
		try {
			const file = makeFile();
			const plugin = new FakePlugin();
			plugin.app = makeApp(plugin, file);
			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				enhancedPlayerEnabled: true,
				playerShowWaveform: false,
				playerEnableMarkers: false,
			};

			const registrar = new EnhancedPlayerRegistrar(
				partialPlugin(plugin),
				plugin.app,
				() => settings,
				makeMarkerStore(),
				null,
			);
			// The plugin must be loaded so the primitive's per-window child
			// components load (and thus attach their listeners) at once.
			plugin.load();
			registrar.register();

			// A pop-out window opens after load: the primitive must bind the
			// timecode click handler to its separate document.
			const popoutDoc = makePopoutDoc();
			plugin.emit('window-open', popoutDoc);

			// Obsidian renders the note's embed inside the pop-out document.
			const section = addObsidianDomExtensions(
				popoutDoc.createElement('div'),
			);
			popoutDoc.body.appendChild(section);
			const embed = addObsidianDomExtensions(
				popoutDoc.createElement('div'),
			);
			embed.className = 'internal-embed is-loaded';
			embed.setAttribute('src', 'rec.mp4');
			section.appendChild(embed);

			// Drive the registrar's real post-processor to mount a real player
			// into the pop-out embed, joined to the registrar's own registry.
			const ctx = {
				sourcePath: 'note.md',
				addChild: (child: Component) => child.load(),
			} as unknown as MarkdownPostProcessorContext;
			void at(plugin.postProcessors, 0)(section, ctx);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			// A transcript timestamp clicked in the pop-out document.
			const link = popoutDoc.createElement('a');
			link.className = 'internal-link';
			link.setAttribute('data-href', 'rec.mp4#t=90');
			popoutDoc.body.appendChild(link);
			link.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			// The click reached the handler bound to the pop-out's own document
			// and seeked the embed there - it shows 1:30, not a dead 0:00.
			expect(timeText(embed)).toBe('1:30 / 10:00');
			expect(shared.audio.paused).toBe(false);
		} finally {
			shared.restore();
		}
	});

	it('seeks the popped-out embed from a Live Preview timecode link resolved against its own note', async () => {
		const shared = installSharedAudio();
		try {
			const file = makeFile();
			const plugin = new FakePlugin();
			plugin.app = makeApp(plugin, file);
			// The recording resolves only against the popped-out note. Resolving
			// against the active note (a different file) would return null, so a
			// passing seek proves the click used the owning view, not the active
			// one. Without the window-scoped fix, both the editor lookup (active
			// view is null) and the source-path lookup (active file is note.md)
			// miss and the embed stays dead at 0:00.
			plugin.app.metadataCache.getFirstLinkpathDest = (
				linkPath: string,
				sourcePath: string,
			) =>
				linkPath.startsWith('rec') && sourcePath === 'popout-note.md'
					? file
					: null;

			const settings: AudioRecorderSettings = {
				...DEFAULT_SETTINGS,
				enhancedPlayerEnabled: true,
				playerShowWaveform: false,
				playerEnableMarkers: false,
			};

			const registrar = new EnhancedPlayerRegistrar(
				partialPlugin(plugin),
				plugin.app,
				() => settings,
				makeMarkerStore(),
				null,
			);
			plugin.load();
			registrar.register();

			const popoutDoc = makePopoutDoc();
			plugin.emit('window-open', popoutDoc);

			// The popped-out note in Live Preview: a MarkdownView whose editor
			// resolves the wikilink from source, registered as an open leaf.
			const { linkToken, embedHost, embed } = makePopoutLivePreview(
				plugin,
				popoutDoc,
				'popout-note.md',
				'[[rec.mp4#t=90|1:30]] Speaker 1',
			);

			// Mount a real player into the pop-out embed so a seek has a display.
			const ctx = {
				sourcePath: 'popout-note.md',
				addChild: (child: Component) => child.load(),
			} as unknown as MarkdownPostProcessorContext;
			void at(plugin.postProcessors, 0)(embedHost, ctx);
			await tick();
			shared.audio.setReady(1);
			shared.audio.setDuration(600);

			// The Live Preview wikilink clicked in the pop-out, while the active
			// view is null and the active file is a different, main-window note.
			linkToken.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			// The editor target and the source path both resolved against the
			// popped-out note, so the click seeked the embed there to 1:30.
			expect(timeText(embed)).toBe('1:30 / 10:00');
			expect(shared.audio.paused).toBe(false);
		} finally {
			shared.restore();
		}
	});
});
