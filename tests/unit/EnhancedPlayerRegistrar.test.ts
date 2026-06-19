/** @jest-environment jsdom */
/**
 * Regression guard for the recurring "settings apply in one view mode but
 * not the other" / "video shows twice in Live Preview" defects. The fix:
 * the registrar is the single decision point — it returns Obsidian's OWN
 * native embed (unwrapped) for anything it does not enhance, returns the
 * enhanced player for audio, and applies settings by RE-RENDERING the view
 * through Obsidian's own pipeline (identical for Reading view and Live
 * Preview) instead of mutating embed DOM in place.
 *
 * These tests fail on the previous design (which always wrapped the embed
 * and refreshed in place via a private list) and pass on the re-render
 * design.
 */

import { MarkdownView } from 'obsidian';
import type { App, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { EnhancedPlayerRegistrar } from 'src/player/EnhancedPlayerRegistrar';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { probeMediaKind } from 'src/player/mediaProbe';
import { AUDIO_EXTENSIONS } from 'src/constants';
import { DEFAULT_SETTINGS } from 'src/settings/Settings';
import type { AudioRecorderSettings } from 'src/settings/Settings';
import type { EmbedInfo } from 'src/obsidian/embedRegistry';
import type { MarkerStore } from 'src/player/markers/MarkerStore';

jest.mock('src/player/AudioPlayer', () => ({
	AudioPlayer: jest.fn().mockImplementation(() => ({
		__enhanced: true,
		load: jest.fn(),
		unload: jest.fn(),
	})),
}));

jest.mock('src/player/mediaProbe', () => ({
	...jest.requireActual('src/player/mediaProbe'),
	probeMediaKind: jest.fn(),
}));

const probeMock = jest.mocked(probeMediaKind);
const audioPlayerMock = jest.mocked(AudioPlayer);

/** Resolves after the debounced re-render timer has fired. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 120));
}

/** A native embed instance tagged with the file extension that produced it. */
interface NativeInstance {
	__native: string;
}

/** Builds a MarkdownView stub for a given mode with re-render spies. */
function viewStub(mode: 'preview' | 'source'): MarkdownView {
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
	});
}

/**
 * Builds a registrar wired to fakes and registers it. Returns the installed
 * embed creator plus the spies needed to assert behaviour.
 */
function setup(enabled = true): {
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
		(_info: EmbedInfo, file: TFile): NativeInstance => ({
			__native: file.extension,
		}),
	);

	const embedByExtension: Record<string, unknown> = {};
	for (const ext of AUDIO_EXTENSIONS) {
		embedByExtension[ext] = nativeCreator;
	}

	const previewLeaf = {
		view: viewStub('preview'),
		rebuildView: jest.fn(),
	} as unknown as WorkspaceLeaf;
	const sourceLeaf = {
		view: viewStub('source'),
		rebuildView: jest.fn(),
	} as unknown as WorkspaceLeaf;
	const getLeaves = jest.fn(() => [previewLeaf, sourceLeaf]);

	const app = {
		embedRegistry: { embedByExtension },
		vault: {
			getResourcePath: () => 'app://media',
			on: jest.fn(() => ({})),
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

function fileOf(extension: string): TFile {
	return { path: `recording.${extension}`, extension } as TFile;
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
	it('returns Obsidian’s own native embed for a video file (no wrapper, no double)', () => {
		probeMock.mockResolvedValue('video');
		const { creator, nativeCreator } = setup(true);

		const result = creator(info, fileOf('mp4'), '') as NativeInstance;

		// The unwrapped native instance — exactly what Obsidian renders on its
		// own, so Live Preview cannot double it
		expect(result.__native).toBe('mp4');
		expect(nativeCreator).toHaveBeenCalledTimes(1);
		expect(audioPlayerMock).not.toHaveBeenCalled();
	});

	it('probes content for an audio-extension file too (never trusts the extension)', () => {
		probeMock.mockResolvedValue('audio');
		const { creator, nativeCreator } = setup(true);

		// A wav can in principle carry a video track, so it must be probed,
		// not enhanced on faith: render native first, probe the content
		const result = creator(info, fileOf('wav'), '') as NativeInstance;

		expect(result.__native).toBe('wav');
		expect(nativeCreator).toHaveBeenCalledTimes(1);
		expect(probeMock).toHaveBeenCalledTimes(1);
	});

	it('renders enhanced once a probe has classified the file as audio', async () => {
		probeMock.mockResolvedValue('audio');
		const { creator } = setup(true);

		// First render probes and shows native
		const first = creator(info, fileOf('wav'), '') as NativeInstance;
		expect(first.__native).toBe('wav');

		await flush();
		probeMock.mockClear();

		// A later render of the same file (as Obsidian does after the
		// re-render) is enhanced now, with no further probe
		const second = creator(info, fileOf('wav'), '') as {
			__enhanced?: boolean;
		};
		expect(second.__enhanced).toBe(true);
		expect(probeMock).not.toHaveBeenCalled();
	});

	it('returns the native embed for every file when the feature is disabled', () => {
		const { creator } = setup(false);

		const result = creator(info, fileOf('wav'), '') as NativeInstance;

		expect(result.__native).toBe('wav');
		expect(audioPlayerMock).not.toHaveBeenCalled();
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

	it('upgrades an audio-only container to enhanced by re-rendering after the probe', async () => {
		probeMock.mockResolvedValue('audio');
		const { creator, getLeaves } = setup(true);

		// First render of a not-yet-probed file shows native and probes
		creator(info, fileOf('mp4'), '');
		expect(probeMock).toHaveBeenCalledTimes(1);

		await flush();

		// The probe found audio, so a re-render is requested to upgrade it
		expect(getLeaves).toHaveBeenCalledWith('markdown');
	});

	it('does not re-render after probing a real video file', async () => {
		probeMock.mockResolvedValue('video');
		const { creator, getLeaves } = setup(true);

		creator(info, fileOf('mp4'), '');
		await flush();

		expect(getLeaves).not.toHaveBeenCalled();
	});
});
