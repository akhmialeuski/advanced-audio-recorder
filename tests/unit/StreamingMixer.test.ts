/**
 * Unit tests for StreamingMixer module.
 * Mixes synthetic PCM fixtures and verifies exact sample values.
 * @module tests/unit/StreamingMixer.test
 */

import { canStreamMix, mixPcmTracksToWav } from 'src/recording/StreamingMixer';
import type { PcmMixTrack } from 'src/recording/StreamingMixer';
import type { App } from 'obsidian';

jest.mock('obsidian', () => ({
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

const WAV_HEADER_SIZE = 44;

describe('StreamingMixer', () => {
	/** In-memory binary segment store. */
	let segments: Map<string, ArrayBuffer>;
	let mockApp: App;

	const storeSegment = (path: string, samples: number[]): void => {
		segments.set(path, new Int16Array(samples).buffer);
	};

	const createTrack = (
		paths: string[],
		channels = 1,
		sampleRate = 44100,
	): PcmMixTrack => ({ segmentPaths: paths, channels, sampleRate });

	const mixedSamples = async (
		tracks: PcmMixTrack[],
		windowFrames?: number,
	): Promise<Int16Array> => {
		const wav = await mixPcmTracksToWav(
			tracks,
			mockApp,
			undefined,
			windowFrames,
		);
		return new Int16Array(wav, WAV_HEADER_SIZE);
	};

	beforeEach(() => {
		jest.clearAllMocks();
		segments = new Map();
		mockApp = {
			vault: {
				adapter: {
					stat: jest.fn((path: string) => {
						const data = segments.get(path);
						return Promise.resolve(
							data ? { size: data.byteLength } : null,
						);
					}),
					readBinary: jest.fn((path: string) => {
						const data = segments.get(path);
						return data
							? Promise.resolve(data)
							: Promise.reject(new Error('missing'));
					}),
				},
			},
		} as unknown as App;
	});

	describe('canStreamMix', () => {
		it('should accept tracks with one shared sample rate', () => {
			expect(
				canStreamMix([
					createTrack(['a.tmp']),
					createTrack(['b.tmp'], 2),
				]),
			).toBe(true);
		});

		it('should reject mismatched sample rates', () => {
			expect(
				canStreamMix([
					createTrack(['a.tmp'], 1, 44100),
					createTrack(['b.tmp'], 1, 48000),
				]),
			).toBe(false);
		});

		it('should reject empty input', () => {
			expect(canStreamMix([])).toBe(false);
			expect(canStreamMix([createTrack([])])).toBe(false);
		});
	});

	describe('mixPcmTracksToWav', () => {
		it('should sum mono tracks sample by sample', async () => {
			storeSegment('a.tmp', [100, -200, 300]);
			storeSegment('b.tmp', [10, 20, -30]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			expect(Array.from(samples)).toEqual([110, -180, 270]);
		});

		it('should write a valid WAV header for the mix', async () => {
			storeSegment('a.tmp', [1, 2]);

			const wav = await mixPcmTracksToWav(
				[createTrack(['a.tmp'], 1, 48000)],
				mockApp,
			);

			const header = new Uint8Array(wav, 0, 4);
			expect(String.fromCharCode(...header)).toBe('RIFF');
			const view = new DataView(wav);
			expect(view.getUint16(22, true)).toBe(1); // channels
			expect(view.getUint32(24, true)).toBe(48000); // sample rate
			expect(view.getUint32(40, true)).toBe(4); // data length
		});

		it('should clamp clipping sums to the int16 range', async () => {
			storeSegment('a.tmp', [30000, -30000]);
			storeSegment('b.tmp', [30000, -30000]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			expect(Array.from(samples)).toEqual([32767, -32768]);
		});

		it('should pad shorter tracks with silence', async () => {
			storeSegment('long.tmp', [10, 20, 30, 40]);
			storeSegment('short.tmp', [5]);

			const samples = await mixedSamples([
				createTrack(['long.tmp']),
				createTrack(['short.tmp']),
			]);

			expect(Array.from(samples)).toEqual([15, 20, 30, 40]);
		});

		it('should duplicate mono into both channels of a stereo mix', async () => {
			// Stereo track: L/R interleaved; mono track is up-mixed
			storeSegment('stereo.tmp', [100, -100, 200, -200]);
			storeSegment('mono.tmp', [10, 20]);

			const samples = await mixedSamples([
				createTrack(['stereo.tmp'], 2),
				createTrack(['mono.tmp'], 1),
			]);

			expect(Array.from(samples)).toEqual([110, -90, 220, -180]);
		});

		it('should mix across segment boundaries and small windows', async () => {
			storeSegment('a1.tmp', [1, 2, 3]);
			storeSegment('a2.tmp', [4, 5]);
			storeSegment('b1.tmp', [10, 20, 30, 40, 50]);

			// Window of two frames forces several read iterations
			const samples = await mixedSamples(
				[createTrack(['a1.tmp', 'a2.tmp']), createTrack(['b1.tmp'])],
				2,
			);

			expect(Array.from(samples)).toEqual([11, 22, 33, 44, 55]);
		});

		it('should report progress up to 100', async () => {
			storeSegment('a.tmp', [1, 2, 3, 4]);
			const onProgress = jest.fn();

			await mixPcmTracksToWav(
				[createTrack(['a.tmp'])],
				mockApp,
				onProgress,
				2,
			);

			expect(onProgress).toHaveBeenLastCalledWith(100);
		});

		it('should throw when the adapter cannot report sizes', async () => {
			(mockApp.vault.adapter as unknown as Record<string, unknown>).stat =
				undefined;
			storeSegment('a.tmp', [1]);

			await expect(
				mixPcmTracksToWav([createTrack(['a.tmp'])], mockApp),
			).rejects.toThrow('cannot report file sizes');
		});
	});
});
