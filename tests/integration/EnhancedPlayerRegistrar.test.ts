/**
 * Regression guard for two recurring defect families in the enhanced
 * player integration:
 *
 * 1. "settings apply in one view mode but not the other" / "video shows
 *    twice in Live Preview": the registrar is the single decision point -
 *    it returns Obsidian's OWN native embed (unwrapped) for anything it
 *    knows it will not enhance, the enhanced player for known audio, and
 *    applies the master toggle by re-rendering through Obsidian's own
 *    pipeline.
 *
 * 2. Issue #39, "background media probe triggers a full note rebuild":
 *    a probe verdict must NEVER re-render a note. A not-yet-probed file
 *    renders inside a MediaEmbedShell that upgrades this one embed to the
 *    enhanced player in place; leaf.rebuildView() is reserved for the
 *    master toggle flip alone. These tests fail on the previous design,
 *    which upgraded probed files by rebuilding the embedding leaves.
 */

import { Component, MarkdownView, TFile } from 'obsidian';
import { at } from '../helpers/assertions';
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { MediaEmbedShell } from 'src/player/MediaEmbedShell';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import { DetachedPlayback } from 'src/player/DetachedPlayback';
import { probeMediaKind, MEDIA_KIND } from 'src/player/mediaProbe';
import type { MediaKind, MediaProbeResult } from 'src/player/mediaProbe';
import type { MediaKindStore } from 'src/player/MediaKindStore';
import { AUDIO_EXTENSIONS } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { EmbedInfo } from 'src/obsidian/embedRegistry';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';

jest.mock('src/player/AudioPlayer', () => ({
	AudioPlayer: jest.fn().mockImplementation(() => ({
		__enhanced: true,
		load: jest.fn(),
		unload: jest.fn(),
		loadFile: jest.fn(),
	})),
}));

// The timecode click handler binds through registerDomEventOnAllWindows (one
// listener per Obsidian window). These tests exercise the handler itself, so
// the primitive is mocked to capture the registered handler; its cross-window
// behavior is covered in tests/unit/multiWindowDomEvents.test.ts and the
// pop-out integration test.
jest.mock('src/utils/multiWindowDomEvents', () => ({
	registerDomEventOnAllWindows: jest.fn(),
}));

jest.mock('src/player/mediaProbe', () => ({
	...jest.requireActual('src/player/mediaProbe'),
	probeMediaKind: jest.fn(),
}));

jest.mock('src/player/DetachedPlayback', () => ({
	DetachedPlayback: { start: jest.fn() },
}));

const probeMock = jest.mocked(probeMediaKind);
const audioPlayerMock = jest.mocked(AudioPlayer);
const detachedStartMock = jest.mocked(DetachedPlayback.start);

/** Mirrors RERENDER_DEBOUNCE_MS in src/player/EnhancedPlayerRegistrar.ts. */
const RERENDER_DEBOUNCE_MS = 50;

/** Builds a probe result; probes are confident unless stated otherwise. */
function probeResult(kind: MediaKind, confident = true): MediaProbeResult {
	return { kind, confident };
}

/**
 * Resolves after the probe microtasks and the re-render debounce.
 *
 * Fake timers rather than a real sleep: the debounce is 50 ms, and a fixed
 * wait long enough on an idle machine is a coin flip on a loaded one.
 * advanceTimersByTimeAsync moves the clock past the debounce and drains the
 * microtasks the probe queues, in a fixed number of steps every time.
 */
function flush(): Promise<void> {
	return jest.advanceTimersByTimeAsync(RERENDER_DEBOUNCE_MS * 2);
}

/**
 * A native embed instance: a real Component (so a shell can host and
 * unload it) tagged with the extension that produced it.
 */
class NativeEmbed extends Component {
	readonly __native: string;
	/** Set when the shell (or Obsidian) unloaded this embed. */
	unloaded = false;
	readonly loadFile = jest.fn();

	constructor(extension: string) {
		super();
		this.__native = extension;
	}

	override onunload(): void {
		this.unloaded = true;
	}
}

/** The mocked enhanced-player instance shape. */
interface EnhancedInstance {
	__enhanced: boolean;
	load: jest.Mock;
	loadFile: jest.Mock;
}

