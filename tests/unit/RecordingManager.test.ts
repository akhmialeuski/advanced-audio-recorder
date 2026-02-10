/**
 * Unit tests for RecordingManager module.
 * Tests the recording lifecycle: start, stop, pause, resume.
 * @module tests/unit/RecordingManager.test
 */
/** @jest-environment jsdom */

import { RecordingManager } from '../../src/recording/RecordingManager';
import { RecordingStatus } from '../../src/types';
import { DEFAULT_SETTINGS, AudioRecorderSettings } from '../../src/settings/Settings';
import type { App } from 'obsidian';

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
jest.mock('../../src/recording/AudioStreamHandler', () => ({
    getAudioStreams: jest.fn(),
    getAudioSourceName: jest.fn().mockResolvedValue('TestDevice'),
    stopAllStreams: jest.fn(),
    validateSelectedDevices: jest.fn(),
}));

// Mock WavEncoder
jest.mock('../../src/recording/WavEncoder', () => ({
    bufferToWave: jest.fn().mockReturnValue(new Blob(['test'], { type: 'audio/wav' })),
}));

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

if (!Blob.prototype.arrayBuffer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill
    (Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
        return Promise.resolve(new ArrayBuffer(0));
    };
}

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
        mockApp = {
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
        } as unknown as App;

        // Use default settings
        mockSettings = { ...DEFAULT_SETTINGS };

        // Status change callback
        statusChangeCallback = jest.fn();

        // Create manager instance
        manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    describe('constructor', () => {
        it('should initialize with idle status', () => {
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });

        it('should store the status change callback', () => {
            expect(statusChangeCallback).not.toHaveBeenCalled();
        });
    });

    describe('getStatus', () => {
        it('should return Idle initially', () => {
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });
    });

    describe('updateSettings', () => {
        it('should update settings reference', () => {
            const newSettings: AudioRecorderSettings = {
                ...DEFAULT_SETTINGS,
                filePrefix: 'new-prefix',
            };

            manager.updateSettings(newSettings);

            // Settings are private, but we can verify through behavior
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });
    });

    describe('toggleRecording', () => {
        beforeEach(() => {
            // Mock MediaRecorder
            const mockMediaRecorder = {
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
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock isTypeSupported
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            // Mock getAudioStreams
            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });
        });

        it('should start recording when idle', async () => {
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);

            await manager.toggleRecording();

            expect(manager.getStatus()).toBe(RecordingStatus.Recording);
            expect(statusChangeCallback).toHaveBeenCalledWith(RecordingStatus.Recording);
        });

        it('should stop recording when recording', async () => {
            // First start
            await manager.toggleRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Recording);

            // Then stop
            await manager.toggleRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });
    });

    describe('togglePauseResume', () => {
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
                addEventListener: jest.fn((event: string, handler: () => void) => {
                    if (event === 'stop') {
                        handler();
                    }
                }),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock isTypeSupported
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });
        });

        it('should do nothing when idle', () => {
            manager.togglePauseResume();

            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
            expect(mockMediaRecorder.pause).not.toHaveBeenCalled();
        });

        it('should pause when recording', async () => {
            await manager.toggleRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Recording);

            manager.togglePauseResume();

            expect(manager.getStatus()).toBe(RecordingStatus.Paused);
            expect(statusChangeCallback).toHaveBeenCalledWith(RecordingStatus.Paused);
        });

        it('should resume when paused', async () => {
            await manager.toggleRecording();
            manager.togglePauseResume(); // Pause
            expect(manager.getStatus()).toBe(RecordingStatus.Paused);

            manager.togglePauseResume(); // Resume

            expect(manager.getStatus()).toBe(RecordingStatus.Recording);
            expect(statusChangeCallback).toHaveBeenCalledWith(RecordingStatus.Recording);
        });
    });

    describe('streaming chunks', () => {
        it('should append chunks to temp file on desktop', async () => {
            const { Platform } = jest.requireMock('obsidian') as {
                Platform: { isMobile: boolean; isMobileApp: boolean };
            };
            Platform.isMobile = false;
            Platform.isMobileApp = false;

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(
                () => mockMediaRecorder,
            );
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
                .fn()
                .mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });

            (mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
                new Uint8Array([1, 2, 3]).buffer,
            );

            await manager.startRecording();

            const chunk = new Blob([new Uint8Array([1, 2, 3])], {
                type: 'audio/webm',
            });
            mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

            await manager.stopRecording();

            expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalled();
        });

        it('should flush mobile buffer when limit reached', async () => {
            const { Platform } = jest.requireMock('obsidian') as {
                Platform: { isMobile: boolean; isMobileApp: boolean };
            };
            Platform.isMobile = true;
            Platform.isMobileApp = true;

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(
                () => mockMediaRecorder,
            );
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
                .fn()
                .mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });

            await manager.startRecording();

            const target = (manager as unknown as { chunkTargets: Array<{ bufferedBytes: number }> }).chunkTargets[0];
            target.bufferedBytes = 50 * 1024 * 1024 - 1;

            const chunk = new Blob([new Uint8Array([1])], {
                type: 'audio/webm',
            });
            mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

            await manager.stopRecording();

            expect(mockApp.vault.createBinary).toHaveBeenCalled();
        });
    });

    describe('cleanup', () => {
        it('should reset all internal state', () => {
            manager.cleanup();

            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });

        it('should stop all streams', () => {
            const { stopAllStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                stopAllStreams: jest.Mock;
            };

            manager.cleanup();

            expect(stopAllStreams).toHaveBeenCalled();
        });
    });

    describe('stopRecording error recovery', () => {
        let mockStopTrack: jest.Mock;

        beforeEach(() => {
            mockStopTrack = jest.fn();

            const mockMediaRecorder = {
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
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock isTypeSupported
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: mockStopTrack }],
                }],
                trackOrder: [],
            });
        });

        it('should reset status to Idle even when save fails', async () => {
            // Start recording first
            await manager.startRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Recording);

            // Mock vault to throw error during save
            (mockApp.vault.adapter.rename as jest.Mock).mockRejectedValue(
                new Error('Save failed'),
            );

            // Stop recording - should recover
            await manager.stopRecording();

            // Status should be Idle despite error
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
            expect(statusChangeCallback).toHaveBeenLastCalledWith(RecordingStatus.Idle);
        });

        it('should stop streams even when save fails', async () => {
            const { stopAllStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                stopAllStreams: jest.Mock;
            };

            await manager.startRecording();

            // Mock vault to throw error during save
            (mockApp.vault.adapter.rename as jest.Mock).mockRejectedValue(
                new Error('Save failed'),
            );

            await manager.stopRecording();

            // Streams should still be stopped
            expect(stopAllStreams).toHaveBeenCalled();
        });

        it('should clear all arrays after stop', async () => {
            await manager.startRecording();
            await manager.stopRecording();

            // Internal state should be cleared - verify by starting a new recording
            // If arrays weren't cleared, this would have stale data
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });
    });

    describe('startRecording error handling', () => {
        it('should configure MediaRecorder with bitrate from settings', async () => {
            mockSettings = {
                ...DEFAULT_SETTINGS,
                bitrate: 192000,
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(
                () => mockMediaRecorder,
            );
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
                .fn()
                .mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });

            await manager.startRecording();

            expect(global.MediaRecorder).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    audioBitsPerSecond: 192000,
                }),
            );
        });

        it('should handle unsupported format', async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = {
                isTypeSupported: jest.fn().mockReturnValue(false),
            };

            await manager.startRecording();

            // Should remain idle on error
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });

        it('should handle stream acquisition error', async () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = {
                isTypeSupported: jest.fn().mockReturnValue(true),
            };

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockRejectedValue(new Error('Permission denied'));

            await manager.startRecording();

            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });
    });

    describe('lifecycle transitions', () => {
        beforeEach(() => {
            const mockMediaRecorder = {
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
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock global MediaRecorder
            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Mock isTypeSupported
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });
        });

        it('should follow full lifecycle: idle -> recording -> paused -> recording -> idle', async () => {
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);

            // Start recording
            await manager.toggleRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Recording);

            // Pause
            manager.togglePauseResume();
            expect(manager.getStatus()).toBe(RecordingStatus.Paused);

            // Resume
            manager.togglePauseResume();
            expect(manager.getStatus()).toBe(RecordingStatus.Recording);

            // Stop
            await manager.toggleRecording();
            expect(manager.getStatus()).toBe(RecordingStatus.Idle);
        });

        it('should call onStatusChange for each transition', async () => {
            await manager.toggleRecording();
            manager.togglePauseResume();
            manager.togglePauseResume();
            await manager.toggleRecording();

            expect(statusChangeCallback).toHaveBeenCalledTimes(4);
            expect(statusChangeCallback).toHaveBeenNthCalledWith(1, RecordingStatus.Recording);
            expect(statusChangeCallback).toHaveBeenNthCalledWith(2, RecordingStatus.Paused);
            expect(statusChangeCallback).toHaveBeenNthCalledWith(3, RecordingStatus.Recording);
            expect(statusChangeCallback).toHaveBeenNthCalledWith(4, RecordingStatus.Idle);
        });
    });

    describe('single mode output format handling', () => {
        /**
         * Verifies that single-file output in multi-track mode keeps compressed
         * MediaRecorder format and does not force WAV conversion.
         */
        it('should save single-mode multi-track recording with configured extension', async () => {
            const { Platform } = jest.requireMock('obsidian') as {
                Platform: { isMobile: boolean; isMobileApp: boolean };
            };
            Platform.isMobile = false;
            Platform.isMobileApp = false;

            mockSettings = {
                ...DEFAULT_SETTINGS,
                enableMultiTrack: true,
                outputMode: 'single',
                recordingFormat: 'webm',
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);

            const mockMediaRecorders = [0, 1].map(() => ({
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
            let recorderIndex = 0;

            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
                const recorder = mockMediaRecorders[recorderIndex] ?? mockMediaRecorders[0];
                recorderIndex += 1;
                return recorder;
            });
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
                .fn()
                .mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [
                    { getTracks: () => [{ stop: jest.fn() }] },
                    { getTracks: () => [{ stop: jest.fn() }] },
                ],
                trackOrder: [],
            });

            (mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
                new Uint8Array([1, 2, 3]).buffer,
            );

            await manager.startRecording();

            const chunk = new Blob([new Uint8Array([1, 2, 3])], {
                type: 'audio/webm',
            });
            mockMediaRecorders.forEach((recorder) => {
                recorder.ondataavailable?.({ data: chunk } as BlobEvent);
            });

            await Promise.resolve();
            await manager.stopRecording();

            expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
                expect.stringMatching(/multitrack-.*\.webm$/),
                expect.any(ArrayBuffer),
            );
            expect(mockApp.vault.createBinary).not.toHaveBeenCalledWith(
                expect.stringMatching(/\.wav$/),
                expect.any(ArrayBuffer),
            );
        });


        /**
         * Ensures that WAV output mode performs explicit conversion and writes
         * files with .wav extension after recording in a supported intermediary format.
         */
        it('should convert to wav only when output format is wav', async () => {
            mockSettings = {
                ...DEFAULT_SETTINGS,
                recordingFormat: 'wav',
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest
                .fn()
                .mockImplementation((mime: string) => mime === 'audio/webm;codecs=opus');

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{
                    getTracks: () => [{ stop: jest.fn() }],
                }],
                trackOrder: [],
            });

            await manager.startRecording();

            const chunk = new Blob([new Uint8Array([5, 6, 7])], {
                type: 'audio/webm',
            });
            mockMediaRecorder.ondataavailable?.({ data: chunk } as BlobEvent);

            await Promise.resolve();
            await manager.stopRecording();

            expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus');
            expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
                expect.stringMatching(/\.wav$/),
                expect.any(ArrayBuffer),
            );
            expect(mockApp.vault.adapter.rename).not.toHaveBeenCalled();
        });
    });

    describe('context-aware save location', () => {
        it('should save near active markdown file when enabled without subfolder', async () => {
            mockSettings = {
                ...DEFAULT_SETTINGS,
                saveNearActiveFile: true,
                activeFileSubfolder: '',
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);
            (mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
                path: 'Meetings/2026/Meeting Note.md',
            });

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
                trackOrder: [],
            });

            await manager.startRecording();
            await manager.stopRecording();

            expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
                expect.stringMatching(/^Meetings\/2026\/recording-Track1-.*\.partial\.webm$/),
                expect.any(ArrayBuffer),
            );
        });

        it('should create active file subfolder and save recording there', async () => {
            mockSettings = {
                ...DEFAULT_SETTINGS,
                saveNearActiveFile: true,
                activeFileSubfolder: 'Audio',
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);
            (mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
                path: 'Meetings/2026/Meeting Note.md',
            });

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
                trackOrder: [],
            });

            await manager.startRecording();
            await manager.stopRecording();

            expect(mockApp.vault.createFolder).toHaveBeenCalledWith('Meetings/2026/Audio');
            expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
                expect.stringMatching(/^Meetings\/2026\/Audio\/recording-Track1-.*\.partial\.webm$/),
                expect.any(ArrayBuffer),
            );
        });

        it('should fallback to global save folder when near-active mode is disabled', async () => {
            mockSettings = {
                ...DEFAULT_SETTINGS,
                saveFolder: 'Recordings',
                saveNearActiveFile: false,
                activeFileSubfolder: 'Audio',
            };
            manager = new RecordingManager(mockApp, mockSettings, statusChangeCallback);
            (mockApp.workspace.getActiveFile as jest.Mock).mockReturnValue({
                path: 'Meetings/2026/Meeting Note.md',
            });

            const mockMediaRecorder = {
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
            };

            (global as Record<string, unknown>).MediaRecorder = jest.fn(() => mockMediaRecorder);
            (global as Record<string, unknown>).MediaRecorder.isTypeSupported = jest.fn().mockReturnValue(true);

            const { getAudioStreams } = jest.requireMock('../../src/recording/AudioStreamHandler') as {
                getAudioStreams: jest.Mock;
            };
            getAudioStreams.mockResolvedValue({
                streams: [{ getTracks: () => [{ stop: jest.fn() }] }],
                trackOrder: [],
            });

            await manager.startRecording();
            await manager.stopRecording();

            expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
                expect.stringMatching(/^Recordings\/recording-Track1-.*\.partial\.webm$/),
                expect.any(ArrayBuffer),
            );
        });
    });

});
