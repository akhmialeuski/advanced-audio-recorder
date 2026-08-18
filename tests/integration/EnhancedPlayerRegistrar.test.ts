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
import { partialPlugin } from '../helpers/obsidianMock';
import { partial } from '../helpers/doubles';
import { pastDebounce } from '../helpers/async';
import { createMockApp } from '../helpers/createApp';

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

/**
 * A workspace leaf holding a view, with an optional rebuildView.
 * @param parts - The leaf's view and, when it has one, its rebuildView
 * @returns The leaf
 */
function leafStub(parts: {
	view: unknown;
	rebuildView?: () => void;
}): WorkspaceLeaf {
	return partial<WorkspaceLeaf>(parts);
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
	options: { embedRegistry?: unknown } = {},
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

	const previewLeaf = partial<WorkspaceLeaf>({
		view: viewStub('preview', 'note.md'),
		rebuildView: jest.fn(),
	});
	const sourceLeaf = partial<WorkspaceLeaf>({
		view: viewStub('source', 'other.md'),
		rebuildView: jest.fn(),
	});
	const getLeaves = jest.fn(() => [previewLeaf, sourceLeaf]);

	const app = createMockApp({
		embedRegistry:
			'embedRegistry' in options
				? options.embedRegistry
				: { embedByExtension },
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
	}).app;

	const plugin = partialPlugin({
		registerMarkdownPostProcessor: jest.fn(),
		registerDomEvent: jest.fn(),
		registerEvent: jest.fn(),
	});

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
		partial<RecordingSidecarStore>(markerStore),
		kindStore === null ? null : partial<MediaKindStore>(kindStore),
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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

		const native = at(nativeCreator.mock.results, 0).value as NativeEmbed;
		expect(native.unloaded).toBe(false);
		expect(audioPlayerMock).not.toHaveBeenCalled();
		expect(getLeaves).not.toHaveBeenCalled();
	});

	it("returns Obsidian's own native embed unwrapped once a file is known video (no wrapper, no double)", async () => {
		probeMock.mockResolvedValue(probeResult('video'));
		const { creator } = setup(true);

		creator(info, fileOf('mp4'), '');
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);
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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

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

		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		await pastDebounce(RERENDER_DEBOUNCE_MS);

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
		const call = jest
			.mocked(app.vault.on)
			.mock.calls.find((args: unknown[]) => args[0] === event);
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
		return partial<DetachedPlayback>(detachedStub(path));
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
		detachedStartMock.mockReturnValue(partial<DetachedPlayback>(detached));
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
		detachedStartMock.mockReturnValue(partial<DetachedPlayback>(detached));
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

describe('EnhancedPlayerRegistrar without the internal embed registry', () => {
	/** A post-processor context naming the note the embeds are in. */
	function postProcessorContext(sourcePath = 'note.md'): {
		sourcePath: string;
		addChild: jest.Mock;
	} {
		// Obsidian ties every child to the rendered section's lifetime, which
		// is what unloads a player when the note is closed.
		return { sourcePath, addChild: jest.fn() };
	}

	/** The markdown post-processor the registrar installed. */
	function postProcessor(
		plugin: Plugin,
	): (el: HTMLElement, ctx: unknown) => void {
		return at(
			jest.mocked(plugin.registerMarkdownPostProcessor).mock.calls,
			0,
		)[0] as unknown as (el: HTMLElement, ctx: unknown) => void;
	}

	/** A note body holding one audio embed. */
	function noteWith(src: string): HTMLElement {
		const el = document.createElement('div');
		const embed = document.createElement('span');
		embed.className = 'internal-embed';
		embed.setAttribute('src', src);
		el.appendChild(embed);
		return el;
	}

	it.each([
		{
			name: 'the API is missing entirely',
			embedRegistry: undefined,
			expected: 'Embed registry API unavailable',
		},
		{
			name: 'reading it throws',
			embedRegistry: null,
			expected: 'Embed registry API unavailable',
		},
	])(
		'falls back to the post-processor when $name',
		({ embedRegistry, expected }) => {
			// Obsidian's embed registry is an internal API. Losing it must cost
			// Live Preview enhancement, not the whole plugin load.
			const warn = jest
				.spyOn(console, 'warn')
				.mockImplementation(() => undefined);

			const { plugin } = setup(true, null, { embedRegistry });

			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(expected),
			);
			expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalled();
			warn.mockRestore();
		},
	);

	it('enhances a reading-view embed through the fallback', () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { plugin } = setup(true, null, { embedRegistry: undefined });

		postProcessor(plugin)(
			noteWith('recording.mp3'),
			postProcessorContext(),
		);

		expect(audioPlayerMock).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('enhances each embed exactly once, however often the note re-renders', () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { plugin } = setup(true, null, { embedRegistry: undefined });
		const note = noteWith('recording.mp3');

		postProcessor(plugin)(note, postProcessorContext());
		postProcessor(plugin)(note, postProcessorContext());

		expect(audioPlayerMock).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it.each([
		{ name: 'an embed with no source', src: '' },
		{ name: 'a link that resolves to nothing', src: 'missing' },
		{ name: 'an embed of something that is not audio', src: 'clip.pdf' },
	])('leaves $name alone', ({ src }) => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { plugin, app } = setup(true, null, { embedRegistry: undefined });
		if (src === 'missing') {
			(
				app.metadataCache as unknown as {
					getFirstLinkpathDest: jest.Mock;
				}
			).getFirstLinkpathDest = jest.fn(() => null);
		}
		const note = noteWith(src);
		if (src === '') {
			at(
				[...note.querySelectorAll('.internal-embed')],
				0,
			).removeAttribute('src');
		}

		postProcessor(plugin)(note, postProcessorContext());

		expect(audioPlayerMock).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('enhances nothing while the feature is off', () => {
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const { plugin } = setup(false, null, { embedRegistry: undefined });

		postProcessor(plugin)(
			noteWith('recording.mp3'),
			postProcessorContext(),
		);

		expect(audioPlayerMock).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('stays out of the way while the embed registry is in charge', () => {
		// Both paths running would build two players in one embed.
		const { plugin } = setup(true);

		postProcessor(plugin)(
			noteWith('recording.mp3'),
			postProcessorContext(),
		);

		expect(audioPlayerMock).not.toHaveBeenCalled();
	});
});

describe('EnhancedPlayerRegistrar rebuilding open notes', () => {
	it('re-renders a reading view that cannot be rebuilt outright', async () => {
		// rebuildView is an internal API. Where it is missing, reading view
		// still has to pick up the toggle without reopening the note.
		const rerender = jest.fn();
		const { registrar, settings, getLeaves } = setup(true);
		getLeaves.mockReturnValue([
			leafStub({
				view: Object.assign(viewStub('preview'), {
					previewMode: { rerender },
				}),
			}),
		]);

		settings.enhancedPlayerEnabled = false;
		registrar.refresh();
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(rerender).toHaveBeenCalledWith(true);
	});

	it('leaves an editor it cannot rebuild alone rather than guessing', async () => {
		const { registrar, settings, getLeaves } = setup(true);
		const view = viewStub('source');
		const rerender = jest.fn();
		getLeaves.mockReturnValue([
			leafStub({
				view: Object.assign(view, { previewMode: { rerender } }),
			}),
		]);

		settings.enhancedPlayerEnabled = false;
		registrar.refresh();
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(rerender).not.toHaveBeenCalled();
	});

	it('skips a leaf that is not showing a note at all', async () => {
		// The workspace can hand back a leaf whose view has been swapped out
		// between the query and the rebuild.
		const { registrar, settings, getLeaves } = setup(true);
		getLeaves.mockReturnValue([
			leafStub({ view: { getMode: (): string => 'preview' } }),
		]);

		settings.enhancedPlayerEnabled = false;

		await expect(
			(async (): Promise<void> => {
				registrar.refresh();
				await pastDebounce(RERENDER_DEBOUNCE_MS);
			})(),
		).resolves.toBeUndefined();
	});

	it('keeps rebuilding the rest when one view throws', async () => {
		const error = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const good = jest.fn();
		const { registrar, settings, getLeaves } = setup(true);
		getLeaves.mockReturnValue([
			leafStub({
				view: viewStub('preview'),
				rebuildView: jest.fn(() => {
					throw new Error('view is gone');
				}),
			}),
			leafStub({ view: viewStub('preview'), rebuildView: good }),
		]);

		settings.enhancedPlayerEnabled = false;
		registrar.refresh();
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(good).toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to re-render'),
			expect.any(Error),
		);
		error.mockRestore();
	});

	it('coalesces two toggles in the same tick into one rebuild', async () => {
		const { registrar, settings, leaves } = setup(true);

		settings.enhancedPlayerEnabled = false;
		registrar.refresh();
		settings.enhancedPlayerEnabled = true;
		registrar.refresh();
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(
			(leaves.preview as unknown as { rebuildView: jest.Mock })
				.rebuildView,
		).toHaveBeenCalledTimes(1);
	});
});

describe('EnhancedPlayerRegistrar priming a saved recording', () => {
	it('probes nothing while the enhanced player is off', () => {
		const { registrar } = setup(false);

		registrar.primeSavedRecordingsForEnhancement(['Recordings/take.wav']);

		expect(probeMock).not.toHaveBeenCalled();
	});

	it.each([
		{ name: 'a path with no file behind it', path: 'gone.wav' },
		{ name: 'a file that is not audio', path: 'clip.pdf' },
	])('skips $name', ({ path }) => {
		const { registrar, app } = setup(true);
		if (path === 'gone.wav') {
			(
				app.vault as unknown as { getFileByPath: jest.Mock }
			).getFileByPath = jest.fn(() => null);
		}

		registrar.primeSavedRecordingsForEnhancement([path]);

		expect(probeMock).not.toHaveBeenCalled();
	});

	it('probes each saved recording once, however many embeds want it', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { registrar } = setup(true);

		registrar.primeSavedRecordingsForEnhancement(['take.wav']);
		registrar.primeSavedRecordingsForEnhancement(['take.wav']);
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(probeMock).toHaveBeenCalledTimes(1);
	});
});

describe('EnhancedPlayerRegistrar refreshing markers from outside', () => {
	it('reaches every open player of the file', () => {
		// Generated chapters are written by a service no player knows about,
		// so the reload carries no source player to skip.
		const reload = jest
			.spyOn(AudioPlayerRegistry.prototype, 'reloadMarkers')
			.mockImplementation(() => undefined);
		try {
			const { registrar } = setup(true);

			registrar.reloadMarkersFor('Recordings/take.webm');

			expect(reload).toHaveBeenCalledWith('Recordings/take.webm', null);
		} finally {
			reload.mockRestore();
		}
	});
});

describe('EnhancedPlayerRegistrar when the embed registry blows up', () => {
	it('falls back to the post-processor rather than failing plugin load', () => {
		// Reading Obsidian's internal registry is the one operation here that
		// can throw outright; plugin load must survive it.
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const exploding = {
			get embedByExtension(): never {
				throw new Error('internal API changed');
			},
		};

		const { plugin } = setup(true, null, { embedRegistry: exploding });

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to set up the embed registry'),
			expect.any(Error),
		);
		expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('hands back the native embed when building the player throws', () => {
		// An embed that throws would leave a blank space in the note; the
		// native player is worse than the enhanced one but not empty.
		const error = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const kindStore = kindStoreStub();
		kindStore.get.mockReturnValue('audio');
		audioPlayerMock.mockImplementationOnce(() => {
			throw new Error('player construction failed');
		});
		const { creator, nativeCreator } = setup(true, kindStore);

		const embed = creator(embedInfo(), fileOf('mp3'), '');

		expect(nativeCreator).toHaveBeenCalled();
		expect((embed as NativeEmbed).__native).toBe('mp3');
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('Failed to create the audio embed'),
			expect.any(Error),
		);
		error.mockRestore();
	});
});

describe('EnhancedPlayerRegistrar settings changes that change nothing', () => {
	it('does nothing at all while the player stays switched off', async () => {
		// Every unrelated settings save reaches refresh(); with the feature
		// off there is no layout to reapply and nothing to rebuild.
		const { registrar, getLeaves } = setup(false);
		getLeaves.mockClear();

		registrar.refresh();
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(getLeaves).not.toHaveBeenCalled();
	});
});

describe('EnhancedPlayerRegistrar probing a file it already knows', () => {
	it('answers from the cache without probing again', async () => {
		probeMock.mockResolvedValue(probeResult('audio'));
		const { registrar } = setup(true);
		registrar.primeSavedRecordingsForEnhancement(['take.wav']);
		await pastDebounce(RERENDER_DEBOUNCE_MS);
		probeMock.mockClear();

		registrar.primeSavedRecordingsForEnhancement(['take.wav']);
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(probeMock).not.toHaveBeenCalled();
	});
});

describe('EnhancedPlayerRegistrar timecode links that go nowhere', () => {
	/** The document click handler the registrar installed on register. */
	function clicks(): (event: MouseEvent) => void {
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

	/** A click on an internal link with the given target. */
	function linkClick(href: string): MouseEvent {
		const anchor = document.createElement('a');
		anchor.className = 'internal-link';
		anchor.setAttribute('data-href', href);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: anchor });
		return event;
	}

	it('leaves a #t= link with no readable time to Obsidian', () => {
		// "#t=" with nothing usable after it is a link to the file, not to a
		// moment in it; opening the file is the right answer.
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(true);
		try {
			setup(true);
			const event = linkClick('rec.mp4#t=later');
			const prevent = jest.spyOn(event, 'preventDefault');

			clicks()(event);

			expect(seek).not.toHaveBeenCalled();
			expect(prevent).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('ignores a click with no element behind it', () => {
		const { plugin } = setup(true);
		const event = new MouseEvent('click');
		Object.defineProperty(event, 'target', { value: null });

		expect(() => {
			clicks()(event);
		}).not.toThrow();
		expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalled();
	});

	it('falls back to the href when the link carries no data-href', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(true);
		try {
			const { plugin } = setup(true);
			const anchor = document.createElement('a');
			anchor.className = 'internal-link';
			anchor.setAttribute('href', 'rec.mp4#t=30');
			const event = new MouseEvent('click', { bubbles: true });
			Object.defineProperty(event, 'target', { value: anchor });

			clicks()(event);

			expect(seek).toHaveBeenCalledWith('rec.mp4', 30);
			expect(plugin.registerDomEvent).toBeDefined();
		} finally {
			seek.mockRestore();
		}
	});
});

describe('EnhancedPlayerRegistrar handing playback between surfaces', () => {
	/** The document click handler the registrar installed on register. */
	function clicks(): (event: MouseEvent) => void {
		const { registerDomEventOnAllWindows } = jest.requireMock(
			'src/utils/multiWindowDomEvents',
		);
		return at(
			(registerDomEventOnAllWindows as jest.Mock).mock.calls.filter(
				(args: unknown[]) => args[2] === 'click',
			),
			0,
		)[3] as (event: MouseEvent) => void;
	}

	/** A click on an internal link with the given target. */
	function linkClick(href: string): MouseEvent {
		const anchor = document.createElement('a');
		anchor.className = 'internal-link';
		anchor.setAttribute('data-href', href);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: anchor });
		return event;
	}

	it('stops the detached playback once an embed of the file takes over', () => {
		// Two surfaces driving the same audio element fight over its
		// position; the embed wins because it is the one on screen.
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		const detached = detachedStubOfPath('rec.mp4');
		detachedStartMock.mockReturnValue(partial<DetachedPlayback>(detached));
		try {
			setup(true);
			seek.mockReturnValue(false);
			clicks()(linkClick('rec.mp4#t=10'));

			seek.mockReturnValue(true);
			clicks()(linkClick('rec.mp4#t=30'));

			expect(detached.dispose).toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('leaves the detached playback of another file alone', () => {
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		const detached = detachedStubOfPath('other.mp4');
		detachedStartMock.mockReturnValue(partial<DetachedPlayback>(detached));
		try {
			setup(true);
			seek.mockReturnValue(false);
			clicks()(linkClick('other.mp4#t=10'));

			seek.mockReturnValue(true);
			clicks()(linkClick('rec.mp4#t=30'));

			expect(detached.dispose).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('reuses an audio element that exists but has no player on screen', () => {
		// A pop-out window that was closed leaves the element registered; a
		// second element for the same file would play the audio twice.
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		const seekShared = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seekSharedAudio')
			.mockReturnValue(true);
		try {
			setup(true);

			clicks()(linkClick('rec.mp4#t=30'));

			expect(seekShared).toHaveBeenCalled();
			expect(detachedStartMock).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
			seekShared.mockRestore();
		}
	});

	it('drops a detached playback of another file before starting one', () => {
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		const first = detachedStubOfPath('first.mp4');
		const second = detachedStubOfPath('second.mp4');
		detachedStartMock
			.mockReturnValueOnce(partial<DetachedPlayback>(first))
			.mockReturnValueOnce(partial<DetachedPlayback>(second));
		try {
			setup(true);
			clicks()(linkClick('first.mp4#t=10'));

			clicks()(linkClick('second.mp4#t=20'));

			expect(first.dispose).toHaveBeenCalled();
			expect(detachedStartMock).toHaveBeenCalledTimes(2);
		} finally {
			seek.mockRestore();
		}
	});
});

/** A detached-playback stub for a file, with spied commands. */
function detachedStubOfPath(path: string): {
	path: string;
	seek: jest.Mock;
	dispose: jest.Mock;
} {
	return { path, seek: jest.fn(), dispose: jest.fn() };
}

describe('EnhancedPlayerRegistrar resolving a Live Preview link', () => {
	/** The document click handler the registrar installed on register. */
	function clicks(): (event: MouseEvent) => void {
		const { registerDomEventOnAllWindows } = jest.requireMock(
			'src/utils/multiWindowDomEvents',
		);
		return at(
			(registerDomEventOnAllWindows as jest.Mock).mock.calls.filter(
				(args: unknown[]) => args[2] === 'click',
			),
			0,
		)[3] as (event: MouseEvent) => void;
	}

	/** A click on a Live Preview wikilink token (no data-href). */
	function tokenClick(): MouseEvent {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const linkEl = document.createElement('span');
		linkEl.className = 'cm-hmd-internal-link';
		editor.appendChild(linkEl);
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: linkEl });
		return event;
	}

	it('gives up when no editor owns the click', () => {
		// A click in a pane the workspace no longer tracks: there is no
		// source line to read the link out of.
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { app } = setup(true);
			(app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(
				null,
			);

			clicks()(tokenClick());

			expect(seek).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('gives up when the editor exposes no CodeMirror position lookup', () => {
		// posAtDOM is an internal CodeMirror API; without it a DOM node
		// cannot be turned into a source offset.
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { app } = setup(true);
			(app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				editor: { cm: {} },
			});

			clicks()(tokenClick());

			expect(seek).not.toHaveBeenCalled();
		} finally {
			seek.mockRestore();
		}
	});

	it('reports a position lookup that throws instead of failing the click', () => {
		const error = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const seek = jest.spyOn(AudioPlayerRegistry.prototype, 'seek');
		try {
			const { app } = setup(true);
			(app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				editor: {
					cm: {
						posAtDOM: jest.fn(() => {
							throw new Error('node is not in this document');
						}),
					},
					offsetToPos: jest.fn(),
					getLine: jest.fn(),
				},
			});

			clicks()(tokenClick());

			expect(seek).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to resolve a timecode link'),
				expect.any(Error),
			);
		} finally {
			seek.mockRestore();
			error.mockRestore();
		}
	});
});

describe('EnhancedPlayerRegistrar renaming a probed recording', () => {
	it('carries the known media kind to the new path', async () => {
		// Losing it would re-probe the same bytes and, worse, show the native
		// embed for a moment on a file already known to be audio.
		probeMock.mockResolvedValue(probeResult('audio'));
		const kindStore = kindStoreStub();
		const { app, registrar } = setup(true, kindStore);
		registrar.primeSavedRecordingsForEnhancement(['old.wav']);
		await pastDebounce(RERENDER_DEBOUNCE_MS);
		probeMock.mockClear();

		const rename = at(
			jest
				.mocked(app.vault.on)
				.mock.calls.filter((args: unknown[]) => args[0] === 'rename'),
			0,
		)[1] as (file: TFile, oldPath: string) => void;
		rename(fileFromPath('new.wav'), 'old.wav');
		registrar.primeSavedRecordingsForEnhancement(['new.wav']);
		await pastDebounce(RERENDER_DEBOUNCE_MS);

		expect(probeMock).not.toHaveBeenCalled();
		expect(kindStore.handleRename).toHaveBeenCalledWith(
			'old.wav',
			'new.wav',
		);
	});
});

describe('EnhancedPlayerRegistrar forgetting a finished playback', () => {
	it('lets the next timecode click start a fresh one', () => {
		// Holding on to a finished playback would make the next click try to
		// dispose an object that has already torn itself down.
		const seek = jest
			.spyOn(AudioPlayerRegistry.prototype, 'seek')
			.mockReturnValue(false);
		const first = detachedStubOfPath('rec.mp4');
		const second = detachedStubOfPath('rec.mp4');
		detachedStartMock
			.mockReturnValueOnce(partial<DetachedPlayback>(first))
			.mockReturnValueOnce(partial<DetachedPlayback>(second));
		try {
			setup(true);
			const { registerDomEventOnAllWindows } = jest.requireMock(
				'src/utils/multiWindowDomEvents',
			);
			const click = at(
				(registerDomEventOnAllWindows as jest.Mock).mock.calls.filter(
					(args: unknown[]) => args[2] === 'click',
				),
				0,
			)[3] as (event: MouseEvent) => void;
			const anchor = document.createElement('a');
			anchor.className = 'internal-link';
			anchor.setAttribute('data-href', 'rec.mp4#t=30');
			const event = new MouseEvent('click', { bubbles: true });
			Object.defineProperty(event, 'target', { value: anchor });

			click(event);
			// The playback reaches its end and reports itself finished.
			const onEnded = at(detachedStartMock.mock.calls, 0)[4];
			onEnded();
			click(event);

			expect(first.dispose).not.toHaveBeenCalled();
			expect(detachedStartMock).toHaveBeenCalledTimes(2);
		} finally {
			seek.mockRestore();
		}
	});
});
