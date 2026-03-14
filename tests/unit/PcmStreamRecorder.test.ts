/**
 * Unit tests for PcmStreamRecorder module.
 * Tests real-time PCM capture from MediaStream using AudioWorkletNode.
 * @module tests/unit/PcmStreamRecorder.test
 */
/** @jest-environment jsdom */

import { PcmStreamRecorder } from '../../src/recording/PcmStreamRecorder';

// Track messages sent to the worklet port
let workletPortMessages: Array<{ type: string }> = [];
let mainPortOnMessage: ((event: MessageEvent) => void) | null = null;

const mockWorkletPort = {
	postMessage: jest.fn().mockImplementation((msg: { type: string }) => {
		workletPortMessages.push(msg);
	}),
	get onmessage(): ((event: MessageEvent) => void) | null {
		return mainPortOnMessage;
	},
	set onmessage(handler: ((event: MessageEvent) => void) | null) {
		mainPortOnMessage = handler;
	},
};

const mockWorkletNode = {
	port: mockWorkletPort,
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
	audioWorklet: {
		addModule: jest.fn().mockResolvedValue(undefined),
	},
	createMediaStreamSource: jest.fn().mockReturnValue(mockSourceNode),
	createGain: jest.fn().mockReturnValue(mockGainNode),
	close: jest.fn().mockResolvedValue(undefined),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global AudioContext
(global as any).AudioContext = jest
	.fn()
	.mockImplementation(() => mockAudioContext);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global AudioWorkletNode
(global as any).AudioWorkletNode = jest
	.fn()
	.mockImplementation(() => mockWorkletNode);

// Mock URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = jest.fn().mockReturnValue('blob:mock-worklet-url');
global.URL.revokeObjectURL = jest.fn();

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

/**
 * Simulates the worklet posting a PCM chunk back to the main thread.
 */
function simulateWorkletChunk(numSamples: number, numChannels: number): void {
	const int16Data = new Int16Array(numSamples * numChannels);
	for (let i = 0; i < numSamples; i++) {
		for (let ch = 0; ch < numChannels; ch++) {
			const sample = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
			const clamped = Math.max(-1, Math.min(1, sample));
			int16Data[i * numChannels + ch] =
				clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		}
	}

	if (mainPortOnMessage) {
		mainPortOnMessage(
			new MessageEvent('message', { data: int16Data.buffer }),
		);
	}
}

describe('PcmStreamRecorder', () => {
	let onChunkMock: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		mainPortOnMessage = null;
		workletPortMessages = [];
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

		it('should register worklet processor via Blob URL', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
			expect(
				mockAudioContext.audioWorklet.addModule,
			).toHaveBeenCalledWith('blob:mock-worklet-url');
		});

		it('should create AudioWorkletNode and connect audio graph', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(
				mockAudioContext.createMediaStreamSource,
			).toHaveBeenCalledWith(stream);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global constructor
			expect((global as any).AudioWorkletNode).toHaveBeenCalledWith(
				mockAudioContext,
				'pcm-capture-processor',
				{
					numberOfInputs: 1,
					numberOfOutputs: 1,
					channelCount: 1,
				},
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

		it('should set up port.onmessage handler', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(mainPortOnMessage).not.toBeNull();
		});
	});

	describe('worklet message handling', () => {
		it('should deliver PCM data via onChunk when worklet posts message', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			simulateWorkletChunk(128, 1);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			// 128 samples * 1 channel * 2 bytes per int16 = 256 bytes
			expect(chunkBuffer.byteLength).toBe(256);
		});

		it('should deliver stereo PCM data correctly', async () => {
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(2);
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			simulateWorkletChunk(64, 2);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			// 64 samples * 2 channels * 2 bytes = 256 bytes
			expect(chunkBuffer.byteLength).toBe(256);
		});
	});

	describe('pause / resume', () => {
		it('should send pause message to worklet port', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'pause',
			});
		});

		it('should send resume message to worklet port', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();
			recorder.resume();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'resume',
			});
		});

		it('should not throw when pausing before start', () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			expect(() => recorder.pause()).not.toThrow();
			expect(() => recorder.resume()).not.toThrow();
		});
	});

	describe('stop', () => {
		it('should close AudioContext and disconnect nodes', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockAudioContext.close).toHaveBeenCalled();
			expect(mockWorkletNode.disconnect).toHaveBeenCalled();
			expect(mockSourceNode.disconnect).toHaveBeenCalled();
			expect(mockGainNode.disconnect).toHaveBeenCalled();
		});

		it('should nullify port.onmessage', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mainPortOnMessage).toBeNull();
		});

		it('should revoke the Blob URL', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(URL.revokeObjectURL).toHaveBeenCalledWith(
				'blob:mock-worklet-url',
			);
		});

		it('should handle stop when not started', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await expect(recorder.stop()).resolves.toBeUndefined();
		});
	});
});