/** Builds a MarkdownView stub for a given mode with re-render spies. */
function viewStub(
	mode: 'preview' | 'source',
	notePath = 'note.md',
): MarkdownView {
	const currentMode = {
		get: jest.fn(() => 'content'),
		set: jest.fn(),
		getScroll: jest.fn(() => 7),
		applyScroll: jest.fn(),
	};
	return Object.assign(Object.create(MarkdownView.prototype), {
		getMode: () => mode,
		previewMode: { rerender: jest.fn() },
		currentMode,
		file: { path: notePath },
	});
}

/** A fully mocked persistent media-kind store. */
function kindStoreStub(): jest.Mocked<
	Pick<
		MediaKindStore,
		'load' | 'get' | 'set' | 'handleRename' | 'handleDelete' | 'flush'
	>
> {
	return {
		load: jest.fn().mockResolvedValue(undefined),
		get: jest.fn().mockReturnValue(null),
		set: jest.fn(),
		handleRename: jest.fn(),
		handleDelete: jest.fn(),
		flush: jest.fn(),
	};
}

/**
 * Builds a registrar wired to fakes and registers it. Returns the installed
 * embed creator plus the spies needed to assert behaviour.
 */
function setup(
	enabled = true,
	kindStore: ReturnType<typeof kindStoreStub> | null = null,
): {
	registrar: EnhancedPlayerRegistrar;
	creator: (info: EmbedInfo, file: TFile, subpath: string) => unknown;
	nativeCreator: jest.Mock;
	settings: AudioRecorderSettings;
	leaves: { preview: WorkspaceLeaf; source: WorkspaceLeaf };
	getLeaves: jest.Mock;
	plugin: Plugin;
	app: App;
	markerStore: {
		handleRename: jest.Mock;
		handleDelete: jest.Mock;
		handleOutputRename: jest.Mock;
		clearCache: jest.Mock;
	};
} {
	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		enhancedPlayerEnabled: enabled,
	};

	const nativeCreator = jest.fn(
		(_info: EmbedInfo, file: TFile): NativeEmbed =>
			new NativeEmbed(file.extension),
	);

	const embedByExtension: Record<string, unknown> = {};
	for (const ext of AUDIO_EXTENSIONS) {
		embedByExtension[ext] = nativeCreator;
	}

	const previewLeaf = {
		view: viewStub('preview', 'note.md'),
		rebuildView: jest.fn(),
	} as unknown as WorkspaceLeaf;
	const sourceLeaf = {
		view: viewStub('source', 'other.md'),
		rebuildView: jest.fn(),
	} as unknown as WorkspaceLeaf;
	const getLeaves = jest.fn(() => [previewLeaf, sourceLeaf]);

	const app = {
		embedRegistry: { embedByExtension },
		vault: {
			getResourcePath: () => 'app://media',
			getFileByPath: (path: string) => fileFromPath(path),
			on: jest.fn(() => ({})),
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [] }),
			getFirstLinkpathDest: (linkPath: string) => fileFromPath(linkPath),
		},
		workspace: {
			getActiveFile: () => ({ path: 'note.md' }),
			getLeavesOfType: getLeaves,
			getActiveViewOfType: jest.fn(() => null),
			// The timecode resolver locates the note owning the clicked node
			// across windows; no leaf owns the detached test nodes, so the
			// lookup finds nothing and falls back to the active view/file.
			iterateAllLeaves: jest.fn(),
		},
	} as unknown as App;

	const plugin = {
		registerMarkdownPostProcessor: jest.fn(),
		registerDomEvent: jest.fn(),
		registerEvent: jest.fn(),
	} as unknown as Plugin;

	const markerStore = {
		handleRename: jest.fn().mockResolvedValue(undefined),
		handleDelete: jest.fn().mockResolvedValue(undefined),
		handleOutputRename: jest.fn().mockResolvedValue(undefined),
		clearCache: jest.fn(),
	};

	const registrar = new EnhancedPlayerRegistrar(
		plugin,
		app,
		() => settings,
		markerStore as unknown as RecordingSidecarStore,
		kindStore as unknown as MediaKindStore | null,
	);
	registrar.register();

	const creator = embedByExtension['mp4'] as (
		info: EmbedInfo,
		file: TFile,
		subpath: string,
	) => unknown;

	return {
		registrar,
		creator,
		nativeCreator,
		settings,
		leaves: { preview: previewLeaf, source: sourceLeaf },
		getLeaves,
		plugin,
		app,
		markerStore,
	};
}

