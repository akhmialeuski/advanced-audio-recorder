/**
 * Tests for AudioStreamHandler error handling.
 * Verifies that proper errors are logged when device constraints cannot be satisfied.
 * @module tests/AudioStreamHandler.error.test
 */
/** @jest-environment jsdom */

import { RecordingManager } from '../src/recording/RecordingManager';
import { RecordingStatus } from '../src/types';
import {
    DEFAULT_SETTINGS,
    AudioRecorderSettings,
} from '../src/settings/Settings';
import { AudioStreamError } from '../src/recording/AudioStreamHandler';
import type { App } from 'obsidian';

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
}));

// Mock WavEncoder
jest.mock('../src/recording/WavEncoder', () => ({
    bufferToWave: jest
        .fn()
        .mockReturnValue(new Blob(['test'], { type: 'audio/wav' })),
}));

describe('AudioStreamHandler: Error Handling', () => {
    let manager: RecordingManager;
    let mockApp: App;
    let mockSettings: AudioRecorderSettings;
    let statusChangeCallback: jest.Mock;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

        mockApp = {
            vault: {
                adapter: { exists: jest.fn().mockResolvedValue(false) },
                createBinary: jest.fn().mockResolvedValue(undefined),
            },
            workspace: {
                getActiveViewOfType: jest.fn().mockReturnValue(null),
            },
        } as unknown as App;

        mockSettings = { ...DEFAULT_SETTINGS, audioDeviceId: 'test-device-id' };
        statusChangeCallback = jest.fn();
        manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);

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
                .MediaRecorder as unknown as Record<string, unknown>
        ).isTypeSupported = jest.fn().mockReturnValue(true);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('should log AudioStreamError when OverconstrainedError occurs', async () => {
        const getUserMediaMock = jest
            .fn()
            .mockRejectedValueOnce(
                new OverconstrainedError('deviceId', 'Constraint not satisfied'),
            );

        Object.defineProperty(navigator, 'mediaDevices', {
            value: {
                getUserMedia: getUserMediaMock,
                enumerateDevices: jest.fn().mockResolvedValue([]),
            },
            writable: true,
        });

        await manager.startRecording();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[AudioRecorder] Error in startRecording:',
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
                enumerateDevices: jest.fn().mockResolvedValue([]),
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
                enumerateDevices: jest.fn().mockResolvedValue([]),
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
                new OverconstrainedError('deviceId', 'Constraint not satisfied'),
            );

        Object.defineProperty(navigator, 'mediaDevices', {
            value: {
                getUserMedia: getUserMediaMock,
                enumerateDevices: jest.fn().mockResolvedValue([]),
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
                enumerateDevices: jest.fn().mockResolvedValue([]),
            },
            writable: true,
        });

        await manager.startRecording();

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
