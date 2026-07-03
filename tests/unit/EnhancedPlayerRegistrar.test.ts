/** @jest-environment jsdom */
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
import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { MediaEmbedShell } from 'src/player/MediaEmbedShell';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import { probeMediaKind } from 'src/player/mediaProbe';
import type { MediaKind, MediaProbeResult } from 'src/player/mediaProbe';
import type { MediaKindStore } from 'src/player/MediaKindStore';
import { AUDIO_EXTENSIONS } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/Settings';
import type { AudioRecorderSettings } from 'src/settings/Settings';
import type { EmbedInfo } from 'src/obsidian/embedRegistry';
import type { MarkerStore } from 'src/markers/MarkerStore';

jest.mock('src/player/AudioPlayer', () => ({
	AudioPlayer: jest.fn().mockImplementation(() => ({
		__enhanced: true,
		load: jest.fn(),
		unload: jest.fn(),
		loadFile: jest.fn(),
	})),
}));

jest.mock('src/player/mediaProbe', () => ({
	...jest.requireActual('src/player/mediaProbe'),
	probeMediaKind: jest.fn(),
}));

const probeMock = jest.mocked(probeMediaKind);
const audioPlayerMock = jest.mocked(AudioPlayer);

/** Builds a probe result; probes are confident unless stated otherwise. */
function probeResult(kind: MediaKind, confident = true): MediaProbeResult {
	return { kind, confident };
}

/** Resolves after the probe microtasks and the re-render debounce. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 120));
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
			getAbstractFileByPath: (path: string) => fileFromPath(path),
			on: jest.fn(() => ({})),
		},
		metadataCache: {
			getFileCache: () => ({ embeds: [] }),
			getFirstLinkpathDest: (linkPath: string) => ({ path: linkPath }),
		},
		workspace: {
			getActiveFile: () => ({ path: 'note.md' }),
			getLeavesOfType: getLeaves,
		},
	} as unknown as App;

	const plugin = {
		registerMarkdownPostProcessor: jest.fn(),
		registerDomEvent: jest.fn(),
		registerEvent: jest.fn(),
	} as unknown as Plugin;

	const markerStore = {
		handleRename: jest.fn(),
		handleDelete: jest.fn(),
		clearCache: jest.fn(),
	} as unknown as MarkerStore;

	const registrar = new EnhancedPlayerRegistrar(
		plugin,
		app,
		() => settings,
		markerStore,
		kindStore,
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
	probeMock.mockReset();
	audioPlayerMock.mockClear();
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
		const native = nativeCreator.mock.results[0].value as NativeEmbed;
		expect(native.unloaded).toBe(true);
		expect(audioPlayerMock).toHaveBeenCalledTimes(1);
		const player = audioPlayerMock.mock.results[0]
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

		const native = nativeCreator.mock.results[0].value as NativeEmbed;
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

		const native = nativeCreator.mock.results[0].value as NativeEmbed;
		expect(native.loadFile).toHaveBeenCalledWith(file);

		await flush();

		// Live Preview drove the old child through loadFile, so the new
		// child gets the same call and renders
		const player = audioPlayerMock.mock.results[0]
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