function fileFromPath(path: string): TFile {
	const extension = path.split('.').pop() ?? '';
	return Object.assign(Object.create(TFile.prototype), {
		path,
		extension,
	}) as TFile;
}

function fileOf(extension: string): TFile {
	return fileFromPath(`recording.${extension}`);
}

function embedInfo(): EmbedInfo {
	return {
		containerEl: document.createElement('div'),
		sourcePath: 'note.md',
	};
}

const info: EmbedInfo = {
	containerEl: document.createElement('div'),
	sourcePath: 'note.md',
};

beforeEach(() => {
	jest.useFakeTimers();
	probeMock.mockReset();
	audioPlayerMock.mockClear();
	detachedStartMock.mockReset();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('EnhancedPlayerRegistrar embed creation', () => {
	it('hosts the native embed in a shell while a file is unprobed (never trusts the extension)', () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { creator, nativeCreator } = setup(true);

		// A wav can in principle carry a video track, so it must be probed,
		// not enhanced on faith: the native embed shows while the probe runs
		const result = creator(info, fileOf('wav'), '');

		expect(result).toBeInstanceOf(MediaEmbedShell);
		expect(nativeCreator).toHaveBeenCalledTimes(1);
		expect(probeMock).toHaveBeenCalledTimes(1);
		// The player is not built before the probe settles
		expect(audioPlayerMock).not.toHaveBeenCalled();
	});

	it('upgrades the embed IN PLACE when the probe finds audio - no note re-render (issue #39)', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { creator, nativeCreator, getLeaves, leaves } = setup(true);

		const shell = creator(info, fileOf('wav'), '') as Component;
		shell.load();

		await flush();

		// The shell swapped this one embed: the native child was unloaded
		// (stopping any playback) and the player took over the container
		const native = at(nativeCreator.mock.results, 0).value as NativeEmbed;
		expect(native.unloaded).toBe(true);
		expect(audioPlayerMock).toHaveBeenCalledTimes(1);
		const player = at(audioPlayerMock.mock.results, 0)
			.value as unknown as EnhancedInstance;
		expect(player.load).toHaveBeenCalled();
		// The core of issue #39: no leaf was inspected or rebuilt, so a
		// large embedding note is never re-rendered by a probe verdict
		expect(getLeaves).not.toHaveBeenCalled();
		expect(
			(leaves.preview as unknown as { rebuildView: jest.Mock })
				.rebuildView,
		).not.toHaveBeenCalled();
	});

	it('keeps the native embed for a video file - no player, no re-render', async () => {
		probeMock.mockResolvedValue(probeResult('video'));
		const { creator, nativeCreator, getLeaves } = setup(true);

		const shell = creator(info, fileOf('mp4'), '') as Component;
		shell.load();

		await flush();

		const native = at(nativeCreator.mock.results, 0).value as NativeEmbed;
		expect(native.unloaded).toBe(false);
		expect(audioPlayerMock).not.toHaveBeenCalled();
		expect(getLeaves).not.toHaveBeenCalled();
	});

	it("returns Obsidian's own native embed unwrapped once a file is known video (no wrapper, no double)", async () => {
		probeMock.mockResolvedValue(probeResult('video'));
		const { creator } = setup(true);

		creator(info, fileOf('mp4'), '');
		await flush();

		// The kind is cached now: the next render gets exactly what Obsidian
		// renders on its own, so Live Preview cannot double it
		const second = creator(info, fileOf('mp4'), '') as NativeEmbed;
		expect(second).toBeInstanceOf(NativeEmbed);
		expect(second.__native).toBe('mp4');
		expect(probeMock).toHaveBeenCalledTimes(1);
	});

	it('renders enhanced directly once a probe has classified the file as audio', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { creator } = setup(true);

		creator(info, fileOf('wav'), '');
		await flush();
		probeMock.mockClear();

		// A later render of the same file is enhanced from the start, with
		// no further probe and no shell
		const second = creator(info, fileOf('wav'), '') as {
			__enhanced?: boolean;
		};
		expect(second.__enhanced).toBe(true);
		expect(probeMock).not.toHaveBeenCalled();
	});

	it('returns the native embed for every file when the feature is disabled', () => {
		const { creator } = setup(false);

		const result = creator(info, fileOf('wav'), '') as NativeEmbed;

		expect(result).toBeInstanceOf(NativeEmbed);
		expect(result.__native).toBe('wav');
		expect(probeMock).not.toHaveBeenCalled();
		expect(audioPlayerMock).not.toHaveBeenCalled();
	});

	it('shares one probe across multiple embeds of the same file and upgrades each in place', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { creator } = setup(true);

		const first = creator(embedInfo(), fileOf('wav'), '') as Component;
		const second = creator(embedInfo(), fileOf('wav'), '') as Component;
		expect(probeMock).toHaveBeenCalledTimes(1);
		first.load();
		second.load();

		await flush();

		expect(audioPlayerMock).toHaveBeenCalledTimes(2);
	});

	it('does not swap after the embed was unloaded (note closed mid-probe)', async () => {
		let resolveProbe!: (result: MediaProbeResult) => void;
		probeMock.mockImplementation(
			() =>
				new Promise<MediaProbeResult>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const { creator } = setup(true);

		const shell = creator(info, fileOf('wav'), '') as Component;
		shell.load();
		shell.unload();
		resolveProbe(probeResult('audio'));

		await flush();

		expect(audioPlayerMock).not.toHaveBeenCalled();
	});

	it('does not swap when the feature was disabled while the probe ran', async () => {
		let resolveProbe!: (result: MediaProbeResult) => void;
		probeMock.mockImplementation(
			() =>
				new Promise<MediaProbeResult>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const { creator, settings } = setup(true);

		const shell = creator(info, fileOf('wav'), '') as Component;
		shell.load();
		settings.enhancedPlayerEnabled = false;
		resolveProbe(probeResult('audio'));

		await flush();

		expect(audioPlayerMock).not.toHaveBeenCalled();
	});

	it('forwards loadFile to the hosted embed and replays it after the swap', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { creator, nativeCreator } = setup(true);

		const shell = creator(info, fileOf('wav'), '') as MediaEmbedShell;
		shell.load();
		const file = fileOf('wav');
		void shell.loadFile(file);

		const native = at(nativeCreator.mock.results, 0).value as NativeEmbed;
		expect(native.loadFile).toHaveBeenCalledWith(file);

		await flush();

		// Live Preview drove the old child through loadFile, so the new
		// child gets the same call and renders
		const player = at(audioPlayerMock.mock.results, 0)
			.value as unknown as EnhancedInstance;
		expect(player.loadFile).toHaveBeenCalledWith(file);
	});
});

