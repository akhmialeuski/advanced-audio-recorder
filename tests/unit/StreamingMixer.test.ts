/**
 * Unit tests for StreamingMixer module.
 * Mixes synthetic PCM fixtures and verifies exact sample values.
 * @module tests/unit/StreamingMixer.test
 */

import {
	canStreamMix,
	mixLayout,
	mixPcmTracksToWav,
} from 'src/recording/StreamingMixer';
import type { PcmMixTrack } from 'src/recording/StreamingMixer';
import type { App } from 'obsidian';
import { createMockApp } from '../helpers/createApp';

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
		segments = new Map();
		mockApp = createMockApp({
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
		}).app;
	});

	// The size of the mixed file is asked for from both ends: here, to
	// allocate it, and by a running recording, to warn before the container
	// ceiling is reached. One rule answers both, so the warning cannot be
	// computed from an arithmetic the mixer does differently.
	describe('mixLayout', () => {
		it('sizes a mix of equal mono tracks as one of them', () => {
			const layout = mixLayout([
				{ pcmBytes: 800, channels: 1 },
				{ pcmBytes: 800, channels: 1 },
			]);

			expect(layout).toEqual({
				totalFrames: 400,
				outChannels: 1,
				pcmByteLength: 800,
			});
		});

		// The case the warning was blind to: the mixed file is twice the mono
		// track that is most of it, because one stereo track takes the whole
		// mix up to stereo.
		it('doubles a long mono track that a stereo one takes up to stereo', () => {
			const layout = mixLayout([
				{ pcmBytes: 800, channels: 1 },
				{ pcmBytes: 80, channels: 2 },
			]);

			expect(layout.outChannels).toBe(2);
			expect(layout.pcmByteLength).toBe(1600);
		});

		it('takes its length from the longest track', () => {
			expect(
				mixLayout([
					{ pcmBytes: 400, channels: 2 },
					{ pcmBytes: 1200, channels: 2 },
				]).pcmByteLength,
			).toBe(1200);
		});

		it('sizes nothing at all as nothing', () => {
			expect(mixLayout([])).toEqual({
				totalFrames: 0,
				outChannels: 0,
				pcmByteLength: 0,
			});
		});
	});

	describe('canStreamMix', () => {
		it('accepts tracks with one shared sample rate', () => {
			expect(
				canStreamMix([
					createTrack(['a.tmp']),
					createTrack(['b.tmp'], 2),
				]),
			).toBe(true);
		});

		it('rejects mismatched sample rates', () => {
			expect(
				canStreamMix([
					createTrack(['a.tmp'], 1, 44100),
					createTrack(['b.tmp'], 1, 48000),
				]),
			).toBe(false);
		});

		it('rejects empty input', () => {
			expect(canStreamMix([])).toBe(false);
			expect(canStreamMix([createTrack([])])).toBe(false);
		});
	});

	describe('mixPcmTracksToWav', () => {
		it('sums mono tracks sample by sample', async () => {
			storeSegment('a.tmp', [100, -200, 300]);
			storeSegment('b.tmp', [10, 20, -30]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			expect(Array.from(samples)).toEqual([110, -180, 270]);
		});

		it('writes a valid WAV header for the mix', async () => {
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

		it('clamps clipping sums to the int16 range', async () => {
			storeSegment('a.tmp', [30000, -30000]);
			storeSegment('b.tmp', [30000, -30000]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			expect(Array.from(samples)).toEqual([32767, -32768]);
		});

		it('pads shorter tracks with silence', async () => {
			storeSegment('long.tmp', [10, 20, 30, 40]);
			storeSegment('short.tmp', [5]);

			const samples = await mixedSamples([
				createTrack(['long.tmp']),
				createTrack(['short.tmp']),
			]);

			expect(Array.from(samples)).toEqual([15, 20, 30, 40]);
		});

		it('duplicates mono into both channels of a stereo mix', async () => {
			// Stereo track: L/R interleaved; mono track is up-mixed
			storeSegment('stereo.tmp', [100, -100, 200, -200]);
			storeSegment('mono.tmp', [10, 20]);

			const samples = await mixedSamples([
				createTrack(['stereo.tmp'], 2),
				createTrack(['mono.tmp'], 1),
			]);

			expect(Array.from(samples)).toEqual([110, -90, 220, -180]);
		});

		it('mixes across segment boundaries and small windows', async () => {
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

		it('reports progress up to 100', async () => {
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

		it('throws when the adapter cannot report sizes', async () => {
			(mockApp.vault.adapter as unknown as Record<string, unknown>).stat =
				undefined;
			storeSegment('a.tmp', [1]);

			await expect(
				mixPcmTracksToWav([createTrack(['a.tmp'])], mockApp),
			).rejects.toThrow('cannot report file sizes');
		});
	});
});
