/**
 * Integration ("e2e as far as jsdom allows") tests for the on-demand
 * audio-cleanup pipeline. WebAudio (AudioContext / OfflineAudioContext)
 * and the vault are mocked so the full AudioProcessingService.process
 * path runs: read -> decode -> gate -> offline render -> WAV encode ->
 * write. Also covers the WAV encoder round-trip and the guards.
 *
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian';
import {
	AudioProcessingService,
	encodeWavInterleaved,
} from 'src/cleanup/AudioProcessingService';
import type { AudioDspConfig } from 'src/cleanup/audioDsp';
import {
	MAX_AUDIO_CLEANUP_BYTES,
	MAX_AUDIO_CLEANUP_SECONDS,
} from 'src/constants';

/** A writable fake AudioBuffer. */
function fakeBuffer(channels: Float32Array[], sampleRate: number): unknown {
	return {
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 0,
		sampleRate,
		duration: (channels[0]?.length ?? 0) / sampleRate,
		getChannelData: (i: number): Float32Array => channels[i],
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
		});
		expect(path).toBe('voice/rec-processed.wav');
		expect(readWavHeader(written.get(path) as ArrayBuffer).channels).toBe(
			1,
		);
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
});

describe('encodeWavInterleaved', () => {
	it('writes a header and interleaves channels, round-tripping samples', () => {
		const left = new Float32Array([1, 0, -1]);
		const right = new Float32Array([0, 0.5, -0.5]);
		const wav = encodeWavInterleaved([left, right], 48000);
		const header = readWavHeader(wav);
		expect(header.channels).toBe(2);
		expect(header.sampleRate).toBe(48000);
		expect(header.dataBytes).toBe(3 * 2 * 2);

		const view = new DataView(wav, 44);
		// Frame 0: left=1 -> 32767, right=0 -> 0
		expect(view.getInt16(0, true)).toBe(32767);
		expect(view.getInt16(2, true)).toBe(0);
		// Frame 1: left=0 -> 0, right=0.5 -> ~16384
		expect(view.getInt16(6, true)).toBeCloseTo(16384, -1);
		// Clipping: -1 -> -32767
		expect(view.getInt16(8, true)).toBe(-32767);
	});

	it('produces a header-only file for empty channels', () => {
		const wav = encodeWavInterleaved([], 16000);
		expect(readWavHeader(wav).dataBytes).toBe(0);
	});
});