describe('EnhancedPlayerRegistrar re-renders only when needed', () => {
	it('rebuilds open views when the master toggle flips', async () => {
		const { registrar, leaves, getLeaves, settings } = setup(true);

		// Flip the only render-affecting setting
		settings.enhancedPlayerEnabled = false;
		registrar.refresh();
		await flush();

		expect(getLeaves).toHaveBeenCalledWith('markdown');
		// Both modes rebuild through the same path, which unloads the old
		// embeds (so no stale media keeps playing)
		expect(
			(leaves.preview as unknown as { rebuildView: jest.Mock })
				.rebuildView,
		).toHaveBeenCalledTimes(1);
		expect(
			(leaves.source as unknown as { rebuildView: jest.Mock })
				.rebuildView,
		).toHaveBeenCalledTimes(1);
	});

	it('does NOT re-render when the enabled state is unchanged (no lag)', async () => {
		const { registrar, getLeaves } = setup(true);

		// A settings save that did not flip the toggle must not touch views
		registrar.refresh();
		registrar.refresh();
		await flush();

		expect(getLeaves).not.toHaveBeenCalled();
	});

	it('does NOT re-apply the layout to players when no player window changed', () => {
		const applySpy = jest.spyOn(
			AudioPlayerRegistry.prototype,
			'applySettings',
		);
		try {
			const { registrar } = setup(true);
			// A save that did not change a player window
			registrar.refresh();
			expect(applySpy).not.toHaveBeenCalled();
		} finally {
			applySpy.mockRestore();
		}
	});

	it('re-applies the layout to players only when a player window changed', () => {
		const applySpy = jest.spyOn(
			AudioPlayerRegistry.prototype,
			'applySettings',
		);
		try {
			const { registrar, settings } = setup(true);
			settings.playerShowWaveform = !settings.playerShowWaveform;
			registrar.refresh();
			expect(applySpy).toHaveBeenCalledTimes(1);
		} finally {
			applySpy.mockRestore();
		}
	});

	it('primes a saved recording so its embed is enhanced from the start - still no re-render', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { registrar, creator, getLeaves } = setup(true);

		registrar.primeSavedRecordingsForEnhancement(['recording.wav']);
		expect(probeMock).toHaveBeenCalledTimes(1);
		await flush();

		// The kind was probed before Obsidian ever created the embed, so
		// the embed is built enhanced directly - no native pass, no swap
		const embed = creator(info, fileOf('wav'), '') as {
			__enhanced?: boolean;
		};
		expect(embed.__enhanced).toBe(true);
		expect(probeMock).toHaveBeenCalledTimes(1);
		expect(getLeaves).not.toHaveBeenCalled();
	});
});

