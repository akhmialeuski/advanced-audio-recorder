/**
 * Shared setup for the RecordingManager unit test suites: media API
 * stubs, the App double, and the mock factories the split suites use.
 * jest.mock() calls cannot live in an imported helper (jest hoists
 * them within each test file), so every suite keeps its own jest.mock
 * blocks and imports the rest of the shared setup from here.
 * @module tests/helpers/recordingManagerTestKit
 */

import type { App } from 'obsidian';
import { RecordingManager } from 'src/recording/RecordingManager';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import type { TrackAudioSource } from 'src/recording/AudioStreamHandler';
import { partial } from './doubles';

/** The MediaRecorder constructor double, with its static format probe. */
export type MediaRecorderCtorMock = jest.Mock & {
	isTypeSupported: jest.Mock;
};

/**
 * Installs a MediaRecorder constructor returning the given recorder double.
 *
 * Assigning the global by hand needs a cast that erases the constructor's
 * type, which is why the static `isTypeSupported` used to be attached through
 * an `unknown` object. Doing it once here keeps the assignment typed and gives
 * the suites one place to change when the recorder surface grows.
 * @param recorder - The instance every `new MediaRecorder(...)` returns
 * @param isTypeSupported - Which MIME types the browser claims to record;
 *   defaults to all, which is what the recording-flow suites want
 * @returns The constructor mock, for call assertions
 */
export function installMediaRecorder(
	recorder?: unknown,
	isTypeSupported: (mimeType: string) => boolean = () => true,
): MediaRecorderCtorMock {
	return installMediaRecorderFactory(() => recorder, isTypeSupported);
}

/**
 * Installs a MediaRecorder constructor that builds a fresh double per call, for
 * the multi-track suites where each track gets its own recorder.
 * @param create - Called for each `new MediaRecorder(...)`
 * @param isTypeSupported - Which MIME types the browser claims to record
 * @returns The constructor mock, for call assertions
 */
