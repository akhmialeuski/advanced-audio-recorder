/**
 * Unit tests for Settings module.
 * @module tests/unit/Settings.test
 */

import {
    AudioRecorderSettings,
    DEFAULT_SETTINGS,
    mergeSettings,
    OutputMode,
    TrackAudioSources,
} from '../../src/settings/Settings';

describe('Settings', () => {
    describe('DEFAULT_SETTINGS', () => {
        it('should have correct default recording format', () => {
            expect(DEFAULT_SETTINGS.recordingFormat).toBe('webm');
        });

        it('should have empty save folder by default', () => {
            expect(DEFAULT_SETTINGS.saveFolder).toBe('');
        });

        it('should have save-near-active-file mode disabled by default', () => {
            expect(DEFAULT_SETTINGS.saveNearActiveFile).toBe(false);
        });

        it('should have empty active file subfolder by default', () => {
            expect(DEFAULT_SETTINGS.activeFileSubfolder).toBe('');
        });

        it('should have default file prefix', () => {
            expect(DEFAULT_SETTINGS.filePrefix).toBe('recording');
        });

        it('should have empty hotkeys by default', () => {
            expect(DEFAULT_SETTINGS.startStopHotkey).toBe('');
            expect(DEFAULT_SETTINGS.pauseHotkey).toBe('');
            expect(DEFAULT_SETTINGS.resumeHotkey).toBe('');
        });

        it('should have empty audio device ID', () => {
            expect(DEFAULT_SETTINGS.audioDeviceId).toBe('');
        });

        it('should have default sample rate of 44100', () => {
            expect(DEFAULT_SETTINGS.sampleRate).toBe(44100);
        });

        it('should have default bitrate of 128000', () => {
            expect(DEFAULT_SETTINGS.bitrate).toBe(128000);
        });

        it('should have multi-track disabled by default', () => {
            expect(DEFAULT_SETTINGS.enableMultiTrack).toBe(false);
        });

        it('should have max tracks set to 2 by default', () => {
            expect(DEFAULT_SETTINGS.maxTracks).toBe(2);
        });

        it('should have single output mode by default', () => {
            expect(DEFAULT_SETTINGS.outputMode).toBe('single');
        });

        it('should use source names for tracks by default', () => {
            expect(DEFAULT_SETTINGS.useSourceNamesForTracks).toBe(true);
        });

        it('should have empty track audio sources', () => {
            expect(DEFAULT_SETTINGS.trackAudioSources).toBeInstanceOf(Map);
            expect(DEFAULT_SETTINGS.trackAudioSources.size).toBe(0);
        });

        it('should have debug mode disabled by default', () => {
            expect(DEFAULT_SETTINGS.debug).toBe(false);
        });

        it('should be a complete AudioRecorderSettings object', () => {
            const expectedKeys: (keyof AudioRecorderSettings)[] = [
                'recordingFormat',
                'saveFolder',
                'saveNearActiveFile',
                'activeFileSubfolder',
                'filePrefix',
                'startStopHotkey',
                'pauseHotkey',
                'resumeHotkey',
                'audioDeviceId',
                'sampleRate',
                'bitrate',
                'enableMultiTrack',
                'maxTracks',
                'outputMode',
                'useSourceNamesForTracks',
                'trackAudioSources',
                'debug',
            ];

            expectedKeys.forEach((key) => {
                expect(DEFAULT_SETTINGS).toHaveProperty(key);
            });
        });
    });

    describe('mergeSettings', () => {
        it('should return default settings when given empty object', () => {
            const result = mergeSettings({});
            expect(result).toEqual(DEFAULT_SETTINGS);
        });

        it('should override specific settings while keeping defaults', () => {
            const partial: Partial<AudioRecorderSettings> = {
                recordingFormat: 'ogg',
                sampleRate: 48000,
            };

            const result = mergeSettings(partial);

            expect(result.recordingFormat).toBe('ogg');
            expect(result.sampleRate).toBe(48000);
            expect(result.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);
            expect(result.debug).toBe(DEFAULT_SETTINGS.debug);
        });

        it('should merge track audio sources', () => {
            const trackSources: TrackAudioSources = new Map([
                [1, { deviceId: 'device-id-1' }],
                [2, { deviceId: 'device-id-2' }],
            ]);

            const result = mergeSettings({ trackAudioSources: trackSources });

            expect(result.trackAudioSources.get(1)?.deviceId).toBe('device-id-1');
            expect(result.trackAudioSources.get(2)?.deviceId).toBe('device-id-2');
        });

        it('should normalize serialized track audio sources into a Map', () => {
            const result = mergeSettings({
                trackAudioSources: { 1: 'device-id-1', 2: 'device-id-2' },
            });

            expect(result.trackAudioSources).toBeInstanceOf(Map);
            expect(result.trackAudioSources.get(1)?.deviceId).toBe('device-id-1');
            expect(result.trackAudioSources.get(2)?.deviceId).toBe('device-id-2');
        });

        it('should handle output mode changes', () => {
            const modes: OutputMode[] = ['single', 'multiple'];

            modes.forEach((mode) => {
                const result = mergeSettings({ outputMode: mode });
                expect(result.outputMode).toBe(mode);
            });
        });

        it('should preserve all user settings when fully specified', () => {
            const fullSettings: AudioRecorderSettings = {
                recordingFormat: 'mp3',
                saveFolder: '/recordings',
                saveNearActiveFile: true,
                activeFileSubfolder: 'Audio',
                filePrefix: 'audio',
                startStopHotkey: 'Ctrl+R',
                pauseHotkey: 'Ctrl+P',
                resumeHotkey: 'Ctrl+E',
                audioDeviceId: 'test-device',
                sampleRate: 22050,
                bitrate: 64000,
                enableMultiTrack: true,
                maxTracks: 4,
                outputMode: 'multiple',
                useSourceNamesForTracks: false,
                trackAudioSources: new Map([
                    [1, { deviceId: 'dev1' }],
                    [2, { deviceId: 'dev2' }],
                ]),
                debug: true,
            };

            const result = mergeSettings(fullSettings);

            expect(result).toEqual(fullSettings);
        });

        it('should not modify the default settings object', () => {
            const originalDefaults = { ...DEFAULT_SETTINGS };

            mergeSettings({ recordingFormat: 'wav' });

            expect(DEFAULT_SETTINGS).toEqual(originalDefaults);
        });

        it('should handle boolean settings correctly', () => {
            const result1 = mergeSettings({ debug: true });
            const result2 = mergeSettings({ enableMultiTrack: true });

            expect(result1.debug).toBe(true);
            expect(result2.enableMultiTrack).toBe(true);
        });

        it('should handle numeric settings correctly', () => {
            const result = mergeSettings({
                sampleRate: 96000,
                bitrate: 320000,
                maxTracks: 8,
            });

            expect(result.sampleRate).toBe(96000);
            expect(result.bitrate).toBe(320000);
            expect(result.maxTracks).toBe(8);
        });
    });

    describe('Type definitions', () => {
        it('OutputMode should only accept valid values', () => {
            const validModes: OutputMode[] = ['single', 'multiple'];
            expect(validModes).toHaveLength(2);
        });

        it('TrackAudioSources should map numbers to device IDs', () => {
            const sources: TrackAudioSources = new Map([
                [1, { deviceId: 'device-1' }],
                [2, { deviceId: 'device-2' }],
                [3, { deviceId: 'device-3' }],
            ]);

            expect(sources.size).toBe(3);
            expect(sources.get(1)?.deviceId).toBe('device-1');
        });
    });
});
