/** @jest-environment jsdom */
/**
 * Unit tests for DebugLogger.
 */

import { DebugLogger } from '../../src/utils/DebugLogger';
import type { AudioRecorderSettings } from '../../src/settings/Settings';
import { DEFAULT_SETTINGS } from '../../src/settings/Settings';

describe('DebugLogger', () => {
    let consoleMock: jest.SpyInstance;

    beforeEach(() => {
        consoleMock = jest.spyOn(console, 'debug').mockImplementation();
    });

    afterEach(() => {
        consoleMock.mockRestore();
    });

    describe('when debug is disabled', () => {
        it('should not log anything', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: false };
            const logger = new DebugLogger(settings);

            logger.logMimeType('audio/webm');
            logger.logDevices([]);
            logger.logChunkSize(0, 1000);
            logger.logRecordingStats(5000, 10);
            logger.log('test message');

            expect(consoleMock).not.toHaveBeenCalled();
        });
    });

    describe('when debug is enabled', () => {
        it('should log MIME type', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: true };
            const logger = new DebugLogger(settings);

            logger.logMimeType('audio/webm;codecs=opus');

            expect(consoleMock).toHaveBeenCalledWith(
                '[AudioRecorder] Selected MIME type:',
                'audio/webm;codecs=opus',
            );
        });

        it('should log devices', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: true };
            const logger = new DebugLogger(settings);
            const mockDevices = [
                { deviceId: 'abc123', label: 'Built-in Microphone' },
            ] as unknown as MediaDeviceInfo[];

            logger.logDevices(mockDevices);

            expect(consoleMock).toHaveBeenCalledWith(
                '[AudioRecorder] Available audio devices:',
                [{ id: 'abc123', label: 'Built-in Microphone' }],
            );
        });

        it('should log chunk size', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: true };
            const logger = new DebugLogger(settings);

            logger.logChunkSize(0, 4096);

            expect(consoleMock).toHaveBeenCalledWith(
                '[AudioRecorder] Track 0 chunk size: 4096 bytes',
            );
        });

        it('should log recording stats', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: true };
            const logger = new DebugLogger(settings);

            logger.logRecordingStats(5500, 12);

            expect(consoleMock).toHaveBeenCalledWith(
                '[AudioRecorder] Recording stats: 5.5s, 12 chunks',
            );
        });

        it('should log generic messages', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: true };
            const logger = new DebugLogger(settings);

            logger.log('Custom message', { key: 'value' });

            expect(consoleMock).toHaveBeenCalledWith(
                '[AudioRecorder] Custom message',
                { key: 'value' },
            );
        });
    });

    describe('updateSettings', () => {
        it('should toggle logging based on new settings', () => {
            const settings: AudioRecorderSettings = { ...DEFAULT_SETTINGS, debug: false };
            const logger = new DebugLogger(settings);

            logger.logMimeType('test');
            expect(consoleMock).not.toHaveBeenCalled();

            logger.updateSettings({ ...settings, debug: true });
            logger.logMimeType('test');
            expect(consoleMock).toHaveBeenCalled();
        });
    });
});