describe('EnhancedPlayerRegistrar persistent media kinds', () => {
	it('forwards playback subscriptions to the shared registry', () => {
		const subscribe = jest.spyOn(
			AudioPlayerRegistry.prototype,
			'subscribePlayback',
		);
		try {
			const { registrar } = setup(true);
			const listener = jest.fn();

			registrar.subscribePlayback(listener);

			expect(subscribe).toHaveBeenCalledWith(listener);
		} finally {
			subscribe.mockRestore();
		}
	});

	it('loads the persisted store on register', () => {
		const kindStore = kindStoreStub();
		setup(true, kindStore);

		expect(kindStore.load).toHaveBeenCalledTimes(1);
	});

	it('renders enhanced immediately when the store knows the file is audio (no probe, no swap)', () => {
		const kindStore = kindStoreStub();
		kindStore.get.mockReturnValue('audio');
		const { creator } = setup(true, kindStore);

		const embed = creator(info, fileOf('wav'), '') as {
			__enhanced?: boolean;
		};

		expect(embed.__enhanced).toBe(true);
		expect(probeMock).not.toHaveBeenCalled();
	});

	it('persists a confident probe result', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const kindStore = kindStoreStub();
		const { creator } = setup(true, kindStore);

		const shell = creator(info, fileOf('wav'), '') as Component;
		shell.load();
		await flush();

		expect(kindStore.set).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'recording.wav' }),
			'audio',
		);
	});

	it('does NOT persist a timeout fallback, but still upgrades this session', async () => {
		probeMock.mockResolvedValue(probeResult('audio', false));
		const kindStore = kindStoreStub();
		const { creator } = setup(true, kindStore);

		const shell = creator(info, fileOf('wav'), '') as Component;
		shell.load();
		await flush();

		// A slow-loading video must not be remembered as audio forever
		expect(kindStore.set).not.toHaveBeenCalled();
		expect(audioPlayerMock).toHaveBeenCalledTimes(1);
	});

	it('flushes pending store writes on dispose', () => {
		const kindStore = kindStoreStub();
		const { registrar } = setup(true, kindStore);

		registrar.dispose();

		expect(kindStore.flush).toHaveBeenCalledTimes(1);
	});
});

