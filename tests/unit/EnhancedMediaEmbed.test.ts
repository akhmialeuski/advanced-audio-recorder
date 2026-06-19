/** @jest-environment jsdom */
/**
 * Regression guard for the embed controller's mount sequencing — the source
 * of a recurring Live Preview bug where a video embed rendered as an empty
 * bar. The controller is native-first: it must mount the built-in embed
 * SYNCHRONOUSLY on load (never leave the container empty for the editor to
 * measure as zero height) and only ever REPLACE it with the enhanced player
 * once a file is confirmed audio-only. These tests fail if anyone
 * reintroduces "probe before mount" or stops delegating video to the native
 * embed.
 */

import type { App, TFile } from 'obsidian';
import { EnhancedMediaEmbed } from 'src/player/EnhancedMediaEmbed';
import type { EnhancedMediaEmbedDeps } from 'src/player/EnhancedMediaEmbed';
import { AudioPlayer } from 'src/player/AudioPlayer';
import { probeMediaKind, type MediaKind } from 'src/player/mediaProbe';
import { DEFAULT_SETTINGS } from 'src/settings/Settings';
import type { AudioRecorderSettings } from 'src/settings/Settings';
import type {
	EmbedComponent,
	EmbedCreator,
	EmbedInfo,
} from 'src/obsidian/embedRegistry';
import type { AudioPlayerRegistry } from 'src/player/AudioPlayerRegistry';
import type { WaveformPeakCache, AudioDecoder } from 'src/player/WaveformData';
import type { MarkerStore } from 'src/player/markers/MarkerStore';

const NATIVE_MARKER = 'aar-native-mounted';
const ENHANCED_MARKER = 'aar-enhanced-mounted';

// The enhanced player appends its marker on construction so a mount is
// observable synchronously, mirroring the real player's owned-container render
jest.mock('src/player/AudioPlayer', () => ({
	AudioPlayer: jest.fn().mockImplementation((containerEl: HTMLElement) => {
		const marker = document.createElement('div');
		marker.className = 'aar-enhanced-mounted';
		containerEl.appendChild(marker);
		return { load: jest.fn(), unload: jest.fn() };
	}),
}));

// Mock only the async probe; keep the real pure mediaKindFromExtension
jest.mock('src/player/mediaProbe', () => ({
	...jest.requireActual('src/player/mediaProbe'),
	probeMediaKind: jest.fn(),
}));

const probeMock = jest.mocked(probeMediaKind);
const audioPlayerMock = jest.mocked(AudioPlayer);

/** Resolves after pending microtasks so an awaited probe settles. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Builds an embed controller wired to fakes. The native creator appends its
 * marker from loadFile (mirroring the built-in embed, which builds its media
 * element when loadFile is called), so a native mount is only observable once
 * the controller forwards loadFile to it.
 */
function setup(
	options: {
		enabled?: boolean;
		cached?: MediaKind;
		extension?: string;
	} = {},
): {
	embed: EnhancedMediaEmbed;
	container: HTMLElement;
	settings: AudioRecorderSettings;
	creatorCalls: () => number;
} {
	const container = document.createElement('div');
	(container as unknown as { empty(): void }).empty = (): void => {
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}
	};
	const info: EmbedInfo = { containerEl: container, sourcePath: 'note.md' };
	const extension = options.extension ?? 'webm';
	const file = { path: `recording.${extension}`, extension } as TFile;

	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		enhancedPlayerEnabled: options.enabled ?? true,
	};

	let creatorCalls = 0;
	const fallbackCreator: EmbedCreator = (embedInfo) => {
		creatorCalls += 1;
		return {
			load: jest.fn(),
			unload: jest.fn(),
			loadFile: jest.fn(() => {
				const marker = document.createElement('div');
				marker.className = NATIVE_MARKER;
				embedInfo.containerEl.appendChild(marker);
			}),
		} as unknown as EmbedComponent;
	};

	const mediaKindCache = new Map<string, MediaKind>();
	if (options.cached) {
		mediaKindCache.set(file.path, options.cached);
	}

	const deps: EnhancedMediaEmbedDeps = {
		app: {
			vault: { getResourcePath: () => 'app://media' },
			workspace: { getActiveFile: () => null },
		} as unknown as App,
		getSettings: () => settings,
		registry: {} as AudioPlayerRegistry,
		peakCache: {} as WaveformPeakCache,
		decoder: {} as AudioDecoder,
		markerStore: {} as MarkerStore,
		mediaKindCache,
		fallbackCreator,
	};

	const embed = new EnhancedMediaEmbed(info, file, '', deps);
	return { embed, container, settings, creatorCalls: () => creatorCalls };
}

beforeEach(() => {
	probeMock.mockReset();
	audioPlayerMock.mockClear();
});

