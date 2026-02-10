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
import { AudioStreamError } from '../src/errors';
import { PLUGIN_LOG_PREFIX } from '../src/constants';
import type { App } from 'obsidian';

// Mock AudioContext and OfflineAudioContext
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

// Mock AudioBuffer
(global as any).AudioBuffer = jest.fn().mockImplementation(() => ({
    getChannelData: jest.fn().mockReturnValue(new Float32Array(44100)),
}));

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
                adapter: {
                    exists: jest.fn().mockResolvedValue(false),
                    append: jest.fn().mockResolvedValue(undefined),
                    rename: jest.fn().mockResolvedValue(undefined),
                    readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
                    remove: jest.fn().mockResolvedValue(undefined),
                },
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