export function installMediaRecorderFactory(
	create: () => unknown,
	isTypeSupported: (mimeType: string) => boolean = () => true,
): MediaRecorderCtorMock {
	const ctor = jest.fn(create) as MediaRecorderCtorMock;
	ctor.isTypeSupported = jest.fn(isTypeSupported);
	global.MediaRecorder = ctor;
	return ctor;
}

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
	state?: string;
	ondataavailable: ((event: BlobEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener: jest.Mock;
}

/** What a suite varies about the recorder it records through. */
export interface DesktopRecorderOptions {
	/**
	 * Whether `addEventListener('stop', h)` runs `h` on the spot. The real
	 * recorder fires it asynchronously; the suites that assert on what the
	 * stop handler wrote need it synchronous, and the ones that assert the
	 * manager's state *before* the handler runs need it not to fire at all.
	 */
	stopFiresImmediately?: boolean;
	/** Reported `state`, for the code paths that read it before stopping. */
	state?: string;
	/** Replaces `stop()`; throw from here to model an InvalidStateError. */
	stop?: jest.Mock;
}

/**
 * Builds the MediaRecorder double and installs it as the constructor.
 *
 * The recording suites do not vary this double - they vary one field of it -
 * so the shape lives here and each suite names only its own difference.
 * @param options - The one field this suite differs on
 * @returns The double every `new MediaRecorder(...)` hands back
 */
export const makeMediaRecorderDouble = (
	options: DesktopRecorderOptions = {},
): MockMediaRecorder => {
	const { stopFiresImmediately = true, state, stop } = options;
	const double: MockMediaRecorder = {
		start: jest.fn(),
		stop: stop ?? jest.fn(),
		pause: jest.fn(),
		resume: jest.fn(),
		ondataavailable: null,
		onerror: null,
		addEventListener: stopFiresImmediately
			? jest.fn((event: string, handler: () => void) => {
					if (event === 'stop') {
						handler();
					}
				})
			: jest.fn(),
	};
	if (state !== undefined) {
		double.state = state;
	}
	installMediaRecorder(double);
	return double;
};

/** A capture stream as the manager sees it: something with stoppable tracks. */
export interface StubStreamOptions {
	/** How many streams `getAudioStreams` resolves with. */
	count?: number;
	/** The `stop` spy on every track, when a test asserts the capture closed. */
	stopTrack?: jest.Mock;
	/** Track order the handler reports, empty unless a suite pins it. */
	trackOrder?: TrackAudioSource[];
}

/**
 * Points the mocked `getAudioStreams` at capture streams.
 * @param options - Stream count, the shared track-stop spy, and track order
 * @returns The streams it resolved with, so a test can assert on identity -
 *   which stream reached which bridge
 */
export const stubAudioStreams = (
	options: StubStreamOptions = {},
): MediaStream[] => {
	const { count = 1, stopTrack, trackOrder = [] } = options;
	const { getAudioStreams } = jest.requireMock<{
		getAudioStreams: jest.Mock;
	}>('src/recording/AudioStreamHandler');
	const streams = Array.from({ length: count }, () =>
		partial<MediaStream>({
			getTracks: () => [
				partial<MediaStreamTrack>({ stop: stopTrack ?? jest.fn() }),
			],
		}),
	);
	getAudioStreams.mockResolvedValue({ streams, trackOrder });
	return streams;
};

/**
 * Installs a single-stream MediaRecorder double whose stop event fires
 * synchronously, and points getAudioStreams at one desktop stream.
 * Platform flags are left untouched; call `useDesktopPlatform`
 * where the desktop code path is required.
 * @param options - Recorder differences, plus the track-stop spy
 * @returns The MediaRecorder double
 */
export const createDesktopRecorder = (
	options: DesktopRecorderOptions & Pick<StubStreamOptions, 'stopTrack'> = {},
): MockMediaRecorder => {
	const { stopTrack, ...recorder } = options;
	const double = makeMediaRecorderDouble(recorder);
	stubAudioStreams(stopTrack ? { stopTrack } : {});
	return double;
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
): MutableTarget => {
	const targets = (manager as unknown as { chunkTargets: MutableTarget[] })
		.chunkTargets;
	const target = targets[index];
	if (!target) {
		throw new Error(
			`No chunk target at index ${String(index)}; the manager has ` +
				`${String(targets.length)}`,
		);
	}
	return target;
};

/** One atomic marker write observed by a marker-store double. */
export interface MarkerWrite {
	path: string;
	markers: PlayerMarker[];
}

/**
 * Builds a marker-store double whose atomic updates always start from an
 * empty sidecar and remember nothing between writes.
 * @returns The store double, its update spy, and the observed writes
 */
export const makeFakeMarkerStore = (): {
	store: RecordingSidecarStore;
	update: jest.Mock;
	writes: MarkerWrite[];
} => {
	const writes: MarkerWrite[] = [];
	const update = jest.fn(
		(
			path: string,
			change: (
				existing: readonly PlayerMarker[],
			) => readonly PlayerMarker[],
		) => {
			const merged = [...change([])];
			writes.push({ path, markers: merged });
			return Promise.resolve(merged);
		},
	);
	const store = {
		getMarkers: jest.fn().mockResolvedValue([]),
		updateMarkers: update,
	} as unknown as RecordingSidecarStore;
	return { store, update, writes };
};

// A store that actually remembers what was written, so reach-through
// edits/removals after stop can be asserted against the final state.
export const makeStatefulMarkerStore = (): {
	store: RecordingSidecarStore;
	writes: MarkerWrite[];
	read: (path: string) => PlayerMarker[];
} => {
	const data = new Map<string, PlayerMarker[]>();
	const writes: MarkerWrite[] = [];
	const store = {
		getMarkers: jest.fn((path: string) =>
			Promise.resolve([...(data.get(path) ?? [])]),
		),
		updateMarkers: jest.fn(
			(
				path: string,
				change: (
					existing: readonly PlayerMarker[],
				) => readonly PlayerMarker[],
			) => {
				const merged = [...change(data.get(path) ?? [])];
				data.set(path, merged);
				writes.push({ path, markers: merged });
				return Promise.resolve(merged);
			},
		),
	} as unknown as RecordingSidecarStore;
	return { store, writes, read: (path) => data.get(path) ?? [] };
};

/** A RecordingManager with the collaborators a test asserts against. */
export interface RecordingSut {
	manager: RecordingManager;
	app: App;
	settings: AudioRecorderSettings;
	onStatusChange: jest.Mock;
	markers: RecordingSidecarStore;
	/** Everything written to the marker store, in order. */
	markerWrites: MarkerWrite[];
	/** The store's updateMarkers spy. */
	markerUpdate: jest.Mock;
}

/**
 * Builds a RecordingManager and everything it was built from.
 *
 * Six suites in this family opened with the same fifteen-line `beforeEach` and
 * repeated the constructor call forty times between them, so a change to the
 * manager's signature meant forty edits. Returning the collaborators alongside
 * the manager also means a test states what it varies - `{ settings: { ... } }`
 * - instead of reassigning a `let` from an outer scope.
 * @param overrides - What this test needs different from the defaults
 * @returns The manager and its collaborators
 */
export const createRecordingSut = (
	overrides: {
		app?: App;
		settings?: Partial<AudioRecorderSettings>;
		onStatusChange?: jest.Mock;
		markerStore?: {
			store: RecordingSidecarStore;
			update: jest.Mock;
			writes: MarkerWrite[];
		};
	} = {},
): RecordingSut => {
	const app = overrides.app ?? createRecordingMockApp();
	const settings: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		...overrides.settings,
	};
	const onStatusChange = overrides.onStatusChange ?? jest.fn();
	const markerStore = overrides.markerStore ?? makeFakeMarkerStore();
	return {
		manager: new RecordingManager(
			app,
			settings,
			onStatusChange,
			markerStore.store,
		),
		app,
		settings,
		onStatusChange,
		markers: markerStore.store,
		markerWrites: markerStore.writes,
		markerUpdate: markerStore.update,
	};
};

