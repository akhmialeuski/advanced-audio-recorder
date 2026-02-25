/** @jest-environment jsdom */
/**
 * Unit tests for AudioFileAnalyzer.
 * @module tests/unit/AudioFileAnalyzer
 */

import { getAudioFileInfo } from '../../src/utils/AudioFileAnalyzer';
import { App, Notice, TFile } from 'obsidian';

// Mock Notice
jest.mock('obsidian', () => ({
    App: jest.fn().mockImplementation(() => ({
        vault: {
            readBinary: jest.fn(),
        },
    })),
    Notice: jest.fn(),
    TFile: jest.fn().mockImplementation(() => ({
        extension: 'webm',
        name: 'test.webm',
        path: 'test.webm',
        stat: {
            size: 1572864, // 1.5 MB
        },
    })),
}));

// Setup mock AudioContext
const mockDecodeAudioData = jest.fn();
const mockClose = jest.fn();

class MockAudioContext {
    state = 'running';
    decodeAudioData = mockDecodeAudioData;
    close = mockClose;
}

describe('getAudioFileInfo', () => {
    let app: App;
    let file: TFile;

    beforeEach(() => {
        jest.clearAllMocks();
        app = new App();
        file = new TFile();

        // Set default mocked behaviors
        (app.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));

        // Reset AudioContext mocks
        mockDecodeAudioData.mockResolvedValue({
            duration: 90, // 1.5 minutes
            sampleRate: 48000,
            numberOfChannels: 2,
        });
        mockClose.mockResolvedValue(undefined);

        Object.defineProperty(window, 'AudioContext', {
            writable: true,
            value: MockAudioContext,
        });
    });

    it('should accurately extract and format audio metadata', async () => {
        const result = await getAudioFileInfo(app, file);

        expect(result).not.toBeNull();
        expect(result).toEqual({
            fileName: 'test.webm',
            fileSize: '1.5 MB',
            duration: '00:01:30',
            containerFormat: 'audio/webm',
            audioCodec: 'opus',
            bitrate: '140 kbps', // (1572864 * 8) / 90 / 1000 = ~139.8 -> 140
            sampleRate: '48000 Hz',
            channels: '2 (Stereo)',
        });
    });

    it('should handle mono channels', async () => {
        mockDecodeAudioData.mockResolvedValue({
            duration: 60,
            sampleRate: 44100,
            numberOfChannels: 1,
        });
        const result = await getAudioFileInfo(app, file);
        expect(result?.channels).toBe('1 (Mono)');
    });

    it('should handle > 2 channels', async () => {
        mockDecodeAudioData.mockResolvedValue({
            duration: 60,
            sampleRate: 44100,
            numberOfChannels: 6,
        });
        const result = await getAudioFileInfo(app, file);
        expect(result?.channels).toBe('6 channels');
    });

    it('should correctly infer codecs from extensions', async () => {
        (file as any).extension = 'mp4';
        let result = await getAudioFileInfo(app, file);
        expect(result?.containerFormat).toBe('audio/mp4');
        expect(result?.audioCodec).toBe('aac');

        (file as any).extension = 'ogg';
        result = await getAudioFileInfo(app, file);
        expect(result?.containerFormat).toBe('audio/ogg');
        expect(result?.audioCodec).toBe('opus/vorbis');
    });

    it('should format very small files correctly', async () => {
        (file as any).stat.size = 500;
        mockDecodeAudioData.mockResolvedValue({ duration: 1, sampleRate: 44100, numberOfChannels: 1 });
        const result = await getAudioFileInfo(app, file);
        expect(result?.fileSize).toBe('500 Bytes');
        expect(result?.bitrate).toBe('4 kbps'); // 500 * 8 / 1000 = 4k
    });

    it('should format zero duration correctly without Infinity bitrate', async () => {
        mockDecodeAudioData.mockResolvedValue({ duration: 0, sampleRate: 44100, numberOfChannels: 1 });
        const result = await getAudioFileInfo(app, file);
        expect(result?.duration).toBe('00:00:00');
        expect(result?.bitrate).toBe('0 kbps');
    });

    it('should return null and show Notice if decoding throws', async () => {
        mockDecodeAudioData.mockRejectedValue(new Error('Invalid audio data'));

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        const result = await getAudioFileInfo(app, file);

        expect(result).toBeNull();
        expect(Notice).toHaveBeenCalledWith('Failed to decode audio file data.');
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
    });

    it('should close AudioContext in finally block', async () => {
        await getAudioFileInfo(app, file);
        expect(mockClose).toHaveBeenCalled();
    });

    it('should return null if AudioContext is not supported', async () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        Object.defineProperty(window, 'AudioContext', {
            writable: true,
            value: undefined,
        });
        Object.defineProperty(window, 'webkitAudioContext', {
            writable: true,
            value: undefined,
        });

        const result = await getAudioFileInfo(app, file);
        expect(result).toBeNull();
        expect(Notice).toHaveBeenCalledWith('AudioContext is not supported. Cannot extract audio metadata.');

        consoleSpy.mockRestore();
    });
});
