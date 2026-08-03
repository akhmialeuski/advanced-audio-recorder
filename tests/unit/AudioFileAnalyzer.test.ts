/**
 * Unit tests for AudioFileAnalyzer.
 * @module tests/unit/AudioFileAnalyzer.test
 */

import {
	getAudioFileInfo,
	readAudioMetadata,
} from 'src/utils/AudioFileAnalyzer';
import { App, Notice, TFile } from 'obsidian';

// Mock Notice
jest.mock('obsidian', () => ({
	App: jest.fn().mockImplementation(() => ({
		vault: {
			readBinary: jest.fn(),
			// The ranged probe reads through the resource URL; only the
			// fallback path touches readBinary.
			getResourcePath: jest.fn(
				(file: { path: string }) => `app://vault/${file.path}`,
			),
		},
	})),
	Notice: jest.fn(),
	// The decode fallback is bounded by the platform's decode ceiling, which
	// is read from here.
	Platform: { isMobileApp: false, isMobile: false },
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
	UrlSource: jest.fn(),
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): unknown => mockGetPrimaryAudioTrack(),
		computeDuration: (): unknown => mockComputeDuration(),
		dispose: mockDispose,
	})),
}));

jest.mock('src/platform/capabilities', () => {
	const actual = jest.requireActual<
		typeof import('src/platform/capabilities')
	>('src/platform/capabilities');
	return { ...actual, isDecodableSize: jest.fn(() => true) };
});

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

	it('reads only ranges, never the whole file, when the probe parses', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 48000,
			getNumberOfChannels: () => 2,
		});
		mockComputeDuration.mockResolvedValue(90);

		await getAudioFileInfo(app, file);

		// The vault adapter has no ranged read, so going through it would hold
		// a multi-hour recording in memory to look at its header. The resource
		// URL serves ranges, and mediabunny fetches only what it parses.
		const { UrlSource } = jest.requireMock<{ UrlSource: jest.Mock }>(
			'mediabunny',
		);
		expect(UrlSource).toHaveBeenCalledWith('app://vault/test.webm');
		expect(app.vault.readBinary).not.toHaveBeenCalled();
	});

	it('falls back to the whole-file read when the ranged probe cannot parse', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation();
		try {
			mockGetPrimaryAudioTrack
				.mockRejectedValueOnce(new Error('range request refused'))
				.mockResolvedValue({
					getSampleRate: () => 48000,
					getNumberOfChannels: () => 2,
				});
			mockComputeDuration.mockResolvedValue(90);

			const result = await getAudioFileInfo(app, file);

			// An environment that does not honor the range request still gets
			// its metadata, from the bytes rather than from a decode.
			expect(result?.duration).toBe('1:30');
			expect(app.vault.readBinary).toHaveBeenCalled();
			expect(mockDecodeAudioData).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
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

		// A decode that fails is logged rather than announced: the fallback is
		// also reached from a background probe, so what an unreadable file
		// should say belongs to the action the user opened.
		const consoleSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		const result = await getAudioFileInfo(app, file);

		expect(result).toBeNull();
		expect(Notice).toHaveBeenCalledWith(
			'Could not read this audio file to show its details.',
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
			'Could not read this audio file to show its details.',
		);

		consoleSpy.mockRestore();
	});
});

describe('readAudioMetadata', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockDecodeAudioData.mockResolvedValue({
			duration: 90,
			sampleRate: 48000,
			numberOfChannels: 2,
		});
		mockClose.mockResolvedValue(undefined);
		Object.defineProperty(window, 'AudioContext', {
			writable: true,
			value: MockAudioContext,
		});
	});

	it('answers from the container headers without decoding', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 44100,
			getNumberOfChannels: () => 1,
		});
		mockComputeDuration.mockResolvedValue(120);

		const result = await readAudioMetadata(new ArrayBuffer(8), 'a.webm');

		expect(result).toEqual({
			durationSeconds: 120,
			sampleRate: 44100,
			channels: 1,
		});
		expect(mockDecodeAudioData).not.toHaveBeenCalled();
	});

	it('decodes when the container cannot be parsed', async () => {
		mockGetPrimaryAudioTrack.mockRejectedValue(new Error('unparseable'));
		const consoleSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		const result = await readAudioMetadata(new ArrayBuffer(8), 'a.webm');

		expect(result?.durationSeconds).toBe(90);
		expect(mockDecodeAudioData).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('decodes when the headers carry no duration', async () => {
		// A recorder writing live leaves no duration in the segment it has not
		// finished, which is what this plugin's own recordings look like. The
		// headers parse, so a probe alone answered zero and every priced line
		// went unestimated.
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 48000,
			getNumberOfChannels: () => 2,
		});
		mockComputeDuration.mockResolvedValue(0);

		const result = await readAudioMetadata(new ArrayBuffer(8), 'a.webm');

		expect(result?.durationSeconds).toBe(90);
	});

	it('keeps what the headers did read when the decode fails too', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 48000,
			getNumberOfChannels: () => 2,
		});
		mockComputeDuration.mockResolvedValue(0);
		mockDecodeAudioData.mockRejectedValue(new Error('no decoder'));
		const consoleSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		const result = await readAudioMetadata(new ArrayBuffer(8), 'a.webm');

		expect(result).toEqual({
			durationSeconds: 0,
			sampleRate: 48000,
			channels: 2,
		});

		consoleSpy.mockRestore();
	});

	it('answers null when neither path can read the file', async () => {
		mockGetPrimaryAudioTrack.mockRejectedValue(new Error('unparseable'));
		mockDecodeAudioData.mockRejectedValue(new Error('no decoder'));
		const consoleSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		expect(
			await readAudioMetadata(new ArrayBuffer(8), 'a.webm'),
		).toBeNull();

		consoleSpy.mockRestore();
	});

	it('does not decode a file past the platform ceiling', async () => {
		// The recordings whose headers carry no duration are the long ones, so
		// an unbounded fallback would put a full PCM decode of multi-hour audio
		// on the main thread - the one thing every other decode path asks the
		// platform about first.
		const { isDecodableSize } = jest.requireMock<{
			isDecodableSize: jest.Mock;
		}>('src/platform/capabilities');
		isDecodableSize.mockReturnValueOnce(false);
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getSampleRate: () => 48000,
			getNumberOfChannels: () => 2,
		});
		mockComputeDuration.mockResolvedValue(0);
		const consoleSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		const result = await readAudioMetadata(new ArrayBuffer(8), 'huge.webm');

		expect(mockDecodeAudioData).not.toHaveBeenCalled();
		// What the headers did read is still worth answering with; only the
		// duration stays unknown, and the estimate degrades around it.
		expect(result).toEqual({
			durationSeconds: 0,
			sampleRate: 48000,
			channels: 2,
		});

		consoleSpy.mockRestore();
	});
});