/**
 * Rebuilds the manager over collaborators a test already holds, for the case
 * where it changed the settings after the initial build.
 * @param app - The app the manager reads the vault through
 * @param settings - The settings it should now run with
 * @param onStatusChange - The status callback to report through
 * @returns A fresh manager
 */
export const recordingManagerOver = (
	app: App,
	settings: AudioRecorderSettings,
	onStatusChange: jest.Mock,
): RecordingManager =>
	new RecordingManager(
		app,
		settings,
		onStatusChange,
		makeFakeMarkerStore().store,
	);

/**
 * Installs a bank of MediaRecorder doubles, one per track, and points
 * getAudioStreams at a matching set of streams.
 *
 * Five tests across the output and streaming suites hand-rolled this same
 * thirty-line arrange - a pair of recorders whose stop event fires
 * synchronously, plus the streams they were opened over - which is what pushed
 * one of them past a hundred lines.
 * @param trackCount - How many tracks are recording at once
 * @returns The recorder doubles, in the order the manager receives them
 */
export const installMultiTrackRecorders = (
	trackCount: number,
): MediaRecorderDoubleInstance[] => {
	const recorders = Array.from({ length: trackCount }, () => ({
		start: jest.fn(),
		stop: jest.fn(),
		pause: jest.fn(),
		resume: jest.fn(),
		ondataavailable: null as ((event: BlobEvent) => void) | null,
		onerror: null as ((event: Event) => void) | null,
		addEventListener: jest.fn((event: string, handler: () => void) => {
			if (event === 'stop') {
				handler();
			}
		}),
	}));
	let index = 0;
	installMediaRecorderFactory(() => {
		const recorder = recorders[index] ?? recorders[0];
		index += 1;
		return recorder;
	});
	const streams = jest.requireMock<{ getAudioStreams: jest.Mock }>(
		'src/recording/AudioStreamHandler',
	);
	streams.getAudioStreams.mockResolvedValue({
		streams: recorders.map(() => ({
			getTracks: () => [{ stop: jest.fn() }],
		})),
		trackOrder: [],
	});
	return recorders;
};

/** One recorder double from {@link installMultiTrackRecorders}. */
export interface MediaRecorderDoubleInstance {
	start: jest.Mock;
	stop: jest.Mock;
	pause: jest.Mock;
	resume: jest.Mock;
	ondataavailable: ((event: BlobEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener: jest.Mock;
}
