/**
 * Tests for the RecordingManager start-failure fallback paths.
 * Verifies that stream errors surface to the user and release the
 * partially opened session.
 * @module tests/unit/RecordingManager.fallback.test
 */

import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingStatus } from 'src/types';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { AudioStreamError } from 'src/errors';
import { PLUGIN_LOG_PREFIX } from 'src/constants';
import type { App } from 'obsidian';
import {
	createRecordingMockApp,
	installRecordingMediaStubs,
	makeFakeMarkerStore,
} from './helpers/recordingManagerTestKit';

// Mock AudioContext, OfflineAudioContext, and AudioBuffer. The kit's
// AudioContext stub has no audioWorklet, so the real PcmStreamRecorder
// used below fails to start like a broken worklet load.
installRecordingMediaStubs();

// Mock OverconstrainedError if not present in JSDOM
class OverconstrainedError extends Error {
	constraint: string;
	constructor(constraint: string, message?: string) {
		super(message || 'OverconstrainedError');
		this.name = 'OverconstrainedError';
		this.constraint = constraint;
	}
}
(global as unknown as Record<string, unknown>).OverconstrainedError =
	OverconstrainedError;

// Mock obsidian module
const mockNotice = jest.fn();
jest.mock('obsidian', () => ({
	Notice: jest.fn().mockImplementation((msg: string) => mockNotice(msg)),
	MarkdownView: jest.fn(),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Platform: {
		isMobile: false,
		isMobileApp: false,
	},
}));

// Mock WavEncoder
jest.mock('src/audio/WavEncoder', () => ({
	assembleWavFromPcmSegmentFiles: jest
		.fn()
		.mockResolvedValue(new ArrayBuffer(44)),
}));

describe('AudioStreamHandler: Error Handling', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		mockApp = createRecordingMockApp();

		mockSettings = { ...DEFAULT_SETTINGS, audioDeviceId: 'test-device-id' };
		statusChangeCallback = jest.fn();
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
			makeFakeMarkerStore().store,
		);

		// Mock MediaRecorder
		const mockMediaRecorder = {
			start: jest.fn(),
			stop: jest.fn(),
			ondataavailable: null,
			onerror: null,
		};
		(global as unknown as Record<string, unknown>).MediaRecorder = jest.fn(
			() => mockMediaRecorder,
		);
		(
			(global as unknown as Record<string, unknown>)
				.MediaRecorder as Record<string, unknown>
		).isTypeSupported = jest.fn().mockReturnValue(true);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it('should log AudioStreamError when OverconstrainedError occurs', async () => {
		const getUserMediaMock = jest
			.fn()
			.mockRejectedValueOnce(
				new OverconstrainedError(
					'deviceId',
					'Constraint not satisfied',
				),
			);

		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: getUserMediaMock,
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});

		await manager.startRecording();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			`${PLUGIN_LOG_PREFIX} Error in startRecording:`,
			expect.any(AudioStreamError),
		);
	});

	it('should show Notice with error message containing device ID', async () => {
		const getUserMediaMock = jest
			.fn()
			.mockRejectedValueOnce(
				new OverconstrainedError('deviceId', 'Device not found'),
			);

		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: getUserMediaMock,
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});

		await manager.startRecording();

		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('test-device-id'),
		);
	});

	it('should suggest checking plugin settings in Notice', async () => {
		const getUserMediaMock = jest
			.fn()
			.mockRejectedValueOnce(new Error('NotFoundError'));

		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: getUserMediaMock,
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});

		await manager.startRecording();

		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('verify the device in plugin settings'),
		);
	});

	it('should not fallback to default device', async () => {
		const getUserMediaMock = jest
			.fn()
			.mockRejectedValueOnce(
				new OverconstrainedError(
					'deviceId',
					'Constraint not satisfied',
				),
			);

		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: getUserMediaMock,
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});

		await manager.startRecording();

		// getUserMedia should only be called once (no fallback attempt)
		expect(getUserMediaMock).toHaveBeenCalledTimes(1);
	});

	it('should remain in Idle status on error', async () => {
		const getUserMediaMock = jest
			.fn()
			.mockRejectedValueOnce(new Error('Access denied'));

		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: getUserMediaMock,
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});

		await manager.startRecording();

		expect(manager.getStatus()).toBe(RecordingStatus.Idle);
	});
});

describe('Start failure after stream acquisition', () => {
	let manager: RecordingManager;
	let mockApp: App;
	let mockSettings: AudioRecorderSettings;
	let statusChangeCallback: jest.Mock;
	let consoleErrorSpy: jest.SpyInstance;
	let trackStop: jest.Mock;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

		mockApp = createRecordingMockApp();

		mockSettings = { ...DEFAULT_SETTINGS, audioDeviceId: 'test-device-id' };
		statusChangeCallback = jest.fn();
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
			makeFakeMarkerStore().store,
		);

		trackStop = jest.fn();
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: jest.fn().mockResolvedValue({
					getTracks: () => [{ stop: trackStop }],
				}),
				enumerateDevices: jest.fn().mockResolvedValue([
					{
						deviceId: 'test-device-id',
						kind: 'audioinput',
						label: 'Test Device',
					},
				]),
			},
			writable: true,
		});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it('should stop acquired tracks when MediaRecorder creation fails', async () => {
		(global as unknown as Record<string, unknown>).MediaRecorder = jest.fn(
			() => {
				throw new Error('mimeType not supported');
			},
		);
		(
			(global as unknown as Record<string, unknown>)
				.MediaRecorder as Record<string, unknown>
		).isTypeSupported = jest.fn().mockReturnValue(true);

		await manager.startRecording();

		expect(trackStop).toHaveBeenCalled();
		expect(manager.getStatus()).toBe(RecordingStatus.Idle);
	});

	it('should stop acquired tracks when PCM capture fails to start', async () => {
		// The module-level AudioContext mock has no audioWorklet, so the
		// real PcmStreamRecorder.start() fails like a broken worklet load
		(global as unknown as Record<string, unknown>).MediaRecorder =
			jest.fn();
		(
			(global as unknown as Record<string, unknown>)
				.MediaRecorder as Record<string, unknown>
		).isTypeSupported = jest.fn().mockReturnValue(true);

		mockSettings = {
			...DEFAULT_SETTINGS,
			audioDeviceId: 'test-device-id',
			recordingFormat: 'wav',
		};
		manager = new RecordingManager(
			mockApp,
			mockSettings,
			statusChangeCallback,
			makeFakeMarkerStore().store,
		);

		await manager.startRecording();

		expect(trackStop).toHaveBeenCalled();
		expect(manager.getStatus()).toBe(RecordingStatus.Idle);
	});
});

describe('AudioStreamError', () => {
	it('should create error with device ID', () => {
		const original = new Error('Original error');
		const error = new AudioStreamError(original, 'my-device-id');

		expect(error.name).toBe('AudioStreamError');
		expect(error.message).toContain('my-device-id');
		expect(error.originalError).toBe(original);
		expect(error.deviceId).toBe('my-device-id');
	});

	it('should create error without device ID', () => {
		const original = new Error('Original error');
		const error = new AudioStreamError(original);

		expect(error.name).toBe('AudioStreamError');
		expect(error.message).toContain('Failed to access audio device');
		expect(error.message).toContain('Original error');
		expect(error.deviceId).toBeUndefined();
	});
});
