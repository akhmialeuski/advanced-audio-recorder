/**
 * Integration ("e2e as far as jsdom allows") tests for the on-demand
 * audio-cleanup pipeline. WebAudio (AudioContext / OfflineAudioContext)
 * and the vault are mocked so the full AudioProcessingService.process
 * path runs: read -> decode -> gate -> offline render -> WAV encode ->
 * write. Also covers the WAV encoder round-trip and the guards.
 *
 */

import type { App, TFile } from 'obsidian';
import { AudioProcessingService } from 'src/cleanup/AudioProcessingService';
import { floatToInt16 } from 'src/audio/pcm';
import type { AudioDspConfig } from 'src/cleanup/audioDsp';
import {
	MAX_AUDIO_CLEANUP_BYTES,
	MAX_AUDIO_CLEANUP_SECONDS,
	MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
} from 'src/constants';
import { at } from '../helpers/assertions';

// Controllable container probe: null (the default) means "container not
// parseable", which sends the pipeline down the plain decode path the
// existing tests exercise. The pre-decode guard tests override it.
jest.mock('src/utils/AudioFileAnalyzer', () => ({
	...jest.requireActual<typeof import('src/utils/AudioFileAnalyzer')>(
		'src/utils/AudioFileAnalyzer',
	),
	probeAudioMetadata: jest.fn(() => Promise.resolve(null)),
}));

/** A writable fake AudioBuffer. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): unknown {
	return {
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 0,
		sampleRate,
		duration: (channels[0]?.length ?? 0) / sampleRate,
		getChannelData: (i: number): Float32Array => at(channels, i),
	};
}

/** Chainable fake WebAudio node. */
function fakeNode(): Record<string, unknown> {
	return {
		type: '',
		buffer: null,
		frequency: { value: 0 },
		threshold: { value: 0 },
		knee: { value: 0 },
		ratio: { value: 0 },
		attack: { value: 0 },
		release: { value: 0 },
		gain: { value: 1 },
		connect: jest.fn(),
		start: jest.fn(),
	};
}

const decodeAudioData = jest.fn();

beforeAll(() => {
	class FakeAudioContext {
		decodeAudioData = decodeAudioData;
		close = jest.fn().mockResolvedValue(undefined);
	}
	class FakeOfflineAudioContext {
		private rendered: unknown = null;
		readonly destination = {};
		constructor(
			public numberOfChannels: number,
			public length: number,
			public sampleRate: number,
		) {}
		createBuffer(numChannels: number, length: number): unknown {
			const channels = Array.from(
				{ length: numChannels },
				() => new Float32Array(length),
			);
			this.rendered = fakeBuffer(channels, this.sampleRate);
			return this.rendered;
		}
		createBufferSource(): Record<string, unknown> {
			return fakeNode();
		}
		createBiquadFilter(): Record<string, unknown> {
			return fakeNode();
		}
		createDynamicsCompressor(): Record<string, unknown> {
			return fakeNode();
		}
		createGain(): Record<string, unknown> {
			return fakeNode();
		}
		startRendering(): Promise<unknown> {
			// Echo whatever was written into the created buffer
			return Promise.resolve(this.rendered);
		}
	}
	(globalThis as unknown as { AudioContext: unknown }).AudioContext =
		FakeAudioContext;
	(
		globalThis as unknown as { OfflineAudioContext: unknown }
	).OfflineAudioContext = FakeOfflineAudioContext;
});

/** Builds a fake App with an in-memory vault. */
function makeApp(): { app: App; written: Map<string, ArrayBuffer> } {
	const written = new Map<string, ArrayBuffer>();
	const adapter = {
		exists: (path: string): Promise<boolean> =>
			Promise.resolve(written.has(path)),
	};
	const vault = {
		adapter,
		readBinary: (): Promise<ArrayBuffer> =>
			Promise.resolve(new ArrayBuffer(16)),
		createBinary: (path: string, data: ArrayBuffer): Promise<void> => {
			written.set(path, data);
			return Promise.resolve();
		},
	};
	return { app: { vault } as unknown as App, written };
}