describe('EnhancedPlayerRegistrar vault rename/delete wiring', () => {
	/** Returns a vault event handler the registrar installed on register. */
	function vaultHandler(
		app: App,
		event: 'rename' | 'delete',
	): (...args: unknown[]) => void {
		const call = (app.vault.on as unknown as jest.Mock).mock.calls.find(
			(args: unknown[]) => args[0] === event,
		);
		if (!call) {
			throw new Error(`Expected a vault ${event} handler registration`);
		}
		return call[1] as (...args: unknown[]) => void;
	}

	it('routes an audio rename to the sidecar move, never the output scan', () => {
		const kindStore = kindStoreStub();
		const { app, markerStore } = setup(true, kindStore);

		vaultHandler(app, 'rename')(fileFromPath('new.wav'), 'old.wav');

		expect(markerStore.handleRename).toHaveBeenCalledWith(
			'old.wav',
			'new.wav',
		);
		expect(markerStore.handleOutputRename).not.toHaveBeenCalled();
		expect(kindStore.handleRename).toHaveBeenCalledWith(
			'old.wav',
			'new.wav',
		);
	});

	it('routes a non-audio rename to the recorded-output update', () => {
		const { app, markerStore } = setup(true);

		vaultHandler(app, 'rename')(
			fileFromPath('archive/meeting.md'),
			'meeting.md',
		);

		expect(markerStore.handleOutputRename).toHaveBeenCalledWith(
			'meeting.md',
			'archive/meeting.md',
		);
		expect(markerStore.handleRename).not.toHaveBeenCalled();
	});

	it('ignores a rename of something that is not a file (folder)', () => {
		const { app, markerStore } = setup(true);

		vaultHandler(app, 'rename')({ path: 'folder-b' }, 'folder-a');

		expect(markerStore.handleRename).not.toHaveBeenCalled();
		expect(markerStore.handleOutputRename).not.toHaveBeenCalled();
	});

	it('removes the sidecar only for a deleted audio file', () => {
		const kindStore = kindStoreStub();
		const { app, markerStore } = setup(true, kindStore);
		const handler = vaultHandler(app, 'delete');

		handler(fileFromPath('rec.wav'));
		expect(markerStore.handleDelete).toHaveBeenCalledWith('rec.wav');
		expect(kindStore.handleDelete).toHaveBeenCalledWith('rec.wav');

		markerStore.handleDelete.mockClear();
		handler(fileFromPath('note.md'));
		handler({ path: 'folder' });
		expect(markerStore.handleDelete).not.toHaveBeenCalled();
	});
});

