/**
 * Tests the parts of audioChunks that turn decoded audio into the bytes a
 * provider actually receives: the mono WAV encoder, the per-chunk extractor,
 * and the 16 kHz mono decode. These are what make every source format chunk
 * identically, so a regression here corrupts uploads for one format only -
 * the kind of bug the pure planning tests cannot catch.
 * @module tests/unit/audioChunksEncoding.test
 */

import {
	decodeToMono16k,
	encodeMonoWav,
	extractChunkWav,
	planChunks,
} from 'src/transcription/audioChunks';
import { WAV_HEADER_SIZE } from 'src/audio/WavEncoder';
import { floatToInt16 } from 'src/audio/pcm';
import { TRANSCRIBE_SAMPLE_RATE } from 'src/constants';
import { decodeAudioBlob } from 'src/audio/AudioFormatConverter';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';
import { at, defined } from '../helpers/assertions';

jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn(),
}));

const mockDecodeAudioBlob = decodeAudioBlob as jest.MockedFunction<
	typeof decodeAudioBlob
>;

/** Reads a WAV buffer's header fields and its int16 PCM samples. */
function readWav(buffer: ArrayBuffer): {
	channels: number;
	sampleRate: number;
	declaredDataBytes: number;
	samples: number[];
} {
	const header = new DataView(buffer);
	const pcm = new DataView(buffer, WAV_HEADER_SIZE);
	const samples: number[] = [];
	for (let i = 0; i < pcm.byteLength / 2; i++) {
		samples.push(pcm.getInt16(i * 2, true));
	}
	return {
		channels: header.getUint16(22, true),
		sampleRate: header.getUint32(24, true),
		declaredDataBytes: header.getUint32(40, true),
		samples,
	};
}

describe('encodeMonoWav', () => {
	it('writes a mono 16-bit header that matches the payload it carries', async () => {
		const wav = await encodeMonoWav(
			new Float32Array([0, 0.5, -0.5]),
			TRANSCRIBE_SAMPLE_RATE,
		);

		const parsed = readWav(wav);
		expect(wav.byteLength).toBe(WAV_HEADER_SIZE + 3 * 2);
		expect(parsed.channels).toBe(1);
		expect(parsed.sampleRate).toBe(TRANSCRIBE_SAMPLE_RATE);
		// A header that under-declares its data length truncates the audio for
		// any provider that trusts the chunk size.
		expect(parsed.declaredDataBytes).toBe(3 * 2);
	});

	it('converts each float sample through the shared int16 conversion', async () => {
		const input = new Float32Array([0, 1, -1, 0.25, -0.25, 2, -2]);

		const parsed = readWav(
			await encodeMonoWav(input, TRANSCRIBE_SAMPLE_RATE),
		);

		// Includes the out-of-range values: they must clamp, not wrap around
		// into the opposite sign.
		expect(parsed.samples).toEqual(
			Array.from(input, (sample) => floatToInt16(sample)),
		);
	});

	it('encodes an empty buffer as a valid header-only WAV', async () => {
		const wav = await encodeMonoWav(
			new Float32Array(0),
			TRANSCRIBE_SAMPLE_RATE,
		);

		expect(wav.byteLength).toBe(WAV_HEADER_SIZE);
		expect(readWav(wav).declaredDataBytes).toBe(0);
	});

	it('yields to the event loop between slices without dropping samples', async () => {
		// One frame past the yield threshold, so the loop takes the second slice
		// and the await between them. Every sample must still land: an off-by-one
		// in the slice bounds would silently truncate a real upload chunk.
		const frames = 500_001;
		const input = new Float32Array(frames);
		input[0] = 1;
		input[frames - 1] = -1;
		const setTimeoutSpy = jest.spyOn(window, 'setTimeout');

		const wav = await encodeMonoWav(input, TRANSCRIBE_SAMPLE_RATE);

		expect(wav.byteLength).toBe(WAV_HEADER_SIZE + frames * 2);
		const pcm = new DataView(wav, WAV_HEADER_SIZE);
		expect(pcm.getInt16(0, true)).toBe(floatToInt16(1));
		expect(pcm.getInt16((frames - 1) * 2, true)).toBe(floatToInt16(-1));
		expect(setTimeoutSpy).toHaveBeenCalled();
	});
});

