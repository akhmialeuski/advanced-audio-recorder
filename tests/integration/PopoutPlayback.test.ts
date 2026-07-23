/**
 * Pop-out window regression guard. A note moved into an Obsidian pop-out lives
 * in a separate `document` whose events never bubble into the main window, so a
 * handler bound once to activeDocument silently dies there - the exact cause of
 * the "context menu / timecode click stops working in a pop-out" bug. These
 * tests drive the REAL EnhancedPlayerRegistrar, its REAL AudioPlayerRegistry,
 * a REAL AudioPlayer, and the REAL registerDomEventOnAllWindows primitive, all
 * against a second jsdom document standing in for the pop-out, and prove a
 * timecode click there still seeks the popped-out embed. It deliberately does
 * NOT mock the primitive (unlike the registrar unit tests), because the whole
 * point is that the real per-window binding reaches the pop-out.
 * @jest-environment jsdom
 */

import { Component, TFile, addObsidianDomExtensions } from 'obsidian';
import type {
	App,
	MarkdownPostProcessor,
	MarkdownPostProcessorContext,
	Plugin,
	WorkspaceLeaf,
} from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';

/** Controllable audio element whose setters emit the matching media events. */
interface ControllableAudio extends HTMLAudioElement {
	setReady(value: number): void;
	setDuration(value: number): void;
}

/**
 * Installs one deterministic audio element as the global Audio factory, so the
 * registry's `new Audio()` and the player bind to the same element (mirrors the
 * PlaybackSync harness).
 */
function installSharedAudio(): { audio: ControllableAudio; restore(): void } {
	const el = document.createElement('audio') as ControllableAudio;
	let paused = true;
	let currentTime = 0;
	let duration = NaN;
	let ready = 0;
	Object.defineProperties(el, {
		paused: { configurable: true, get: () => paused },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value;
				el.dispatchEvent(new Event('timeupdate'));
			},
		},
		duration: { configurable: true, get: () => duration },
		readyState: { configurable: true, get: () => ready },
	});
	jest.spyOn(el, 'play').mockImplementation(() => {
		paused = false;
		el.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	jest.spyOn(el, 'pause').mockImplementation(() => {
		paused = true;
		el.dispatchEvent(new Event('pause'));
	});
	jest.spyOn(el, 'load').mockImplementation(() => undefined);
	el.setReady = (value: number) => {
		ready = value;
	};
	el.setDuration = (value: number) => {
		duration = value;
		el.dispatchEvent(new Event('durationchange'));
	};
	const factory = jest
		.spyOn(globalThis, 'Audio')
		.mockImplementation(() => el);
	return { audio: el, restore: () => factory.mockRestore() };
}

/**
 * The audio file every embed and link in these tests resolves to. Built on
 * the TFile prototype so the registrar's `instanceof TFile` guards pass.
 */
function makeFile(): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path: 'rec.mp4',
		basename: 'rec',
		extension: 'mp4',
		stat: { mtime: 1, size: 1000 },
	}) as TFile;
}

/** An in-memory sidecar store the player can read without persistence. */
function makeMarkerStore(): RecordingSidecarStore {
	return {
		getMarkers: jest.fn(() => Promise.resolve([] as PlayerMarker[])),
		updateMarkers: jest.fn((_path, change) =>
			Promise.resolve([...change([])]),
		),
		handleRename: jest.fn().mockResolvedValue(undefined),
		handleOutputRename: jest.fn().mockResolvedValue(undefined),
		handleDelete: jest.fn().mockResolvedValue(undefined),
		clearCache: jest.fn(),
	} as unknown as RecordingSidecarStore;
}

/** A pop-out-like window handle, as workspace window events carry it. */
interface WindowLike {
	doc: Document;
}

/**
 * A plugin double built on the real Component (so addChild/removeChild and
 * registerDomEvent attach and detach listeners for real), exposing the
 * post-processor and the workspace window callbacks the test drives.
 */
class FakePlugin extends Component {
	readonly postProcessors: MarkdownPostProcessor[] = [];
	readonly windowListeners: Record<string, (win: WindowLike) => void> = {};
	app!: App;

	registerMarkdownPostProcessor(
		processor: MarkdownPostProcessor,
	): MarkdownPostProcessor {
		this.postProcessors.push(processor);
		return processor;
	}

	/** Fires a recorded workspace window event, as Obsidian would. */
	emit(name: 'window-open' | 'window-close', doc: Document): void {
		this.windowListeners[name]?.({ doc });
	}
}

/** Builds the app double the registrar and player read from. */
function makeApp(plugin: FakePlugin, file: TFile): App {
	return {
		vault: {
			getResourcePath: () => 'app://media',
			readBinary: () => Promise.resolve(new ArrayBuffer(0)),
			getFileByPath: () => file,
			on: () => ({}),
		},
		metadataCache: {
			getFirstLinkpathDest: (linkPath: string) =>
				linkPath.startsWith('rec') ? file : null,
		},
		workspace: {
			getActiveFile: () => ({ path: 'note.md' }),
			getActiveViewOfType: () => null,
			getLeavesOfType: () => [] as WorkspaceLeaf[],
			iterateAllLeaves: () => undefined,
			on: (name: string, cb: (win: WindowLike) => void) => {
				plugin.windowListeners[name] = cb;
				return {};
			},
		},
	} as unknown as App;
}

/** Reads the elapsed / total text the player renders. */
function timeText(container: HTMLElement): string {
	return container.querySelector('.aar-player-time')?.textContent ?? '';
}

const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	document.body.innerHTML = '';
	jest.restoreAllMocks();
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
				plugin as unknown as Plugin,
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
			const popoutDoc =
				document.implementation.createHTMLDocument('popout');
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
			void plugin.postProcessors[0](section, ctx);
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
});
