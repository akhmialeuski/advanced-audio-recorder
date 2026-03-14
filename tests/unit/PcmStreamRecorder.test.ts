/**
 * Unit tests for PcmStreamRecorder module.
 * Tests real-time PCM capture from MediaStream using ScriptProcessorNode.
 * @module tests/unit/PcmStreamRecorder.test
 */
/** @jest-environment jsdom */

import { PcmStreamRecorder } from '../../src/recording/PcmStreamRecorder';

// Mock AudioContext and related Web Audio API
let mockProcessorCallback: ((event: AudioProcessingEvent) => void) | null =
	null;

const mockScriptProcessor = {
	onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
	connect: jest.fn(),
	disconnect: jest.fn(),
};

const mockGainNode = {
	gain: { value: 1 },
	connect: jest.fn(),
	disconnect: jest.fn(),
};

const mockSourceNode = {
	channelCount: 1,
	connect: jest.fn(),
	disconnect: jest.fn(),
};

const mockAudioContext = {
	sampleRate: 44100,
	destination: {},
	createMediaStreamSource: jest.fn().mockReturnValue(mockSourceNode),
	createScriptProcessor: jest.fn().mockImplementation(() => {
		const processor = { ...mockScriptProcessor, onaudioprocess: null };
		// Capture the onaudioprocess setter
		const proxy = new Proxy(processor, {
			set(target, prop, value) {
				if (prop === 'onaudioprocess') {
					mockProcessorCallback = value as
						| ((event: AudioProcessingEvent) => void)
						| null;
				}
				(target as Record<string, unknown>)[prop as string] = value;
				return true;
			},
		});
		return proxy;
	}),
	createGain: jest.fn().mockReturnValue(mockGainNode),
	close: jest.fn().mockResolvedValue(undefined),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global AudioContext
(global as any).AudioContext = jest
	.fn()
	.mockImplementation(() => mockAudioContext);

function createMockStream(channelCount: number = 1): MediaStream {
	return {
		getAudioTracks: () => [
			{
				stop: jest.fn(),
				getSettings: () => ({ channelCount }),
			},
		],
		getTracks: () => [{ stop: jest.fn() }],
	} as unknown as MediaStream;
}

function createMockAudioProcessingEvent(
	numSamples: number,
	numChannels: number,
): AudioProcessingEvent {
	const channels: Float32Array[] = [];
	for (let c = 0; c < numChannels; c++) {
		const data = new Float32Array(numSamples);
		for (let i = 0; i < numSamples; i++) {
			data[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
		}
		channels.push(data);
	}

	return {
		inputBuffer: {
			length: numSamples,
			numberOfChannels: numChannels,
			getChannelData: (ch: number) => channels[ch],
		},
	} as unknown as AudioProcessingEvent;
}

describe('PcmStreamRecorder', () => {
	let onChunkMock: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		mockProcessorCallback = null;
		mockGainNode.gain.value = 1;
		mockSourceNode.channelCount = 1;
		onChunkMock = jest.fn();
	});

	describe('start', () => {
		it('should create AudioContext with requested sample rate', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 48000, onChunkMock);

			await recorder.start();

			expect(global.AudioContext).toHaveBeenCalledWith({
				sampleRate: 48000,
			});
		});

		it('should connect audio graph: source → processor → gain(0) → destination', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(
				mockAudioContext.createMediaStreamSource,
			).toHaveBeenCalledWith(stream);
			expect(mockAudioContext.createScriptProcessor).toHaveBeenCalledWith(
				4096,
				1,
				1,
			);
			expect(mockAudioContext.createGain).toHaveBeenCalled();
			expect(mockGainNode.gain.value).toBe(0);
		});

		it('should expose actual channels and sampleRate from AudioContext', async () => {
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(2);
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(recorder.channels).toBe(2);
			expect(recorder.sampleRate).toBe(44100);
		});
	});

	describe('onaudioprocess callback', () => {
		it('should deliver interleaved int16 PCM data via onChunk', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			const event = createMockAudioProcessingEvent(128, 1);
			mockProcessorCallback?.(event);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			// 128 samples * 1 channel * 2 bytes per int16 = 256 bytes
			expect(chunkBuffer.byteLength).toBe(256);
		});

		it('should interleave stereo samples correctly', async () => {
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(2);
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			const event = createMockAudioProcessingEvent(64, 2);
			mockProcessorCallback?.(event);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			// 64 samples * 2 channels * 2 bytes = 256 bytes
			expect(chunkBuffer.byteLength).toBe(256);
		});

		it('should clamp sample values to [-1, 1] range', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			// Create event with out-of-range values
			const event = {
				inputBuffer: {
					length: 2,
					numberOfChannels: 1,
					getChannelData: () => new Float32Array([2.0, -2.0]),
				},
			} as unknown as AudioProcessingEvent;

			mockProcessorCallback?.(event);

			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			const int16View = new Int16Array(chunkBuffer);
			// 2.0 clamped to 1.0 → 0x7FFF = 32767
			expect(int16View[0]).toBe(32767);
			// -2.0 clamped to -1.0 → -0x8000 = -32768
			expect(int16View[1]).toBe(-32768);
		});

		it('should not deliver chunks when paused', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();

			const event = createMockAudioProcessingEvent(128, 1);
			mockProcessorCallback?.(event);

			expect(onChunkMock).not.toHaveBeenCalled();
		});

		it('should resume delivering chunks after resume', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();
			recorder.resume();

			const event = createMockAudioProcessingEvent(128, 1);
			mockProcessorCallback?.(event);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('stop', () => {
		it('should close AudioContext and disconnect nodes', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockAudioContext.close).toHaveBeenCalled();
		});

		it('should nullify onaudioprocess callback', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockProcessorCallback).toBeNull();
		});

		it('should handle stop when not started', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			// Should not throw
			await expect(recorder.stop()).resolves.toBeUndefined();
		});
	});
});
