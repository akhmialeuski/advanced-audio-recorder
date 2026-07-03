/**
 * Unit tests for RecordingManager marker drafts: capture, commit,
 * cancel, and persistence to the marker sidecar around session stop.
 * @module tests/unit/RecordingManager.markers.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingStatus } from 'src/types';
import { MARKER_KIND } from 'src/markers/markerModel';
import type { PlayerMarker } from 'src/markers/markerModel';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createRecordingMockApp,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	makeStatefulMarkerStore,
} from './helpers/recordingManagerTestKit';

// Mock obsidian module
jest.mock('obsidian', () => ({
	Notice: jest.fn(),
	MarkdownView: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Platform: {
		isMobile: false,
		isMobileApp: false,
	},
}));

// Mock AudioStreamHandler
jest.mock('src/recording/AudioStreamHandler', () => ({
	getAudioStreams: jest.fn(),
	getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
	stopAllStreams: jest.fn(),
	validateSelectedDevices: jest.fn(),
}));

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn((format: string) => {
		return ['mp3', 'flac', 'aac', 'webm', 'ogg', 'mp4', 'm4a'].includes(
			format,
		);
	}),
}));

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest
		.fn()
		.mockResolvedValue(new ArrayBuffer(44)),
}));

// Mock PcmStreamRecorder
jest.mock('src/recording/PcmStreamRecorder', () => ({
	PcmStreamRecorder: jest.fn().mockImplementation(() => ({
		channels: 1,
		sampleRate: 44100,
		start: jest.fn().mockResolvedValue(undefined),
		stop: jest.fn().mockResolvedValue(undefined),
		pause: jest.fn(),
		resume: jest.fn(),
	})),
}));

installRecordingMediaStubs();

describe('RecordingManager', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks();
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		// Create mock App
		mockApp = createRecordingMockApp();

		// Use default settings
		mockSettings = { ...DEFAULT_SETTINGS };

		// Status change callback
		statusChangeCallback = jest.fn();

		// Create manager instance
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
		);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	describe('marker draft capture and persistence', () => {
		let mockMediaRecorder: {
			start: jest.Mock;
			stop: jest.Mock;
			pause: jest.Mock;
			resume: jest.Mock;
			ondataavailable: ((event: BlobEvent) => void) | null;
			onerror: ((event: Event) => void) | null;
			addEventListener: jest.Mock;
		};

		beforeEach(() => {
			mockMediaRecorder = {
				start: jest.fn(),
				stop: jest.fn(),
				pause: jest.fn(),
				resume: jest.fn(),
				ondataavailable: null,
				onerror: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							handler();
						}
					},
				),
			};

			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => mockMediaRecorder,
			);
			(global as Record<string, unknown>).MediaRecorder.isTypeSupported =
				jest.fn().mockReturnValue(true);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		// A commit/cancel queues fire-and-forget sidecar writes (get -> set is
		// two microtask hops); draining a few turns lets them settle.
		const flushMicrotasks = async (): Promise<void> => {
			for (let i = 0; i < 5; i++) {
				await Promise.resolve();
			}
		};

		const feedChunkAndStop = async (): Promise<void> => {
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();
		};

		it('persists a marker dropped during recording to the sidecar at stop', async () => {
			const { store, set } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			expect(handle).not.toBeNull();
			handle?.commit('Intro', MARKER_KIND.bookmark);
			await feedChunkAndStop();

			expect(set).toHaveBeenCalledTimes(1);
			const [path, markers] = set.mock.calls[0] as [
				string,
				PlayerMarker[],
			];
			expect(typeof path).toBe('string');
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({
				label: 'Intro',
				kind: MARKER_KIND.bookmark,
			});
			expect(markers[0].time).toBeGreaterThanOrEqual(0);
			expect(markers[0].id.length).toBeGreaterThan(0);
		});

		it('fixes the draft kind up front when a preselect kind is passed', async () => {
			const { store } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			// The kind-fixed commands (add bookmark/add chapter) preselect
			// the kind instead of reusing the last modal choice
			const handle = manager.captureMarkerDraft(MARKER_KIND.chapter);
			expect(handle?.initialKind).toBe(MARKER_KIND.chapter);
			// The default label follows the preselected kind's numbering
			expect(handle?.defaultLabelFor(MARKER_KIND.chapter)).toContain(
				'Chapter',
			);
			handle?.cancel();
			await manager.stopRecording();
		});

		it('numbers default marker labels sequentially within a session', async () => {
			const { store, set } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			// Empty labels fall back to the auto-numbered default
			manager.captureMarkerDraft()?.commit('', MARKER_KIND.bookmark);
			manager.captureMarkerDraft()?.commit('', MARKER_KIND.bookmark);
			await feedChunkAndStop();

			const markers = set.mock.calls[0][1] as PlayerMarker[];
			expect(markers.map((marker) => marker.label).sort()).toEqual([
				'Marker 1',
				'Marker 2',
			]);
		});

		it('discards a cancelled marker so it is never persisted', async () => {
			const { store, set } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			manager.captureMarkerDraft()?.cancel();
			await feedChunkAndStop();

			expect(set).not.toHaveBeenCalled();
		});

		it('applies a label edit committed after the session has stopped', async () => {
			const { store, set, read } = makeStatefulMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			// Stop persists the draft with its default label while the modal
			// is still open; the user then finishes naming it.
			await feedChunkAndStop();
			handle?.commit('Renamed live', MARKER_KIND.chapter);
			await flushMicrotasks();

			const path = set.mock.calls[0][0] as string;
			const final = read(path);
			expect(final).toHaveLength(1);
			expect(final[0]).toMatchObject({
				label: 'Renamed live',
				kind: MARKER_KIND.chapter,
			});
		});

		it('removes a marker cancelled after the session has stopped', async () => {
			const { store, set, read } = makeStatefulMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				undefined,
				undefined,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			await feedChunkAndStop();
			const path = set.mock.calls[0][0] as string;
			expect(read(path)).toHaveLength(1);

			handle?.cancel();
			await flushMicrotasks();

			expect(read(path)).toHaveLength(0);
		});

		it('refuses to drop a marker when no recording is active', () => {
			mockSettings = { ...DEFAULT_SETTINGS, playerEnableMarkers: true };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			expect(manager.canDropMarker()).toBe(false);
			expect(manager.captureMarkerDraft()).toBeNull();
		});

		it('refuses to drop a marker when markers are disabled', async () => {
			mockSettings = { ...DEFAULT_SETTINGS, playerEnableMarkers: false };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			expect(manager.canDropMarker()).toBe(false);
			expect(manager.captureMarkerDraft()).toBeNull();
			await manager.stopRecording();
		});

		it('still allows dropping a marker while paused', async () => {
			mockSettings = { ...DEFAULT_SETTINGS, playerEnableMarkers: true };
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			await manager.startRecording();
			manager.togglePauseResume();
			expect(manager.getStatus()).toBe(RecordingStatus.Paused);
			expect(manager.canDropMarker()).toBe(true);
			expect(manager.captureMarkerDraft()).not.toBeNull();
			await manager.stopRecording();
		});
	});
});
