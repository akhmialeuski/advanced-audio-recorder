/**
 * Unit tests for the shared streaming conversion core used by both
 * the main-thread pipeline and the encoding worker.
 * @module tests/unit/streamingConversion.test
 */

import { runStreamingConversion } from 'src/audio/streamingConversion';

const mockConversionExecute = jest.fn().mockResolvedValue(undefined);
const mockConversionInit = jest.fn();
const mockGetPrimaryAudioTrack = jest.fn();
const mockInputDispose = jest.fn();
const mockConvertedBuffer = new ArrayBuffer(64);

jest.mock('mediabunny', () => ({
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): unknown => mockGetPrimaryAudioTrack(),
		dispose: mockInputDispose,
	})),
	Output: jest.fn().mockImplementation(() => ({})),
	BlobSource: jest.fn(),
	BufferTarget: jest.fn().mockImplementation(() => ({
		buffer: mockConvertedBuffer,
	})),
	ALL_FORMATS: [],
	Conversion: {
		init: (...args: unknown[]): unknown => mockConversionInit(...args),
	},
}));

jest.mock('src/audio/AudioEncoder', () => ({
	ensureEncoderRegistered: jest.fn().mockResolvedValue(undefined),
	createOutputFormat: jest.fn().mockReturnValue({}),
	FORMAT_CODEC_MAP: {
		webm: 'opus',
		mp3: 'mp3',
		wav: 'pcm-s16',
	},
}));

const inputBlob = new Blob(['audio'], { type: 'audio/webm' });

describe('runStreamingConversion', () => {
	let conversionStub: {
		execute: jest.Mock;
		onProgress?: (progress: number) => void;
		isValid: boolean;
		discardedTracks: { track: { isAudioTrack: () => boolean } }[];
	};

	beforeEach(() => {
		jest.clearAllMocks();
		conversionStub = {
			execute: mockConversionExecute,
			onProgress: undefined,
			isValid: true,
			discardedTracks: [],
		};
		mockConversionInit.mockImplementation(() =>
			Promise.resolve(conversionStub),
		);
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('opus'),
			isAudioTrack: (): boolean => true,
		});
	});

	it('should return the converted buffer', async () => {
		const result = await runStreamingConversion(
			inputBlob,
			'mp3',
			128000,
			false,
		);

		expect(result).toBe(mockConvertedBuffer);
		expect(mockConversionExecute).toHaveBeenCalledTimes(1);
	});

	it('should throw for a format without codec mapping', async () => {
		await expect(
			runStreamingConversion(inputBlob, 'xyz', 128000, false),
		).rejects.toThrow('No codec mapping for format "xyz"');
	});

	it('should throw when the input has no audio track', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue(null);

		await expect(
			runStreamingConversion(inputBlob, 'mp3', 128000, false),
		).rejects.toThrow('Input contains no audio track');
	});

	it('should dispose the input on success', async () => {
		await runStreamingConversion(inputBlob, 'mp3', 128000, false);

		expect(mockInputDispose).toHaveBeenCalledTimes(1);
	});

	it('should dispose the input when the conversion throws', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue(null);

		await expect(
			runStreamingConversion(inputBlob, 'mp3', 128000, false),
		).rejects.toThrow('Input contains no audio track');

		expect(mockInputDispose).toHaveBeenCalledTimes(1);
	});

	it('should force a re-encode with bitrate by default', async () => {
		await runStreamingConversion(inputBlob, 'mp3', 96000, false);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'mp3', bitrate: 96000 },
			}),
		);
	});

	it('should omit the bitrate for a codec-matching remux', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('mp3'),
			isAudioTrack: (): boolean => true,
		});

		await runStreamingConversion(inputBlob, 'mp3', 96000, true);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'mp3' },
			}),
		);
	});

	it('should re-encode a codec match when remux is not allowed', async () => {
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('mp3'),
			isAudioTrack: (): boolean => true,
		});

		await runStreamingConversion(inputBlob, 'mp3', 96000, false);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'mp3', bitrate: 96000 },
			}),
		);
	});

	it('should omit the bitrate for PCM targets', async () => {
		await runStreamingConversion(inputBlob, 'wav', 128000, false);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'pcm-s16' },
			}),
		);
	});

	it('should throw when the conversion discards the audio track', async () => {
		conversionStub.discardedTracks = [
			{ track: { isAudioTrack: (): boolean => true } },
		];

		await expect(
			runStreamingConversion(inputBlob, 'mp3', 128000, false),
		).rejects.toThrow('cannot process the input audio track');
		expect(mockConversionExecute).not.toHaveBeenCalled();
	});

	it('should throw when the conversion is not valid', async () => {
		conversionStub.isValid = false;

		await expect(
			runStreamingConversion(inputBlob, 'mp3', 128000, false),
		).rejects.toThrow('cannot process the input audio track');
	});

	it('should throw when the conversion produces no output', async () => {
		const { BufferTarget } = jest.requireMock('mediabunny');
		(BufferTarget as jest.Mock).mockImplementationOnce(() => ({
			buffer: new ArrayBuffer(0),
		}));

		await expect(
			runStreamingConversion(inputBlob, 'mp3', 128000, false),
		).rejects.toThrow('produced no output');
	});

	it('should deduplicate whole-percent progress updates', async () => {
		const onProgress = jest.fn();
		mockConversionExecute.mockImplementationOnce(async () => {
			conversionStub.onProgress?.(0.101);
			conversionStub.onProgress?.(0.104);
			conversionStub.onProgress?.(0.5);
			return undefined;
		});

		await runStreamingConversion(
			inputBlob,
			'mp3',
			128000,
			false,
			onProgress,
		);

		expect(onProgress.mock.calls.map((call) => call[0])).toEqual([10, 50]);
	});

	it('should not register a progress handler without a callback', async () => {
		await runStreamingConversion(inputBlob, 'mp3', 128000, false);

		expect(conversionStub.onProgress).toBeUndefined();
	});
});
