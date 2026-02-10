/**
 * Tests for Settings validation functions.
 * @module tests/unit/Settings.validation.test
 */

import {
    AudioRecorderSettings,
    DEFAULT_SETTINGS,
    validateSettings,
} from '../../src/settings/Settings';
import { SettingsValidationError } from '../../src/errors';

describe('validateSettings', () => {
    it('should throw SettingsValidationError when audioDeviceId is empty', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: '',
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
        expect(() => validateSettings(settings)).toThrow(
            /Audio device is not selected/,
        );
    });

    it('should throw SettingsValidationError when audioDeviceId is whitespace', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: '   ',
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
    });

    it('should throw SettingsValidationError when sampleRate is zero', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            sampleRate: 0,
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
        expect(() => validateSettings(settings)).toThrow(
            /Sample rate must be a positive number/,
        );
    });

    it('should throw SettingsValidationError when sampleRate is negative', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            sampleRate: -44100,
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
    });

    it('should throw SettingsValidationError when recordingFormat is empty', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            recordingFormat: '',
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
        expect(() => validateSettings(settings)).toThrow(
            /Recording format is not selected/,
        );
    });

    it('should throw when multi-track enabled but no sources configured', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            enableMultiTrack: true,
            trackAudioSources: new Map(),
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
        expect(() => validateSettings(settings)).toThrow(
            /no audio sources are selected/,
        );
    });

    it('should throw when multi-track source has empty deviceId', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            enableMultiTrack: true,
            trackAudioSources: new Map([
                [1, { deviceId: 'device-1' }],
                [2, { deviceId: '' }],
            ]),
        };
        expect(() => validateSettings(settings)).toThrow(SettingsValidationError);
        expect(() => validateSettings(settings)).toThrow(
            /Track 2 has no audio source selected/,
        );
    });

    it('should pass validation with valid settings', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
        };
        expect(() => validateSettings(settings)).not.toThrow();
    });

    it('should pass validation with valid multi-track settings', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: 'valid-device',
            enableMultiTrack: true,
            trackAudioSources: new Map([
                [1, { deviceId: 'device-1' }],
                [2, { deviceId: 'device-2' }],
            ]),
        };
        expect(() => validateSettings(settings)).not.toThrow();
    });

    it('should include field name in error message', () => {
        const settings: AudioRecorderSettings = {
            ...DEFAULT_SETTINGS,
            audioDeviceId: '',
        };
        try {
            validateSettings(settings);
            fail('Expected error to be thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(SettingsValidationError);
            expect((error as SettingsValidationError).field).toBe('audioDeviceId');
        }
    });
});