function fakeFile(path: string, size = 1024): TFile {
	const basename = path.slice(
		path.lastIndexOf('/') + 1,
		path.lastIndexOf('.'),
	);
	return { path, basename, stat: { size } } as unknown as TFile;
}

const ALL_STAGES: AudioDspConfig = {
	highPass: { enabled: true, hz: 80 },
	gate: { enabled: true, thresholdDb: -50 },
	leveling: { enabled: true, makeupDb: 6 },
	channelMode: 'source',
};

/** Parses the channel count / sample rate / frame count from a WAV blob. */
function readWavHeader(buffer: ArrayBuffer): {
	channels: number;
	sampleRate: number;
	dataBytes: number;
} {
	const view = new DataView(buffer);
	return {
		channels: view.getUint16(22, true),
		sampleRate: view.getUint32(24, true),
		dataBytes: view.getUint32(40, true),
	};
}

describe('AudioProcessingService.process (e2e pipeline)', () => {
	beforeEach(() => {
		decodeAudioData.mockReset();
	});

	it('decodes, processes, and writes a stereo WAV next to the source', async () => {
		const sampleRate = 16000;
		const left = new Float32Array(sampleRate).fill(0.4);
		const right = new Float32Array(sampleRate).fill(-0.4);
		decodeAudioData.mockResolvedValue(
			fakeBuffer([left, right], sampleRate),
		);

		const { app, written } = makeApp();
		const service = new AudioProcessingService(app);
		const outputPath = await service.process(
			fakeFile('voice/rec.mp3'),
			ALL_STAGES,
		);

		expect(outputPath).toBe('voice/rec-processed.wav');
		expect(written.has(outputPath)).toBe(true);
		const header = readWavHeader(written.get(outputPath) as ArrayBuffer);
		expect(header.channels).toBe(2);
		expect(header.sampleRate).toBe(sampleRate);
		expect(header.dataBytes).toBe(sampleRate * 2 * 2); // frames * ch * 2 bytes
	});

	it('downmixes a stereo source to mono when a mono mode is chosen', async () => {
		const sampleRate = 8000;
		const left = new Float32Array(sampleRate).fill(0.6);
		const right = new Float32Array(sampleRate).fill(0);
		decodeAudioData.mockResolvedValue(
			fakeBuffer([left, right], sampleRate),
		);
		const { app, written } = makeApp();
		const service = new AudioProcessingService(app);

		const path = await service.process(fakeFile('voice/rec.wav'), {
			highPass: { enabled: false, hz: 80 },
			gate: { enabled: false, thresholdDb: -50 },
			leveling: { enabled: false, makeupDb: 0 },
			channelMode: 'mono-left',
		});

		const buffer = written.get(path) as ArrayBuffer;
		const header = readWavHeader(buffer);
		// One channel out, and it carries the loud left channel untouched
		expect(header.channels).toBe(1);
		expect(header.dataBytes).toBe(sampleRate * 2);
		const pcm = new DataView(buffer, 44);
		expect(pcm.getInt16(0, true)).toBeGreaterThan(0);
	});

	it('processes a gate-only run without invoking the offline graph', async () => {
		const sampleRate = 16000;
		decodeAudioData.mockResolvedValue(
			fakeBuffer([new Float32Array(sampleRate).fill(0.2)], sampleRate),
		);
		const { app, written } = makeApp();
		const service = new AudioProcessingService(app);
		const path = await service.process(fakeFile('voice/rec.wav'), {
			highPass: { enabled: false, hz: 80 },
			gate: { enabled: true, thresholdDb: -50 },
			leveling: { enabled: false, makeupDb: 0 },
			channelMode: 'source',
		});
		expect(path).toBe('voice/rec-processed.wav');
		expect(readWavHeader(written.get(path) as ArrayBuffer).channels).toBe(
			1,
		);
	});

	it('segments a recording longer than one segment, writing the full length', async () => {
		// Force a 1-second segment so this 3.5s clip is processed across four
		// segments; the output must still cover every frame.
		const sampleRate = 1000;
		const numFrames = 3500;
		const loud = new Float32Array(numFrames).fill(0.5);
		decodeAudioData.mockResolvedValue(fakeBuffer([loud], sampleRate));
		const { app, written } = makeApp();
		const service = new AudioProcessingService(app, 1);
		const path = await service.process(fakeFile('voice/long.wav'), {
			highPass: { enabled: false, hz: 80 },
			gate: { enabled: true, thresholdDb: -50 },
			leveling: { enabled: false, makeupDb: 0 },
			channelMode: 'source',
		});
		const buffer = written.get(path) as ArrayBuffer;
		expect(readWavHeader(buffer).dataBytes).toBe(numFrames * 2);
		// A frame in the final segment carries real audio (the loud input opens
		// the gate), proving every segment's output landed in the buffer rather
		// than leaving the tail as the initial zeros.
		const pcm = new DataView(buffer, 44);
		expect(
			Math.abs(pcm.getInt16((numFrames - 1) * 2, true)),
		).toBeGreaterThan(0);
	});

	it('rejects files larger than the byte limit before decoding', async () => {
		const { app } = makeApp();
		await expect(
			new AudioProcessingService(app).process(
				fakeFile('huge.wav', MAX_AUDIO_CLEANUP_BYTES + 1),
				ALL_STAGES,
			),
		).rejects.toThrow(/too large/i);
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it('rejects files longer than the cleanup limit', async () => {
		const sampleRate = 16000;
		const tooLong = new Float32Array(
			sampleRate * (MAX_AUDIO_CLEANUP_SECONDS + 60),
		);
		decodeAudioData.mockResolvedValue(fakeBuffer([tooLong], sampleRate));
		const { app } = makeApp();
		await expect(
			new AudioProcessingService(app).process(
				fakeFile('long.wav'),
				ALL_STAGES,
			),
		).rejects.toThrow(/too long/i);
	});

	it('rejects files whose decoded working set exceeds the sample cap', async () => {
		// A short, highly compressed file can pass the byte and duration
		// guards yet decode to a buffer too large to hold several copies of.
		// length x channels exceeds the cap while the duration stays under
		// the limit, so the decoded-sample guard is what rejects it.
		const sampleRate = 48000;
		const oversized = {
			numberOfChannels: 2,
			length: MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
			sampleRate,
			duration: MAX_AUDIO_CLEANUP_DECODED_SAMPLES / sampleRate,
			getChannelData: (): Float32Array => new Float32Array(1),
		};
		decodeAudioData.mockResolvedValue(oversized);
		const { app } = makeApp();
		await expect(
			new AudioProcessingService(app).process(
				fakeFile('dense.opus'),
				ALL_STAGES,
			),
		).rejects.toThrow(/too large/i);
	});

	it('rejects files with no decodable audio', async () => {
		decodeAudioData.mockResolvedValue(fakeBuffer([], 16000));
		const { app } = makeApp();
		await expect(
			new AudioProcessingService(app).process(
				fakeFile('empty.wav'),
				ALL_STAGES,
			),
		).rejects.toThrow(/no decodable audio/i);
	});

	it('propagates a decode failure (unsupported container)', async () => {
		decodeAudioData.mockRejectedValue(new Error('Unable to decode audio'));
		const { app } = makeApp();
		await expect(
			new AudioProcessingService(app).process(
				fakeFile('bad.mp3'),
				ALL_STAGES,
			),
		).rejects.toThrow(/decode/i);
	});

	it('rejects an oversized decode from container metadata BEFORE decoding', async () => {
		// A compact compressed file passes the byte guard, but its
		// metadata reveals a decoded working set over the cap: the guard
		// must fire before decodeAudioData materializes the whole PCM
		// (on mobile that allocation gets the WebView killed).
		const { probeAudioMetadata } = jest.requireMock<{
			probeAudioMetadata: jest.Mock;
		}>('src/utils/AudioFileAnalyzer');
		probeAudioMetadata.mockResolvedValueOnce({
			durationSeconds: MAX_AUDIO_CLEANUP_DECODED_SAMPLES / 2 / 48000 + 1,
			sampleRate: 48000,
			channels: 2,
		});
		const { app } = makeApp();

		await expect(
			new AudioProcessingService(app).process(
				fakeFile('dense.opus'),
				ALL_STAGES,
			),
		).rejects.toThrow(/too large/i);
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it('rejects an over-long file from container metadata BEFORE decoding', async () => {
		const { probeAudioMetadata } = jest.requireMock<{
			probeAudioMetadata: jest.Mock;
		}>('src/utils/AudioFileAnalyzer');
		probeAudioMetadata.mockResolvedValueOnce({
			durationSeconds: MAX_AUDIO_CLEANUP_SECONDS + 60,
			sampleRate: 16000,
			channels: 1,
		});
		const { app } = makeApp();

		await expect(
			new AudioProcessingService(app).process(
				fakeFile('long.opus'),
				ALL_STAGES,
			),
		).rejects.toThrow(/too long/i);
		expect(decodeAudioData).not.toHaveBeenCalled();
	});

	it('does not size the decode against a length the headers never carried', async () => {
		// A container that parsed but stamped no length is this plugin's own
		// output. Reading that as a zero-second recording would put every such
		// file under every ceiling, which is the opposite of what these guards
		// are for; the decode's own post-check is what bounds it instead.
		const { probeAudioMetadata } = jest.requireMock<{
			probeAudioMetadata: jest.Mock;
		}>('src/utils/AudioFileAnalyzer');
		probeAudioMetadata.mockResolvedValueOnce({
			durationSeconds: null,
			sampleRate: 48000,
			channels: 2,
		});
		decodeAudioData.mockResolvedValue(
			fakeBuffer([new Float32Array(16000)], 16000),
		);
		const { app } = makeApp();

		await new AudioProcessingService(app).process(
			fakeFile('live.webm'),
			ALL_STAGES,
		);

		expect(decodeAudioData).toHaveBeenCalled();
	});

	it('proceeds to decode when metadata stays within the limits', async () => {
		const { probeAudioMetadata } = jest.requireMock<{
			probeAudioMetadata: jest.Mock;
		}>('src/utils/AudioFileAnalyzer');
		probeAudioMetadata.mockResolvedValueOnce({
			durationSeconds: 1,
			sampleRate: 16000,
			channels: 1,
		});
		decodeAudioData.mockResolvedValue(
			fakeBuffer([new Float32Array(16000)], 16000),
		);
		const { app, written } = makeApp();

		await new AudioProcessingService(app).process(
			fakeFile('short.wav'),
			ALL_STAGES,
		);

		expect(decodeAudioData).toHaveBeenCalled();
		expect(written.size).toBe(1);
	});
});

describe('floatToInt16', () => {
	it('maps the rails asymmetrically (-1 -> -32768, +1 -> 32767)', () => {
		expect(floatToInt16(1)).toBe(32767);
		expect(floatToInt16(-1)).toBe(-32768);
		expect(floatToInt16(0)).toBe(0);
		// 0.5 scales by the positive rail (0x7fff).
		expect(floatToInt16(0.5)).toBeCloseTo(16384, -1);
		// Negatives scale by the full negative rail (0x8000).
		expect(floatToInt16(-0.5)).toBe(-16384);
	});

	it('clamps samples outside the -1..1 range', () => {
		expect(floatToInt16(2)).toBe(32767);
		expect(floatToInt16(-2)).toBe(-32768);
	});
});