describe('extractChunkWav', () => {
	const samples = new Float32Array(TRANSCRIBE_SAMPLE_RATE * 3);
	// Mark the first frame of each second so a slice can be identified by value.
	samples[0] = 1;
	samples[TRANSCRIBE_SAMPLE_RATE] = 0.5;
	samples[TRANSCRIBE_SAMPLE_RATE * 2] = -0.5;

	it('cuts exactly the requested span at 16 kHz', async () => {
		const wav = await extractChunkWav(samples, {
			index: 1,
			startSeconds: 1,
			endSeconds: 2,
		});

		const parsed = readWav(wav);
		expect(parsed.samples).toHaveLength(TRANSCRIBE_SAMPLE_RATE);
		expect(at(parsed.samples, 0)).toBe(floatToInt16(0.5));
	});

	it('tiles adjacent chunks with no duplicated or dropped frame', async () => {
		const plans = planChunks(3, 1);
		expect(plans).toHaveLength(3);

		const parts = await Promise.all(
			plans.map((plan) => extractChunkWav(samples, plan)),
		);

		const total = parts.reduce(
			(sum, part) => sum + (part.byteLength - WAV_HEADER_SIZE) / 2,
			0,
		);
		expect(total).toBe(samples.length);
		// Each chunk starts on the frame the previous one ended at, so the
		// markers land at the head of their own chunk and nowhere else.
		expect(at(readWav(at(parts, 0)).samples, 0)).toBe(floatToInt16(1));
		expect(at(readWav(at(parts, 1)).samples, 0)).toBe(floatToInt16(0.5));
		expect(at(readWav(at(parts, 2)).samples, 0)).toBe(floatToInt16(-0.5));
	});

	it('clamps a chunk that runs past the end of the samples', async () => {
		const wav = await extractChunkWav(samples, {
			index: 0,
			startSeconds: 2,
			endSeconds: 60,
		});

		expect(readWav(wav).samples).toHaveLength(TRANSCRIBE_SAMPLE_RATE);
	});

	it('yields an empty chunk when the plan starts past the end', async () => {
		const wav = await extractChunkWav(samples, {
			index: 0,
			startSeconds: 10,
			endSeconds: 20,
		});

		// Clamping both ends to the sample length would otherwise produce a
		// negative-length subarray, and Float32Array reads that as "to the end".
		expect(wav.byteLength).toBe(WAV_HEADER_SIZE);
	});
});

describe('decodeToMono16k', () => {
	/** An OfflineAudioContext fake that renders the buffer it was given. */
	class FakeOfflineAudioContext {
		static last: FakeOfflineAudioContext | null = null;
		readonly destination = {};
		source: { buffer: AudioBuffer | null; started: boolean } = {
			buffer: null,
			started: false,
		};
		constructor(
			readonly channels: number,
			readonly frames: number,
			readonly sampleRate: number,
		) {
			FakeOfflineAudioContext.last = this;
		}
		createBufferSource(): unknown {
			return {
				set buffer(value: AudioBuffer) {
					FakeOfflineAudioContext.last!.source.buffer = value;
				},
				connect: (): void => {},
				start: (): void => {
					FakeOfflineAudioContext.last!.source.started = true;
				},
			};
		}
		startRendering(): Promise<AudioBuffer> {
			return Promise.resolve(
				createMockAudioBuffer(1, this.frames, this.sampleRate),
			);
		}
	}

	const originalOffline = global.OfflineAudioContext;

	beforeEach(() => {
		FakeOfflineAudioContext.last = null;
		global.OfflineAudioContext =
			FakeOfflineAudioContext as unknown as typeof OfflineAudioContext;
	});

	afterEach(() => {
		global.OfflineAudioContext = originalOffline;
	});

	it('renders the decoded audio into one 16 kHz mono channel', async () => {
		mockDecodeAudioBlob.mockResolvedValue(
			createMockAudioBuffer(2, 96000, 48000),
		);

		const samples = await decodeToMono16k(new ArrayBuffer(8));

		const context = defined(FakeOfflineAudioContext.last, 'context');
		expect(context.channels).toBe(1);
		expect(context.sampleRate).toBe(TRANSCRIBE_SAMPLE_RATE);
		// 2 s of 48 kHz stereo resamples to 2 s of 16 kHz mono.
		expect(context.frames).toBe(TRANSCRIBE_SAMPLE_RATE * 2);
		expect(context.source.started).toBe(true);
		expect(samples).toHaveLength(TRANSCRIBE_SAMPLE_RATE * 2);
	});

	it('returns no samples for a zero-length decode instead of constructing a context', async () => {
		mockDecodeAudioBlob.mockResolvedValue(
			createMockAudioBuffer(1, 0, 48000),
		);

		const samples = await decodeToMono16k(new ArrayBuffer(8));

		expect(samples).toHaveLength(0);
		// OfflineAudioContext rejects a zero frame count, so the guard has to
		// come before construction rather than after.
		expect(FakeOfflineAudioContext.last).toBeNull();
	});

	it('propagates a decode failure rather than returning silence', async () => {
		mockDecodeAudioBlob.mockRejectedValue(new Error('unsupported codec'));

		await expect(decodeToMono16k(new ArrayBuffer(8))).rejects.toThrow(
			'unsupported codec',
		);
	});
});
