/**
 * Unit tests for PcmStreamRecorder module.
 * Tests real-time PCM capture from MediaStream using AudioWorkletNode.
 * @module tests/unit/PcmStreamRecorder.test
 */

import {
	PcmStreamRecorder,
	WORKLET_PROCESSOR_SOURCE,
} from 'src/recording/PcmStreamRecorder';
import { defined } from '../helpers/assertions';

// Track messages sent to the worklet port
let workletPortMessages: Array<{ type: string }> = [];
let mainPortOnMessage: ((event: MessageEvent) => void) | null = null;

const mockWorkletPort = {
	postMessage: jest.fn().mockImplementation((msg: { type: string }) => {
		workletPortMessages.push(msg);
		// Simulate worklet responding to flush with a 'flushed' sentinel
		if (msg.type === 'flush' && mainPortOnMessage) {
			queueMicrotask(() => {
				if (mainPortOnMessage) {
					mainPortOnMessage(
						new MessageEvent('message', {
							data: { type: 'flushed' },
						}),
					);
				}
			});
		}
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
					processorOptions: { channelMode: 'source' },
				},
			);
			expect(mockAudioContext.createGain).toHaveBeenCalled();
			expect(mockGainNode.gain.value).toBe(0);
		});

		it('should prefer the negotiated track channel count over the source node default', async () => {
			// MediaStreamAudioSourceNode.channelCount commonly stays at
			// its default of 2 even though the track actually delivers mono.
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(1);
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(recorder.channels).toBe(1);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global constructor
			expect((global as any).AudioWorkletNode).toHaveBeenCalledWith(
				mockAudioContext,
				'pcm-capture-processor',
				expect.objectContaining({ channelCount: 1 }),
			);
		});

		it('should pass the mono channel mode to the worklet and keep the full input width', async () => {
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(2);
			const recorder = new PcmStreamRecorder(
				stream,
				44100,
				onChunkMock,
				'mono-mix',
			);

			await recorder.start();

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock global constructor
			expect((global as any).AudioWorkletNode).toHaveBeenCalledWith(
				mockAudioContext,
				'pcm-capture-processor',
				{
					numberOfInputs: 1,
					numberOfOutputs: 1,
					// All source channels still reach the worklet; the
					// downmix happens inside it
					channelCount: 2,
					processorOptions: { channelMode: 'mono-mix' },
				},
			);
		});

		it.each(['mono-mix', 'mono-left', 'mono-right'] as const)(
			'should report one channel for the %s mode on a stereo source',
			async (mode) => {
				mockSourceNode.channelCount = 2;
				const stream = createMockStream(2);
				const recorder = new PcmStreamRecorder(
					stream,
					44100,
					onChunkMock,
					mode,
				);

				await recorder.start();

				expect(recorder.channels).toBe(1);
			},
		);

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

		it('should release resources when worklet registration fails', async () => {
			mockAudioContext.audioWorklet.addModule.mockRejectedValueOnce(
				new Error('addModule failed'),
			);
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await expect(recorder.start()).rejects.toThrow('addModule failed');

			expect(mockAudioContext.close).toHaveBeenCalled();
			expect(URL.revokeObjectURL).toHaveBeenCalledWith(
				'blob:mock-worklet-url',
			);
		});

		it('should release resources when the audio graph setup fails', async () => {
			mockAudioContext.createMediaStreamSource.mockImplementationOnce(
				() => {
					throw new Error('source failed');
				},
			);
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await expect(recorder.start()).rejects.toThrow('source failed');

			expect(mockAudioContext.close).toHaveBeenCalled();
			expect(URL.revokeObjectURL).toHaveBeenCalledWith(
				'blob:mock-worklet-url',
			);
		});

		it('should not mask the original error when cleanup itself fails', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
			mockAudioContext.audioWorklet.addModule.mockRejectedValueOnce(
				new Error('addModule failed'),
			);
			mockAudioContext.close.mockRejectedValueOnce(
				new Error('close failed'),
			);
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await expect(recorder.start()).rejects.toThrow('addModule failed');

			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
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
		it('should flush worklet before disconnecting', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'flush',
			});
		});

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

		it('should deliver flushed PCM data via onChunk before stop completes', async () => {
			// Override postMessage to simulate flush with a trailing data chunk
			mockWorkletPort.postMessage.mockImplementation(
				(msg: { type: string }) => {
					workletPortMessages.push(msg);
					if (msg.type === 'flush' && mainPortOnMessage) {
						queueMicrotask(() => {
							if (mainPortOnMessage) {
								// Worklet sends remaining buffered data before sentinel
								const trailing = new Int16Array(64);
								mainPortOnMessage(
									new MessageEvent('message', {
										data: trailing.buffer,
									}),
								);
								mainPortOnMessage(
									new MessageEvent('message', {
										data: { type: 'flushed' },
									}),
								);
							}
						});
					}
				},
			);

			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			expect(
				(onChunkMock.mock.calls[0][0] as ArrayBuffer).byteLength,
			).toBe(128);
		});
	});

	describe('message filtering', () => {
		it('should ignore non-ArrayBuffer messages from worklet', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			// Send a non-ArrayBuffer message (e.g. status object)
			if (mainPortOnMessage) {
				mainPortOnMessage(
					new MessageEvent('message', {
						data: { type: 'some-status' },
					}),
				);
			}

			expect(onChunkMock).not.toHaveBeenCalled();
		});
	});
});

