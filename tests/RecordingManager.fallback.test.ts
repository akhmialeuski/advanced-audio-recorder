/**
 * Reproduction test for OverconstrainedError bug.
 * Verifies that recording fails when device constraints cannot be satisfied.
 * @module tests/repro_issue.test
 */
/** @jest-environment jsdom */

import { RecordingManager } from '../src/recording/RecordingManager';
import { RecordingStatus } from '../src/types';
import { DEFAULT_SETTINGS, AudioRecorderSettings } from '../src/settings/Settings';
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
(global as any).OverconstrainedError = OverconstrainedError;

// Mock obsidian module
jest.mock('obsidian', () => ({
    Notice: jest.fn(),
    MarkdownView: jest.fn(),
    normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

// Mock WavEncoder
jest.mock('../src/recording/WavEncoder', () => ({
    bufferToWave: jest.fn().mockReturnValue(new Blob(['test'], { type: 'audio/wav' })),
}));

describe('Reproduction: OverconstrainedError', () => {
    let manager: RecordingManager;
    let mockApp: App;
    let mockSettings: AudioRecorderSettings;
    let statusChangeCallback: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

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
        (global as any).MediaRecorder = jest.fn(() => mockMediaRecorder);
        (global as any).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);
    });

    it('should start recording using fallback when OverconstrainedError occurs', async () => {
        // Setup: Mock getUserMedia to throw OverconstrainedError on first attempt, then success on fallback

        // We need to mock navigator.mediaDevices.getUserMedia specifically for this test
        const getUserMediaMock = jest.fn()
            .mockRejectedValueOnce(new OverconstrainedError('deviceId', 'Constraint not satisfied')) // First call fails
            .mockResolvedValueOnce({ // Second call succeeds (fallback)
                getTracks: () => [{ stop: jest.fn() }]
            } as any); // Cast to any or partial MediaStream

        Object.defineProperty(navigator, 'mediaDevices', {
            value: {
                getUserMedia: getUserMediaMock,
                enumerateDevices: jest.fn().mockResolvedValue([])
            },
            writable: true
        });

        // Spy on console.warn to verify fallback log
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        // Action: Attempt to start recording
        await manager.startRecording();

        // Assertion: Status should be Recording (success)
        expect(manager.getStatus()).toBe(RecordingStatus.Recording);

        // Assertion: Fallback warning should be logged
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Falling back to default device')
        );

        consoleSpy.mockRestore();
    });
});