describe('EnhancedMediaEmbed mount sequencing', () => {
	it('mounts the native embed synchronously on load (never an empty bar)', () => {
		probeMock.mockResolvedValue('video');
		const { embed, container } = setup();

		embed.load();

		// The core regression guard: native content exists immediately, before
		// any probe resolves — Live Preview measures height at this point
		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
	});

	it('leaves a video file on the native embed after probing', async () => {
		probeMock.mockResolvedValue('video');
		const { embed, container } = setup();

		embed.load();
		await flush();

		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
		expect(probeMock).toHaveBeenCalledTimes(1);
	});

	it('upgrades an audio-only file from native to the enhanced player', async () => {
		probeMock.mockResolvedValue('audio');
		const { embed, container } = setup();

		embed.load();
		// Placeholder native embed shows synchronously while probing
		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();

		await flush();

		expect(container.querySelector(`.${ENHANCED_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${NATIVE_MARKER}`)).toBeNull();
	});

	it('keeps an unsupported file on the native embed', async () => {
		probeMock.mockResolvedValue('unsupported');
		const { embed, container } = setup();

		embed.load();
		await flush();

		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
	});

	it('never probes or enhances when the feature is disabled', async () => {
		const { embed, container } = setup({ enabled: false });

		embed.load();
		await flush();

		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
		expect(probeMock).not.toHaveBeenCalled();
	});
});

describe('EnhancedMediaEmbed cached decisions', () => {
	it('mounts the enhanced player synchronously for a cached audio file', () => {
		const { embed, container } = setup({ cached: 'audio' });

		embed.load();

		expect(container.querySelector(`.${ENHANCED_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${NATIVE_MARKER}`)).toBeNull();
		expect(probeMock).not.toHaveBeenCalled();
	});

	it('mounts the native embed for a cached video file without re-probing', async () => {
		const { embed, container } = setup({ cached: 'video' });

		embed.load();
		await flush();

		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
		expect(probeMock).not.toHaveBeenCalled();
	});
});

describe('EnhancedMediaEmbed refresh applies settings immediately', () => {
	it('swaps enhanced -> native when the player is turned off', () => {
		const { embed, container, settings } = setup({ cached: 'audio' });

		embed.load();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).not.toBeNull();

		settings.enhancedPlayerEnabled = false;
		embed.refresh();

		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${ENHANCED_MARKER}`)).toBeNull();
	});

	it('swaps native -> enhanced when the player is turned back on', () => {
		const { embed, container, settings } = setup({ cached: 'audio' });

		settings.enhancedPlayerEnabled = false;
		embed.load();
		expect(container.querySelector(`.${NATIVE_MARKER}`)).not.toBeNull();

		settings.enhancedPlayerEnabled = true;
		embed.refresh();

		expect(container.querySelector(`.${ENHANCED_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${NATIVE_MARKER}`)).toBeNull();
	});

	it('does not re-create the native mount on a redundant refresh', () => {
		const { embed, creatorCalls } = setup({ cached: 'video' });

		embed.load();
		const afterLoad = creatorCalls();
		embed.refresh();

		// Native is Obsidian's default, unaffected by our settings: same
		// target means no DOM churn or extra native creation
		expect(creatorCalls()).toBe(afterLoad);
	});

	it('rebuilds the enhanced player on refresh so setting changes re-render', () => {
		const { embed, container } = setup({ cached: 'audio' });

		embed.load();
		expect(audioPlayerMock).toHaveBeenCalledTimes(1);

		// A player-setting change keeps the mount enhanced, but the player
		// must be rebuilt with the new settings — not left as a no-op (the
		// "have to reload the page" regression)
		embed.refresh();

		expect(audioPlayerMock).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll(`.${ENHANCED_MARKER}`)).toHaveLength(
			1,
		);
	});
});

describe('EnhancedMediaEmbed loads native exactly once', () => {
	it('does not duplicate the built-in player across load and loadFile', () => {
		const { embed, container } = setup({ enabled: false });

		// Obsidian drives both hooks; neither may append a second native player
		embed.load();
		embed.loadFile();
		embed.loadFile();

		expect(container.querySelectorAll(`.${NATIVE_MARKER}`)).toHaveLength(1);
	});

	it('does not duplicate the built-in player when loadFile precedes load', () => {
		const { embed, container } = setup({ enabled: false });

		embed.loadFile();
		embed.load();

		expect(container.querySelectorAll(`.${NATIVE_MARKER}`)).toHaveLength(1);
	});
});

describe('EnhancedMediaEmbed extension fast path', () => {
	it('enhances an unambiguous audio file synchronously without probing', () => {
		const { embed, container } = setup({ extension: 'wav' });

		embed.load();

		expect(container.querySelector(`.${ENHANCED_MARKER}`)).not.toBeNull();
		expect(container.querySelector(`.${NATIVE_MARKER}`)).toBeNull();
		expect(probeMock).not.toHaveBeenCalled();
	});

	it('probes a video-capable container before deciding', async () => {
		probeMock.mockResolvedValue('audio');
		const { embed } = setup({ extension: 'mp4' });

		embed.load();
		await flush();

		expect(probeMock).toHaveBeenCalledTimes(1);
	});
});
