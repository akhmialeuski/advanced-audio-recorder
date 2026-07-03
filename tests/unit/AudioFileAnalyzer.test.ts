/**
 * Unit tests for AudioFileAnalyzer.
 * @module tests/unit/AudioFileAnalyzer
 */

import { getAudioFileInfo } from 'src/utils/AudioFileAnalyzer';
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

// Mock mediabunny's container probe. Defaults to an unparseable input
// (getPrimaryAudioTrack rejects) so the existing decode-fallback tests
// keep exercising the AudioContext path; probe tests override it.
const mockGetPrimaryAudioTrack = jest.fn();
const mockComputeDuration = jest.fn();
const mockDispose = jest.fn();

jest.mock('mediabunny', () => ({
	ALL_FORMATS: [],
	BufferSource: jest.fn(),
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): unknown => mockGetPrimaryAudioTrack(),
		computeDuration: (): unknown => mockComputeDuration(),
		dispose: mockDispose,
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
		(app.vault.readBinary as jest.Mock).mockResolvedValue(
			new ArrayBuffer(8),
		);

		// Reset AudioContext mocks
		mockDecodeAudioData.mockResolvedValue({
			duration: 90, // 1.5 minutes
			sampleRate: 48000,
			numberOfChannels: 2,
		});
		mockClose.mockResolvedValue(undefined);

		// Default: the probe cannot parse the container, so the decode
		// fallback runs (the pre-probe behavior the older tests assert).
		mockGetPrimaryAudioTrack.mockRejectedValue(
			new Error('unparseable container'),
		);
		mockComputeDuration.mockResolvedValue(0);

		Object.defineProperty(window, 'AudioContext', {
			writable: true,
			value: MockAudioContext,
		});
	});

	it('reads metadata from the container probe without decoding', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 48000,
			getNumberOfChannels: () => 2,
		});
		mockComputeDuration.mockResolvedValue(90);

		const result = await getAudioFileInfo(app, file);

		expect(result).toEqual({
			fileName: 'test.webm',
			fileSize: '1.5 MB',
			duration: '1:30',
			containerFormat: 'audio/webm',
			audioCodec: 'opus',
			bitrate: '140 kbps',
			sampleRate: '48000 Hz',
			channels: '2 (Stereo)',
		});
		// The probe answered, so the expensive full decode never ran
		expect(mockDecodeAudioData).not.toHaveBeenCalled();
		expect(mockDispose).toHaveBeenCalled();
	});

	it('disposes the probe input even when parsing fails', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		try {
			await getAudioFileInfo(app, file);
			expect(mockDispose).toHaveBeenCalled();
			// The decode fallback provided the metadata instead
			expect(mockDecodeAudioData).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('should accurately extract and format audio metadata', async () => {
		const result = await getAudioFileInfo(app, file);

		expect(result).not.toBeNull();
		expect(result).toEqual({
			fileName: 'test.webm',
			fileSize: '1.5 MB',
			duration: '1:30',
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
		(file as { extension: string }).extension = 'mp4';
		let result = await getAudioFileInfo(app, file);
		expect(result?.containerFormat).toBe('audio/mp4');
		expect(result?.audioCodec).toBe('aac');

		(file as { extension: string }).extension = 'ogg';
		result = await getAudioFileInfo(app, file);
		expect(result?.containerFormat).toBe('audio/ogg');
		expect(result?.audioCodec).toBe('opus/vorbis');
	});

	it('should format very small files correctly', async () => {
		(file as { stat: { size: number } }).stat.size = 500;
		mockDecodeAudioData.mockResolvedValue({
			duration: 1,
			sampleRate: 44100,
			numberOfChannels: 1,
		});
		const result = await getAudioFileInfo(app, file);
		expect(result?.fileSize).toBe('500 Bytes');
		expect(result?.bitrate).toBe('4 kbps'); // 500 * 8 / 1000 = 4k
	});

	it('should format zero duration correctly without Infinity bitrate', async () => {
		mockDecodeAudioData.mockResolvedValue({
			duration: 0,
			sampleRate: 44100,
			numberOfChannels: 1,
		});
		const result = await getAudioFileInfo(app, file);
		expect(result?.duration).toBe('0:00');
		expect(result?.bitrate).toBe('0 kbps');
	});

	it('should return null and show Notice if decoding throws', async () => {
		mockDecodeAudioData.mockRejectedValue(new Error('Invalid audio data'));

		const consoleSpy = jest
			.spyOn(console, 'error')
			.mockImplementation(() => {});

		const result = await getAudioFileInfo(app, file);

		expect(result).toBeNull();
		expect(Notice).toHaveBeenCalledWith(
			'Failed to decode audio file data.',
		);
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('should close AudioContext in finally block', async () => {
		await getAudioFileInfo(app, file);
		expect(mockClose).toHaveBeenCalled();
	});

	it('should return null if AudioContext is not supported', async () => {
		const consoleSpy = jest
			.spyOn(console, 'error')
			.mockImplementation(() => {});
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
		expect(Notice).toHaveBeenCalledWith(
			'Audio context is not supported. Cannot extract audio metadata.',
		);

		consoleSpy.mockRestore();
	});
});
