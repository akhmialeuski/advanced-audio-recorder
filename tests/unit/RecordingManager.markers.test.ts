/**
 * Unit tests for RecordingManager marker drafts: capture, commit,
 * cancel, and persistence to the marker sidecar around session stop.
 * @module tests/unit/RecordingManager.markers.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { at } from '../helpers/assertions';
import { RecordingStatus } from 'src/types';
import { MARKER_KIND } from 'src/markers/markerModel';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import type { App } from 'obsidian';
import {
	createRecordingSut,
	installMediaRecorder,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
	recordingManagerOver,
	makeStatefulMarkerStore,
} from '../helpers/recordingManagerTestKit';
import { flushMicrotasks } from '../helpers/async';
import { Notice } from 'obsidian';

// Mock AudioStreamHandler
jest.mock('src/recording/AudioStreamHandler', () =>
	require('../mocks/modules/audioStreamHandler'),
);

// Mock AudioEncoder module to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () =>
	require('../mocks/modules/audioEncoder'),
);

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => require('../mocks/modules/wavEncoder'));

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
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
		({
			manager,
			app: mockApp,
			settings: mockSettings,
			onStatusChange: statusChangeCallback,
		} = createRecordingSut());
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

			installMediaRecorder(mockMediaRecorder);

			const { getAudioStreams } = jest.requireMock(
				'src/recording/AudioStreamHandler',
			);
			getAudioStreams.mockResolvedValue({
				streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
				trackOrder: [],
			});

			jest.mocked(mockApp.vault.adapter.readBinary).mockResolvedValue(
				new Uint8Array([1, 2, 3]).buffer,
			);
		});

		const feedChunkAndStop = async (): Promise<void> => {
			const chunk = new Blob([new Uint8Array([1, 2, 3])], {
				type: 'audio/webm',
			});
			mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);
			await Promise.resolve();
			await manager.stopRecording();
		};

		it('persists a marker dropped during recording to the sidecar at stop', async () => {
			const { store, writes } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			expect(handle).not.toBeNull();
			handle?.commit('Intro', MARKER_KIND.bookmark);
			await feedChunkAndStop();

			expect(writes).toHaveLength(1);
			const { path, markers } = at(writes, 0);
			expect(typeof path).toBe('string');
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({
				label: 'Intro',
				kind: MARKER_KIND.bookmark,
			});
			expect(at(markers, 0).time).toBeGreaterThanOrEqual(0);
			expect(at(markers, 0).id.length).toBeGreaterThan(0);
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
			const { store, writes } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			// Empty labels fall back to the auto-numbered default
			manager.captureMarkerDraft()?.commit('', MARKER_KIND.bookmark);
			manager.captureMarkerDraft()?.commit('', MARKER_KIND.bookmark);
			await feedChunkAndStop();

			const markers = at(writes, 0).markers;
			expect(markers.map((marker) => marker.label).sort()).toEqual([
				'Marker 1',
				'Marker 2',
			]);
		});

		it('says out loud when the session markers could not be saved', async () => {
			// A corrupt sidecar refuses the write; the loss of a whole
			// session's markers must reach the user, not just the console.
			const store = {
				getMarkers: jest.fn().mockResolvedValue([]),
				updateMarkers: jest
					.fn()
					.mockRejectedValue(new Error('sidecar could not be read')),
			} as unknown as import('src/sidecar/RecordingSidecarStore').RecordingSidecarStore;
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			manager.captureMarkerDraft()?.commit('Intro', MARKER_KIND.bookmark);
			await feedChunkAndStop();

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('could not be saved'),
			);
			expect(consoleErrorSpy).toHaveBeenCalled();
		});

		it('discards a cancelled marker so it is never persisted', async () => {
			const { store, update } = makeFakeMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			manager.captureMarkerDraft()?.cancel();
			await feedChunkAndStop();

			expect(update).not.toHaveBeenCalled();
		});

		it('applies a label edit committed after the session has stopped', async () => {
			const { store, writes, read } = makeStatefulMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			// Stop persists the draft with its default label while the modal
			// is still open; the user then finishes naming it.
			await feedChunkAndStop();
			handle?.commit('Renamed live', MARKER_KIND.chapter);
			await flushMicrotasks();

			const path = at(writes, 0).path;
			const final = read(path);
			expect(final).toHaveLength(1);
			expect(final[0]).toMatchObject({
				label: 'Renamed live',
				kind: MARKER_KIND.chapter,
			});
		});

		it('removes a marker cancelled after the session has stopped', async () => {
			const { store, writes, read } = makeStatefulMarkerStore();
			mockSettings = {
				...DEFAULT_SETTINGS,
				playerEnableMarkers: true,
				insertAtOriginalPosition: false,
			};
			manager = new RecordingManager(
				mockApp,
				mockSettings,
				statusChangeCallback,
				store,
			);

			await manager.startRecording();
			const handle = manager.captureMarkerDraft();
			await feedChunkAndStop();
			const path = at(writes, 0).path;
			expect(read(path)).toHaveLength(1);

			handle?.cancel();
			await flushMicrotasks();

			expect(read(path)).toHaveLength(0);
		});

		it('refuses to drop a marker when no recording is active', () => {
			mockSettings = { ...DEFAULT_SETTINGS, playerEnableMarkers: true };
			manager = recordingManagerOver(
				mockApp,
				mockSettings,
				statusChangeCallback,
			);

			expect(manager.canDropMarker()).toBe(false);
			expect(manager.captureMarkerDraft()).toBeNull();
		});

		it('refuses to drop a marker when markers are disabled', async () => {
			mockSettings = { ...DEFAULT_SETTINGS, playerEnableMarkers: false };
			manager = recordingManagerOver(
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
			manager = recordingManagerOver(
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
