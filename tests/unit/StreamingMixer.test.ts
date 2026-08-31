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
import type { MixOptions, PcmMixTrack } from 'src/recording/StreamingMixer';
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
		placement: Pick<PcmMixTrack, 'gainDb' | 'pan'> = {},
	): PcmMixTrack => ({
		segmentPaths: paths,
		channels,
		sampleRate,
		...placement,
	});

	const mixedSamples = async (
		tracks: PcmMixTrack[],
		options: MixOptions = {},
	): Promise<Int16Array> => {
		const wav = await mixPcmTracksToWav(tracks, mockApp, options);
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
				{ pcmBytes: 800, channels: 1, sampleRate: 44100 },
				{ pcmBytes: 800, channels: 1, sampleRate: 44100 },
			]);

			expect(layout).toEqual({
				totalFrames: 400,
				outChannels: 1,
				sampleRate: 44100,
				pcmByteLength: 800,
			});
		});

		// The case the warning was blind to: the mixed file is twice the mono
		// track that is most of it, because one stereo track takes the whole
		// mix up to stereo.
		it('doubles a long mono track that a stereo one takes up to stereo', () => {
			const layout = mixLayout([
				{ pcmBytes: 800, channels: 1, sampleRate: 44100 },
				{ pcmBytes: 80, channels: 2, sampleRate: 44100 },
			]);

			expect(layout.outChannels).toBe(2);
			expect(layout.pcmByteLength).toBe(1600);
		});

		it('takes its length from the longest track', () => {
			expect(
				mixLayout([
					{ pcmBytes: 400, channels: 2, sampleRate: 44100 },
					{ pcmBytes: 1200, channels: 2, sampleRate: 44100 },
				]).pcmByteLength,
			).toBe(1200);
		});

		it('sizes nothing at all as nothing', () => {
			expect(mixLayout([])).toEqual({
				totalFrames: 0,
				outChannels: 0,
				sampleRate: 0,
				pcmByteLength: 0,
			});
		});

		// The mix runs at the fastest track's rate, so no track is decimated
		// to suit another, and the slower one covers the same seconds in more
		// frames than it was captured in.
		it('writes at the fastest rate and lengthens the slower track to it', () => {
			const layout = mixLayout([
				{ pcmBytes: 800, channels: 1, sampleRate: 22050 },
				{ pcmBytes: 400, channels: 1, sampleRate: 44100 },
			]);

			expect(layout.sampleRate).toBe(44100);
			expect(layout.totalFrames).toBe(800);
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

		// Two interfaces at 44100 and 48000 used to send an hour of audio
		// through a full decode for a difference of ten percent.
		it('accepts mismatched sample rates, which it now resamples', () => {
			expect(
				canStreamMix([
					createTrack(['a.tmp'], 1, 44100),
					createTrack(['b.tmp'], 1, 48000),
				]),
			).toBe(true);
		});

		it('rejects a track with no rate at all', () => {
			expect(canStreamMix([createTrack(['a.tmp'], 1, 0)])).toBe(false);
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

		// Clipping flattened the loud moment and left the quiet one alone,
		// which is distortion. Scaling the file by one factor costs level and
		// keeps the shape of what was recorded.
		it('scales a sum that would clip instead of flattening its peak', async () => {
			storeSegment('a.tmp', [30000, 3000]);
			storeSegment('b.tmp', [30000, 3000]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			const [loud, quiet] = [samples[0] ?? 0, samples[1] ?? 0];
			expect(loud).toBe(32767);
			// The ratio between the two moments survives, which is what
			// clipping destroyed: it wrote 32767 and 6000
			expect(quiet).toBeCloseTo(loud / 10, -1);
		});

		it('leaves a mix that never approached full scale at its own level', async () => {
			storeSegment('a.tmp', [1000, -2000]);
			storeSegment('b.tmp', [500, 500]);

			const samples = await mixedSamples([
				createTrack(['a.tmp']),
				createTrack(['b.tmp']),
			]);

			expect(Array.from(samples)).toEqual([1500, -1500]);
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
				{ windowFrames: 2 },
			);

			expect(Array.from(samples)).toEqual([11, 22, 33, 44, 55]);
		});

		it('reports progress up to 100', async () => {
			storeSegment('a.tmp', [1, 2, 3, 4]);
			const onProgress = jest.fn();

			await mixPcmTracksToWav([createTrack(['a.tmp'])], mockApp, {
				onProgress,
				windowFrames: 2,
			});

			expect(onProgress).toHaveBeenLastCalledWith(100);
		});

		it('applies a track gain before summing', async () => {
			storeSegment('a.tmp', [1000, -1000]);

			const samples = await mixedSamples([
				createTrack(['a.tmp'], 1, 44100, { gainDb: -6 }),
			]);

			// Six decibels down is half the amplitude
			expect(Array.from(samples)).toEqual([501, -501]);
		});

		// Two mono microphones one to each side is the reason panning exists,
		// so the pan itself has to take the mix to stereo.
		it('sends panned mono tracks to opposite sides of a stereo mix', async () => {
			storeSegment('left.tmp', [100, 200]);
			storeSegment('right.tmp', [30, 40]);

			const samples = await mixedSamples([
				createTrack(['left.tmp'], 1, 44100, { pan: -1 }),
				createTrack(['right.tmp'], 1, 44100, { pan: 1 }),
			]);

			expect(Array.from(samples)).toEqual([100, 30, 200, 40]);
		});

		it('keeps a centred track at full level on both sides', async () => {
			storeSegment('stereo.tmp', [10, 20]);
			storeSegment('mono.tmp', [100]);

			const samples = await mixedSamples([
				createTrack(['stereo.tmp'], 2),
				createTrack(['mono.tmp'], 1, 44100, { pan: 0 }),
			]);

			expect(Array.from(samples)).toEqual([110, 120]);
		});

		// A guest recorded on a laptop microphone beside a host on an
		// interface is the case: without this the guest is inaudible.
		it('brings tracks to a common level when asked to align them', async () => {
			storeSegment('quiet.tmp', [2000, -2000]);
			storeSegment('loud.tmp', [16000, -16000]);

			const samples = await mixedSamples(
				[createTrack(['quiet.tmp']), createTrack(['loud.tmp'])],
				{ alignLevels: true },
			);

			// Both tracks now contribute the same 8192
			expect(Array.from(samples)).toEqual([16384, -16384]);
		});

		it('leaves the tracks as captured when alignment is off', async () => {
			storeSegment('quiet.tmp', [2000, -2000]);
			storeSegment('loud.tmp', [16000, -16000]);

			const samples = await mixedSamples([
				createTrack(['quiet.tmp']),
				createTrack(['loud.tmp']),
			]);

			expect(Array.from(samples)).toEqual([18000, -18000]);
		});

		// The route this used to refuse: one interface at 22050 beside one at
		// 44100 sent the whole session through a full decode.
		it('resamples a slower track into the fastest rate present', async () => {
			storeSegment('slow.tmp', [0, 1000, 2000, 0]);
			storeSegment('fast.tmp', [0, 0, 0, 0, 0, 0, 0, 0]);

			const samples = await mixedSamples([
				createTrack(['slow.tmp'], 1, 22050),
				createTrack(['fast.tmp'], 1, 44100),
			]);

			expect(Array.from(samples)).toEqual([
				0, 500, 1000, 1500, 2000, 1000, 0, 0,
			]);
		});

		it('writes the mix at the fastest rate present', async () => {
			storeSegment('slow.tmp', [1, 2]);
			storeSegment('fast.tmp', [3, 4]);

			const wav = await mixPcmTracksToWav(
				[
					createTrack(['slow.tmp'], 1, 22050),
					createTrack(['fast.tmp'], 1, 48000),
				],
				mockApp,
			);

			expect(new DataView(wav).getUint32(24, true)).toBe(48000);
		});

		// The reason this mixer exists. The Web Audio route decodes every
		// track into float32 before it can sum them, which is what cost
		// gigabytes for an hour of two-track audio. Here the session grows
		// fourfold and what the mixer holds does not move: only the output
		// file, which is the deliverable, grows with it.
		it('holds one segment per track however long the session is', async () => {
			const segmentFrames = 512;
			const mixSession = async (
				segmentCount: number,
			): Promise<{ held: number; captured: number }> => {
				const slow: string[] = [];
				const fast: string[] = [];
				for (let index = 0; index < segmentCount; index++) {
					const names = [
						`slow-${String(segmentCount)}-${String(index)}.tmp`,
						`fast-${String(segmentCount)}-${String(index)}.tmp`,
					] as const;
					slow.push(names[0]);
					fast.push(names[1]);
					storeSegment(
						names[0],
						new Array<number>(segmentFrames).fill(index * 100),
					);
					storeSegment(
						names[1],
						new Array<number>(segmentFrames).fill(index * 50),
					);
				}
				jest.mocked(mockApp.vault.adapter.readBinary).mockClear();
				await mixPcmTracksToWav(
					[createTrack(slow, 1, 22050), createTrack(fast, 1, 44100)],
					mockApp,
					{ windowFrames: 128 },
				);
				const reads = jest
					.mocked(mockApp.vault.adapter.readBinary)
					.mock.calls.map(
						([path]) => segments.get(path)?.byteLength ?? 0,
					);
				return {
					// A reader drops the segment before it reads the next, so
					// what the mix holds at once is one segment per track
					held: Math.max(...reads) * 2,
					captured: new Set(
						jest
							.mocked(mockApp.vault.adapter.readBinary)
							.mock.calls.map(([path]) => path),
					).size,
				};
			};

			const short = await mixSession(4);
			const long = await mixSession(16);

			expect(long.held).toBe(short.held);
			expect(long.held).toBe(segmentFrames * 2 * 2);
			expect(long.captured).toBe(short.captured * 4);
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