/**
 * Runs the real inline worklet source against stub AudioWorkletProcessor
 * globals, so the capture math (interleave, downmix modes, pause, flush)
 * is tested as it ships, not through a reimplementation.
 */
describe('PcmCaptureProcessor worklet logic', () => {
	interface WorkletPort {
		onmessage: ((event: { data: { type: string } }) => void) | null;
		postMessage: (message: unknown, transfer?: unknown[]) => void;
	}

	interface WorkletProcessor {
		port: WorkletPort;
		process: (inputs: Float32Array[][]) => boolean;
	}

	function instantiate(channelMode?: string): {
		processor: WorkletProcessor;
		posted: unknown[];
	} {
		const posted: unknown[] = [];
		class FakeAudioWorkletProcessor {
			port: WorkletPort = {
				onmessage: null,
				postMessage: (message: unknown): void => {
					posted.push(message);
				},
			};
		}
		type ProcessorCtor = new (options?: unknown) => WorkletProcessor;
		// Held on an object rather than in a `let`: the worklet source assigns it
		// from inside the factory call, and a bare local would still read as
		// `null` afterwards because that assignment is invisible to the compiler.
		const captured: { ctor: ProcessorCtor | null } = { ctor: null };
		const registerProcessor = (
			_name: string,
			ctor: ProcessorCtor,
		): void => {
			captured.ctor = ctor;
		};

		const factory = new Function(
			'AudioWorkletProcessor',
			'registerProcessor',
			WORKLET_PROCESSOR_SOURCE,
		);
		factory(FakeAudioWorkletProcessor, registerProcessor);
		const Registered = defined(
			captured.ctor,
			'processor registered by the worklet source',
		);
		const processor = new Registered(
			channelMode ? { processorOptions: { channelMode } } : undefined,
		);
		return { processor, posted };
	}

	/** Feeds one render quantum and flushes, returning the posted PCM. */
	function captureOnce(
		channelMode: string | undefined,
		input: Float32Array[],
	): Int16Array {
		const { processor, posted } = instantiate(channelMode);
		expect(processor.process([input])).toBe(true);
		processor.port.onmessage?.({ data: { type: 'flush' } });
		const chunk = posted.find((message) => message instanceof ArrayBuffer);
		expect(chunk).toBeDefined();
		expect(posted).toContainEqual({ type: 'flushed' });
		return new Int16Array(chunk ?? new ArrayBuffer(0));
	}

	const left = Float32Array.from([0.5, 0.5]);
	const right = Float32Array.from([-0.5, 0.0]);

	it('interleaves all channels in the source mode', () => {
		const pcm = captureOnce('source', [left, right]);

		expect(Array.from(pcm)).toEqual([16383, -16384, 16383, 0]);
	});

	it('defaults to the source mode when no options are provided', () => {
		const pcm = captureOnce(undefined, [left, right]);

		expect(Array.from(pcm)).toEqual([16383, -16384, 16383, 0]);
	});

	it('averages every channel in the mono-mix mode', () => {
		const pcm = captureOnce('mono-mix', [left, right]);

		// (0.5 + -0.5)/2 = 0 and (0.5 + 0)/2 = 0.25
		expect(Array.from(pcm)).toEqual([0, 8191]);
	});

	it('keeps only the left channel in the mono-left mode', () => {
		const pcm = captureOnce('mono-left', [left, right]);

		expect(Array.from(pcm)).toEqual([16383, 16383]);
	});

	it('keeps only the right channel in the mono-right mode', () => {
		const pcm = captureOnce('mono-right', [left, right]);

		expect(Array.from(pcm)).toEqual([-16384, 0]);
	});

	it('falls back to the only channel for mono-right on mono input', () => {
		const pcm = captureOnce('mono-right', [left]);

		expect(Array.from(pcm)).toEqual([16383, 16383]);
	});

	it('averages more than two channels in the mono-mix mode', () => {
		const third = Float32Array.from([0.25, 0.25]);
		const pcm = captureOnce('mono-mix', [left, right, third]);

		// (0.5 - 0.5 + 0.25)/3 = 0.0833..., (0.5 + 0 + 0.25)/3 = 0.25
		expect(Array.from(pcm)).toEqual([2730, 8191]);
	});

	it('discards input while paused and resumes cleanly', () => {
		const { processor, posted } = instantiate('mono-mix');
		processor.port.onmessage?.({ data: { type: 'pause' } });
		processor.process([[left]]);
		processor.port.onmessage?.({ data: { type: 'resume' } });
		processor.process([[left]]);
		processor.port.onmessage?.({ data: { type: 'flush' } });

		const chunk = posted.find(
			(message) => message instanceof ArrayBuffer,
		) as ArrayBuffer;
		// Only the post-resume quantum (2 samples) was captured
		expect(new Int16Array(chunk)).toHaveLength(2);
	});

	it('clamps out-of-range samples to the int16 rails', () => {
		const loud = Float32Array.from([1.5, -1.5]);
		const pcm = captureOnce('mono-left', [loud]);

		expect(Array.from(pcm)).toEqual([32767, -32768]);
	});
});
