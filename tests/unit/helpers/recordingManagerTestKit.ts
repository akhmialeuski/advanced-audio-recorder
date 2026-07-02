/**
 * Shared setup for the RecordingManager unit test suites: media API
 * stubs, the App double, and the mock factories the split suites use.
 * jest.mock() calls cannot live in an imported helper (jest hoists
 * them within each test file), so every suite keeps its own jest.mock
 * blocks and imports the rest of the shared setup from here.
 * @module tests/unit/helpers/recordingManagerTestKit
 */

import type { App } from 'obsidian';
import type { RecordingManager } from '../../../src/recording/RecordingManager';
import type { MarkerStore } from '../../../src/markers/MarkerStore';
import type { PlayerMarker } from '../../../src/markers/markerModel';

/**
 * Installs the AudioContext, OfflineAudioContext, and AudioBuffer
 * stubs the recording pipeline touches; jsdom provides none of them.
 * The AudioContext stub intentionally has no audioWorklet so suites
 * exercising the real PcmStreamRecorder see its start() fail.
 */
export const installRecordingMediaStubs = (): void => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(global as any).AudioContext = jest.fn().mockImplementation(() => ({
		decodeAudioData: jest.fn().mockResolvedValue({
			duration: 1,
			length: 44100,
			sampleRate: 44100,
			numberOfChannels: 1,
			getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
		}),
		createBufferSource: jest.fn().mockImplementation(() => ({
			connect: jest.fn(),
			start: jest.fn(),
			buffer: null,
		})),
		destination: {},
		close: jest.fn().mockResolvedValue(undefined),
		sampleRate: 44100,
	}));

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(global as any).OfflineAudioContext = jest.fn().mockImplementation(() => ({
		createBufferSource: jest.fn().mockImplementation(() => ({
			connect: jest.fn(),
			start: jest.fn(),
			buffer: null,
		})),
		startRendering: jest.fn().mockResolvedValue({
			length: 44100,
			sampleRate: 44100,
			getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
		}),
		destination: {},
	}));

	(global as unknown as { AudioBuffer: unknown }).AudioBuffer = jest
		.fn()
		.mockImplementation(() => ({
			getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
		}));
};

/**
 * Builds the App double shared by the RecordingManager suites.
 * @returns A fresh mock App
 */
export const createRecordingMockApp = (): App =>
	({
		vault: {
			adapter: {
				exists: jest.fn().mockResolvedValue(false),
				rename: jest.fn().mockResolvedValue(undefined),
				readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
				writeBinary: jest.fn().mockResolvedValue(undefined),
				remove: jest.fn().mockResolvedValue(undefined),
			},
			createBinary: jest.fn().mockResolvedValue(undefined),
			createFolder: jest.fn().mockResolvedValue(undefined),
		},
		workspace: {
			getActiveViewOfType: jest.fn().mockReturnValue(null),
			getActiveFile: jest.fn().mockReturnValue(null),
		},
	}) as unknown as App;

/** The MediaRecorder double returned by {@link createDesktopRecorder}. */
export interface MockMediaRecorder {
	start: jest.Mock;
	stop: jest.Mock;
	pause: jest.Mock;
	resume: jest.Mock;
	ondataavailable: ((event: BlobEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener: jest.Mock;
}

/** Forces the mocked obsidian Platform flags to desktop. */
export const setDesktopPlatform = (): void => {
	const { Platform } = jest.requireMock('obsidian');
	Platform.isMobile = false;
	Platform.isMobileApp = false;
};

/**
 * Installs a single-stream MediaRecorder double whose stop event fires
 * synchronously, and points getAudioStreams at one desktop stream.
 * Platform flags are left untouched; call {@link setDesktopPlatform}
 * where the desktop code path is required.
 * @returns The MediaRecorder double
 */
export const createDesktopRecorder = (): MockMediaRecorder => {
	const mockMediaRecorder: MockMediaRecorder = {
		start: jest.fn(),
		stop: jest.fn(),
		pause: jest.fn(),
		resume: jest.fn(),
		ondataavailable: null,
		onerror: null,
		addEventListener: jest.fn((event: string, handler: () => void) => {
			if (event === 'stop') {
				handler();
			}
		}),
	};
	(global as Record<string, unknown>).MediaRecorder = jest.fn(
		() => mockMediaRecorder,
	);
	(global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
		.fn()
		.mockReturnValue(true);
	const { getAudioStreams } = jest.requireMock(
		'../../../src/recording/AudioStreamHandler',
	);
	getAudioStreams.mockResolvedValue({
		streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
		trackOrder: [],
	});
	return mockMediaRecorder;
};

/** Microtask+macrotask drain so void'ed chunk handlers settle. */
// Two macrotask turns: the Blob.arrayBuffer polyfill reads through
// FileReader, which takes an extra event-loop turn before the
// write chain advances
export const flushAsync = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Mutable view of a chunk target's write-chain internals. */
export interface MutableTarget {
	bufferedBytes: number;
	pcmBufferedBytes: number;
	pendingWrite: Promise<void>;
}

/**
 * Reaches into a manager's chunk targets for write-chain assertions.
 * @param manager - The manager under test
 * @param index - Track index
 * @returns The target's mutable internals
 */
export const getChunkTarget = (
	manager: RecordingManager,
	index: number,
): MutableTarget =>
	(manager as unknown as { chunkTargets: MutableTarget[] }).chunkTargets[
		index
	];

/**
 * Builds a MarkerStore double that accepts writes and remembers none.
 * @returns The store double and its set spy
 */
export const makeFakeMarkerStore = (): {
	store: MarkerStore;
	set: jest.Mock;
} => {
	const set = jest.fn().mockResolvedValue(undefined);
	const store = {
		get: jest.fn().mockResolvedValue([]),
		set,
	} as unknown as MarkerStore;
	return { store, set };
};

// A store that actually remembers what was written, so reach-through
// edits/removals after stop can be asserted against the final state.
export const makeStatefulMarkerStore = (): {
	store: MarkerStore;
	set: jest.Mock;
	read: (path: string) => PlayerMarker[];
} => {
	const data = new Map<string, PlayerMarker[]>();
	const set = jest.fn((path: string, markers: PlayerMarker[]) => {
		data.set(path, [...markers]);
		return Promise.resolve();
	});
	const store = {
		get: jest.fn((path: string) => Promise.resolve(data.get(path) ?? [])),
		set,
	} as unknown as MarkerStore;
	return { store, set, read: (path) => data.get(path) ?? [] };
};
