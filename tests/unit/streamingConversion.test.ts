/**
 * Unit tests for the shared streaming conversion core used by both
 * the main-thread pipeline and the encoding worker.
 * @module tests/unit/streamingConversion.test
 */

import {
	averageChannelsSample,
	extractChannelSample,
	runStreamingConversion,
} from 'src/audio/streamingConversion';

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
	AudioSample: class {
		constructor(init: object) {
			Object.assign(this, init);
		}
	},
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
		onProgress?: ((progress: number) => void) | undefined;
		isValid: boolean;
		discardedTracks: { track: { isAudioTrack: () => boolean } }[];
	};

	beforeEach(() => {
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
			getNumberOfChannels: jest.fn().mockResolvedValue(2),
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
		jest.mocked(BufferTarget).mockImplementationOnce(() => ({
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

	describe('channel modes', () => {
		it('should keep the source layout by default', async () => {
			await runStreamingConversion(inputBlob, 'mp3', 96000, false);

			const audio = (
				mockConversionInit.mock.calls[0][0] as {
					audio: Record<string, unknown>;
				}
			).audio;
			expect(audio.numberOfChannels).toBeUndefined();
			expect(audio.process).toBeUndefined();
		});

		it('should install an averaging process hook for the mono mix', async () => {
			await runStreamingConversion(
				inputBlob,
				'mp3',
				96000,
				false,
				undefined,
				'mono-mix',
			);

			const audio = (
				mockConversionInit.mock.calls[0][0] as {
					audio: {
						codec: string;
						bitrate?: number;
						process?: (sample: unknown) => unknown;
						processedNumberOfChannels?: number;
						numberOfChannels?: number;
					};
				}
			).audio;
			expect(audio.codec).toBe('mp3');
			expect(audio.bitrate).toBe(96000);
			expect(audio.processedNumberOfChannels).toBe(1);
			expect(typeof audio.process).toBe('function');
			// mediabunny's own remixing (Web Audio speaker rules) is not
			// used - the hook keeps the mix identical to the capture paths
			expect(audio.numberOfChannels).toBeUndefined();
		});

		it('should send the bitrate for a mono mix even on a codec match', async () => {
			mockGetPrimaryAudioTrack.mockResolvedValue({
				getCodec: jest.fn().mockResolvedValue('mp3'),
				isAudioTrack: (): boolean => true,
				getNumberOfChannels: jest.fn().mockResolvedValue(2),
			});

			await runStreamingConversion(
				inputBlob,
				'mp3',
				96000,
				true,
				undefined,
				'mono-mix',
			);

			// The hook forces a transcode, so the remux bitrate omission
			// must not apply - otherwise the re-encode would run at
			// mediabunny's default quality
			const audio = (
				mockConversionInit.mock.calls[0][0] as {
					audio: { bitrate?: number; process?: unknown };
				}
			).audio;
			expect(audio.bitrate).toBe(96000);
			expect(typeof audio.process).toBe('function');
		});

		it('should keep remux eligibility for a mono mix of already-mono input', async () => {
			mockGetPrimaryAudioTrack.mockResolvedValue({
				getCodec: jest.fn().mockResolvedValue('mp3'),
				isAudioTrack: (): boolean => true,
				getNumberOfChannels: jest.fn().mockResolvedValue(1),
			});

			await runStreamingConversion(
				inputBlob,
				'mp3',
				96000,
				true,
				undefined,
				'mono-mix',
			);

			// Nothing to mix: the packets can be copied untouched
			expect(mockConversionInit).toHaveBeenCalledWith(
				expect.objectContaining({
					audio: { codec: 'mp3' },
				}),
			);
		});

		it('should average all channels inside the mix hook', async () => {
			await runStreamingConversion(
				inputBlob,
				'mp3',
				96000,
				false,
				undefined,
				'mono-mix',
			);

			const audio = (
				mockConversionInit.mock.calls[0][0] as {
					audio: { process?: (sample: unknown) => unknown };
				}
			).audio;
			// Interleaved stereo: frames [0.5, -0.5] and [1, 0]
			const interleaved = Float32Array.from([0.5, -0.5, 1, 0]);
			const result = audio.process?.({
				numberOfChannels: 2,
				numberOfFrames: 2,
				sampleRate: 44100,
				timestamp: 0.5,
				copyTo: (destination: Float32Array): void => {
					destination.set(interleaved);
				},
			}) as { data: Float32Array; numberOfChannels: number };
			expect(Array.from(result.data)).toEqual([0, 0.5]);
			expect(result.numberOfChannels).toBe(1);
		});

		it.each([
			['mono-left', 0],
			['mono-right', 1],
		] as const)(
			'should install a %s process hook with a mono hint',
			async (mode, expectedPlane) => {
				await runStreamingConversion(
					inputBlob,
					'mp3',
					96000,
					false,
					undefined,
					mode,
				);

				const audio = (
					mockConversionInit.mock.calls[0][0] as {
						audio: {
							process?: (sample: unknown) => unknown;
							processedNumberOfChannels?: number;
						};
					}
				).audio;
				expect(audio.processedNumberOfChannels).toBe(1);
				expect(typeof audio.process).toBe('function');

				// The hook extracts the expected plane of the input sample
				const copyTo = jest.fn();
				const extracted = audio.process?.({
					numberOfChannels: 2,
					numberOfFrames: 4,
					sampleRate: 44100,
					timestamp: 1.5,
					copyTo,
				}) as { numberOfChannels: number; timestamp: number };
				expect(copyTo).toHaveBeenCalledWith(expect.any(Float32Array), {
					planeIndex: expectedPlane,
					format: 'f32-planar',
				});
				expect(extracted.numberOfChannels).toBe(1);
				expect(extracted.timestamp).toBe(1.5);
			},
		);

		it.each(['mono-left', 'mono-right'] as const)(
			'should keep remux eligibility for a %s pick on already-mono input',
			async (mode) => {
				mockGetPrimaryAudioTrack.mockResolvedValue({
					getCodec: jest.fn().mockResolvedValue('mp3'),
					isAudioTrack: (): boolean => true,
					getNumberOfChannels: jest.fn().mockResolvedValue(1),
				});

				await runStreamingConversion(
					inputBlob,
					'mp3',
					96000,
					true,
					undefined,
					mode,
				);

				// Picking either side of a mono source is a no-op: the
				// only channel is already the required mono output.
				expect(mockConversionInit).toHaveBeenCalledWith(
					expect.objectContaining({
						audio: { codec: 'mp3' },
					}),
				);
			},
		);
	});
});

describe('extractChannelSample', () => {
	function fakeSample(planes: Float32Array[]): {
		numberOfChannels: number;
		numberOfFrames: number;
		sampleRate: number;
		timestamp: number;
		copyTo: (
			destination: Float32Array,
			options: { planeIndex: number },
		) => void;
	} {
		return {
			numberOfChannels: planes.length,
			numberOfFrames: planes[0]?.length ?? 0,
			sampleRate: 48000,
			timestamp: 2.25,
			copyTo: (destination, options): void => {
				destination.set(planes[options.planeIndex] ?? []);
			},
		};
	}

	it('copies the requested plane into a mono sample', () => {
		const left = Float32Array.from([0.1, 0.2]);
		const right = Float32Array.from([0.3, 0.4]);

		const result = extractChannelSample(
			fakeSample([left, right]) as never,
			1,
		) as unknown as {
			data: Float32Array;
			format: string;
			numberOfChannels: number;
			sampleRate: number;
			timestamp: number;
		};

		expect(Array.from(result.data)).toEqual([
			Math.fround(0.3),
			Math.fround(0.4),
		]);
		expect(result.format).toBe('f32');
		expect(result.numberOfChannels).toBe(1);
		expect(result.sampleRate).toBe(48000);
		expect(result.timestamp).toBe(2.25);
	});

	it('clamps an out-of-range channel index into the sample', () => {
		const only = Float32Array.from([0.5]);

		const result = extractChannelSample(
			fakeSample([only]) as never,
			1,
		) as unknown as { data: Float32Array };

		expect(Array.from(result.data)).toEqual([0.5]);
	});
});

describe('averageChannelsSample', () => {
	function fakeInterleavedSample(
		interleaved: number[],
		channels: number,
	): {
		numberOfChannels: number;
		numberOfFrames: number;
		sampleRate: number;
		timestamp: number;
		copyTo: (destination: Float32Array) => void;
	} {
		return {
			numberOfChannels: channels,
			numberOfFrames: interleaved.length / channels,
			sampleRate: 48000,
			timestamp: 1.25,
			copyTo: (destination): void => {
				destination.set(interleaved);
			},
		};
	}

	it('averages a stereo sample per frame', () => {
		const result = averageChannelsSample(
			fakeInterleavedSample([0.5, -0.5, 1, 0], 2) as never,
		) as unknown as {
			data: Float32Array;
			format: string;
			numberOfChannels: number;
			sampleRate: number;
			timestamp: number;
		};

		expect(Array.from(result.data)).toEqual([0, 0.5]);
		expect(result.format).toBe('f32');
		expect(result.numberOfChannels).toBe(1);
		expect(result.sampleRate).toBe(48000);
		expect(result.timestamp).toBe(1.25);
	});

	it('includes every lane of a 5.1-style sample in the average', () => {
		// One frame of six channels; the plain average keeps the LFE,
		// unlike the Web Audio speaker-rules downmix
		const result = averageChannelsSample(
			fakeInterleavedSample([0.6, 0.6, 0.6, 0.6, 0.6, 0.0], 6) as never,
		) as unknown as { data: Float32Array };

		expect(result.data[0]).toBeCloseTo(0.5);
	});

	it('copies a mono sample through unchanged', () => {
		const result = averageChannelsSample(
			fakeInterleavedSample([0.25, -0.25], 1) as never,
		) as unknown as { data: Float32Array };

		expect(Array.from(result.data)).toEqual([0.25, -0.25]);
	});
});