describe('EnhancedPlayerRegistrar timecode links', () => {
	/** Returns the document click handler the registrar installed on register. */
	function clickHandler(_plugin: Plugin): (event: MouseEvent) => void {
		const { registerDomEventOnAllWindows } = jest.requireMock(
			'src/utils/multiWindowDomEvents',
		);
		const call = (
			registerDomEventOnAllWindows as jest.Mock
		).mock.calls.find((args: unknown[]) => args[2] === 'click');
		if (!call) {
			throw new Error('Expected a click handler registration');
		}
		return call[3] as (event: MouseEvent) => void;
	}

	/** Builds a click event whose target is a timecode internal link. */
	function timecodeClick(href: string): MouseEvent {
		const anchor = document.createElement('a');
		anchor.className = 'internal-link';
		anchor.setAttribute('data-href', href);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: anchor });
		return event;
	}

	/** A detached-playback stub with the file path and spied commands. */
	function detachedStub(path: string): {
		path: string;
		seek: jest.Mock;
		dispose: jest.Mock;
	} {
		return { path, seek: jest.fn(), dispose: jest.fn() };
	}

	/**
	 * The same stub as a DetachedPlayback. The registrar only ever calls seek
	 * and dispose on it, so the cast at the boundary is what states that.
	 */
	function detachedStubOf(path: string): DetachedPlayback {
		return detachedStub(path) as unknown as DetachedPlayback;
	}

	it('seeks an on-screen player and never opens the file', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(true);
		try {
			const { plugin } = setup(true);
			const event = timecodeClick('rec.mp4#t=30');
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(seek).toHaveBeenCalledWith('rec.mp4', 30);
			expect(detachedStartMock).not.toHaveBeenCalled();
			expect(prevent).toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('plays from the timecode when no player is on screen', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		detachedStartMock.mockReturnValue(detachedStubOf('rec.mp4'));
		try {
			const { plugin } = setup(true);
			const event = timecodeClick('rec.mp4#t=30');
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(detachedStartMock).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ path: 'rec.mp4' }),
				30,
				expect.any(Function),
			);
			expect(prevent).toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('reuses the detached playback for another timestamp of the same file', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		const detached = detachedStub('rec.mp4');
		detachedStartMock.mockReturnValue(
			detached as unknown as DetachedPlayback,
		);
		try {
			const { plugin } = setup(true);
			const handle = clickHandler(plugin);

			handle(timecodeClick('rec.mp4#t=30'));
			handle(timecodeClick('rec.mp4#t=90'));

			expect(detachedStartMock).toHaveBeenCalledTimes(1);
			expect(detached.seek).toHaveBeenCalledWith(90);
		} finally {
			seek.mockRestore();
		}
	});

	it('ignores a timecode link to a non-audio file', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { plugin } = setup(true);
			const event = timecodeClick('notes.md#t=30');
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
			expect(prevent).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('leaves non-timecode links to Obsidian', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { plugin } = setup(true);
			const event = timecodeClick('rec.mp4');

			clickHandler(plugin)(event);

			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('does not intercept timecode links when the player is disabled', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { plugin } = setup(false);
			const event = timecodeClick('rec.mp4#t=30');

			clickHandler(plugin)(event);

			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	/** A Live Preview link element inside a CodeMirror editor (no data-href). */
	function livePreviewClick(): MouseEvent {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const linkEl = document.createElement('span');
		linkEl.className = 'cm-hmd-internal-link';
		editor.appendChild(linkEl);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: linkEl });
		return event;
	}

	/** Stubs the active editor so a click resolves to a source line. */
	function stubActiveEditor(app: App, line: string): void {
		const view = {
			editor: {
				cm: { posAtDOM: jest.fn(() => 5) },
				offsetToPos: jest.fn(() => ({ line: 0, ch: 5 })),
				getLine: jest.fn(() => line),
			},
		};
		(app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(view);
	}

	it('plays a Live Preview timecode link read from the editor source', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		detachedStartMock.mockReturnValue(detachedStubOf('rec.mp4'));
		try {
			const { plugin, app } = setup(true);
			stubActiveEditor(app, '[[rec.mp4#t=30|0:30]] - Speaker 1');
			const event = livePreviewClick();
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(detachedStartMock).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ path: 'rec.mp4' }),
				30,
				expect.any(Function),
			);
			expect(prevent).toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('leaves a Live Preview click that is not on a wikilink to Obsidian', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { plugin, app } = setup(true);
			stubActiveEditor(app, 'just plain text, no link at all');
			const event = livePreviewClick();
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
			expect(prevent).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	/** A Live Preview click inside the editor but NOT on a wikilink token. */
	function livePreviewNonLinkClick(): MouseEvent {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		// A rendered embed widget or plain line text: inside .cm-editor, but
		// carrying no .cm-hmd-internal-link token
		const widget = document.createElement('span');
		widget.className = 'cm-widget';
		editor.appendChild(widget);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: widget });
		return event;
	}

	it('ignores a Live Preview click that is not on an internal-link token', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { plugin, app } = setup(true);
			// The source line DOES hold a timecode link, and posAtDOM snaps to
			// it, but the click was on a widget, not the link: it must be left
			// alone so player buttons and plain text keep their own behaviour
			stubActiveEditor(app, '[[rec.mp4#t=30|0:30]] - Speaker 1');
			const event = livePreviewNonLinkClick();
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
			expect(prevent).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('leaves a timecode link to a probed video file to Obsidian', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		const kindStore = kindStoreStub();
		// A prior probe classified this .mp4 as carrying a video track
		kindStore.get.mockReturnValue(MEDIA_KIND.video);
		try {
			const { plugin } = setup(true, kindStore);
			const event = timecodeClick('rec.mp4#t=30');
			const prevent = jest.spyOn(event, 'preventDefault');

			clickHandler(plugin)(event);

			// The click keeps Obsidian's own player instead of hijacking into
			// audio-only detached playback
			expect(seek).not.toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
			expect(prevent).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('disposes detached playback when the player is disabled', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		const detached = detachedStub('rec.mp4');
		detachedStartMock.mockReturnValue(
			detached as unknown as DetachedPlayback,
		);
		try {
			const { plugin, registrar, settings } = setup(true);
			clickHandler(plugin)(timecodeClick('rec.mp4#t=30'));
			expect(detachedStartMock).toHaveBeenCalledTimes(1);

			// Turning the feature off has no embed to unload the detached
			// playback, so refresh must stop it directly
			settings.enhancedPlayerEnabled = false;
			registrar.refresh();

			expect(detached.dispose).toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});
});
