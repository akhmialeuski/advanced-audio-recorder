/**
 * Unit tests for PcmStreamRecorder module.
 * Tests real-time PCM capture from MediaStream using AudioWorkletNode.
 * @module tests/unit/PcmStreamRecorder.test
 */

import {
	PcmStreamRecorder,
	WORKLET_PROCESSOR_SOURCE,
} from 'src/recording/PcmStreamRecorder';
import { decodePcmSamples, PcmSampleFormat } from 'src/audio/pcm';
import { defined } from '../helpers/assertions';
import { partial } from '../helpers/doubles';

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
	return partial<MediaStream>({
		getAudioTracks: () => [
			{
				stop: jest.fn(),
				getSettings: () => ({ channelCount }),
			},
		],
		getTracks: () => [{ stop: jest.fn() }],
	});
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
		it('creates AudioContext with requested sample rate', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 48000, onChunkMock);

			await recorder.start();

			expect(global.AudioContext).toHaveBeenCalledWith({
				sampleRate: 48000,
			});
		});

		it('registers worklet processor via Blob URL', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
			expect(
				mockAudioContext.audioWorklet.addModule,
			).toHaveBeenCalledWith('blob:mock-worklet-url');
		});

		it('creates AudioWorkletNode and connect audio graph', async () => {
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
					processorOptions: {
						channelMode: 'source',
						sampleFormat: 'int16',
					},
				},
			);
			expect(mockAudioContext.createGain).toHaveBeenCalled();
			expect(mockGainNode.gain.value).toBe(0);
		});

		it('prefers the negotiated track channel count over the source node default', async () => {
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

		it('passes the mono channel mode to the worklet and keep the full input width', async () => {
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
					processorOptions: {
						channelMode: 'mono-mix',
						sampleFormat: 'int16',
					},
				},
			);
		});

		it.each(['mono-mix', 'mono-left', 'mono-right'] as const)(
			'reports one channel for the %s mode on a stereo source',
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

		it('exposes actual channels and sampleRate from AudioContext', async () => {
			mockSourceNode.channelCount = 2;
			const stream = createMockStream(2);
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			expect(recorder.channels).toBe(2);
			expect(recorder.sampleRate).toBe(44100);
		});

		it('routes a worklet message to the chunk callback', async () => {
			// A handler that is merely attached proves nothing: what matters
			// is that a buffer arriving on the port reaches the consumer that
			// writes it to disk.
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);
			await recorder.start();
			const samples = new Int16Array([1, -1, 2]);

			defined(mainPortOnMessage)({
				data: samples.buffer,
			} as MessageEvent);

			expect(onChunkMock).toHaveBeenCalledWith(samples.buffer);
		});

		it('releases resources when worklet registration fails', async () => {
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

		it('releases resources when the audio graph setup fails', async () => {
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

		it('does not mask the original error when cleanup itself fails', async () => {
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
		});
	});

	describe('worklet message handling', () => {
		it('delivers PCM data via onChunk when worklet posts message', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();

			simulateWorkletChunk(128, 1);

			expect(onChunkMock).toHaveBeenCalledTimes(1);
			const chunkBuffer = onChunkMock.mock.calls[0][0] as ArrayBuffer;
			// 128 samples * 1 channel * 2 bytes per int16 = 256 bytes
			expect(chunkBuffer.byteLength).toBe(256);
		});

		it('delivers stereo PCM data correctly', async () => {
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
		it('sends pause message to worklet port', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'pause',
			});
		});

		it('sends resume message to worklet port', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			recorder.pause();
			recorder.resume();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'resume',
			});
		});

		it('does not throw when pausing before start', () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			expect(() => recorder.pause()).not.toThrow();
			expect(() => recorder.resume()).not.toThrow();
		});
	});

	describe('stop', () => {
		it('flushes worklet before disconnecting', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockWorkletPort.postMessage).toHaveBeenCalledWith({
				type: 'flush',
			});
		});

		it('closes AudioContext and disconnect nodes', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mockAudioContext.close).toHaveBeenCalled();
			expect(mockWorkletNode.disconnect).toHaveBeenCalled();
			expect(mockSourceNode.disconnect).toHaveBeenCalled();
			expect(mockGainNode.disconnect).toHaveBeenCalled();
		});

		it('nullifies port.onmessage', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(mainPortOnMessage).toBeNull();
		});

		it('revokes the Blob URL', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await recorder.start();
			await recorder.stop();

			expect(URL.revokeObjectURL).toHaveBeenCalledWith(
				'blob:mock-worklet-url',
			);
		});

		it('handles stop when not started', async () => {
			const stream = createMockStream();
			const recorder = new PcmStreamRecorder(stream, 44100, onChunkMock);

			await expect(recorder.stop()).resolves.toBeUndefined();
		});

		it('delivers flushed PCM data via onChunk before stop completes', async () => {
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
		it('ignores non-ArrayBuffer messages from worklet', async () => {
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

	function instantiate(
		channelMode?: string,
		sampleFormat?: string,
	): {
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
			channelMode || sampleFormat
				? { processorOptions: { channelMode, sampleFormat } }
				: undefined,
		);
		return { processor, posted };
	}

	/** Feeds one render quantum and flushes, returning the posted PCM. */
	function captureBytes(
		channelMode: string | undefined,
		input: Float32Array[],
		sampleFormat?: string,
	): ArrayBuffer {
		const { processor, posted } = instantiate(channelMode, sampleFormat);
		expect(processor.process([input])).toBe(true);
		processor.port.onmessage?.({ data: { type: 'flush' } });
		const chunk = posted.find((message) => message instanceof ArrayBuffer);
		expect(chunk).toBeDefined();
		expect(posted).toContainEqual({ type: 'flushed' });
		return chunk ?? new ArrayBuffer(0);
	}

	/** The samples one capture wrote, read back in its own representation. */
	function captureOnce(
		channelMode: string | undefined,
		input: Float32Array[],
		sampleFormat: PcmSampleFormat = PcmSampleFormat.Int16,
	): number[] {
		const bytes = captureBytes(channelMode, input, sampleFormat);
		return Array.from(decodePcmSamples(bytes, sampleFormat));
	}

	const left = Float32Array.from([0.5, 0.5]);
	const right = Float32Array.from([-0.5, 0.0]);

	const third = Float32Array.from([0.25, 0.25]);

	it.each([
		{
			name: 'the source mode interleaves every channel',
			mode: 'source',
			input: [left, right],
			expected: [16383, -16384, 16383, 0],
		},
		{
			name: 'no mode at all behaves as the source mode',
			mode: undefined,
			input: [left, right],
			expected: [16383, -16384, 16383, 0],
		},
		{
			// (0.5 + -0.5)/2 = 0 and (0.5 + 0)/2 = 0.25
			name: 'the mono-mix mode averages both channels',
			mode: 'mono-mix',
			input: [left, right],
			expected: [0, 8191],
		},
		{
			// (0.5 - 0.5 + 0.25)/3 = 0.0833..., (0.5 + 0 + 0.25)/3 = 0.25
			name: 'the mono-mix mode averages more than two channels',
			mode: 'mono-mix',
			input: [left, right, third],
			expected: [2730, 8191],
		},
		{
			name: 'the mono-left mode keeps only the left channel',
			mode: 'mono-left',
			input: [left, right],
			expected: [16383, 16383],
		},
		{
			name: 'the mono-right mode keeps only the right channel',
			mode: 'mono-right',
			input: [left, right],
			expected: [-16384, 0],
		},
		{
			name: 'mono-right falls back to the only channel of mono input',
			mode: 'mono-right',
			input: [left],
			expected: [16383, 16383],
		},
		{
			name: 'mono-left falls back to the only channel of mono input',
			mode: 'mono-left',
			input: [left],
			expected: [16383, 16383],
		},
		{
			// Anything that is not the source mode downmixes to one channel,
			// and an unrecognised mode is none of the named mono modes, so it
			// lands on the first channel. Better a mono file than an
			// interleaved one the container was not told about.
			name: 'an unrecognised mode downmixes to the first channel',
			mode: 'nonsense',
			input: [left, right],
			expected: [16383, 16383],
		},
	])('$name', ({ mode, input, expected }) => {
		expect(captureOnce(mode, input)).toEqual(expected);
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

		expect(captureOnce('mono-left', [loud])).toEqual([32767, -32768]);
	});

	// The representation is applied once, after the channel modes have
	// reduced the input, so a wider sample is available in every layout
	// rather than only in the pass-through one.
	describe('the representation the capture writes in', () => {
		const half = Float32Array.from([0.5, -0.5]);

		it.each([
			[PcmSampleFormat.Int16, 2, [16383, -16384]],
			[PcmSampleFormat.Int24, 3, [4194303, -4194304]],
			[PcmSampleFormat.Float32, 4, [0.5, -0.5]],
		])('writes %s samples of %s bytes', (format, width, expected) => {
			const bytes = captureBytes('mono-left', [half], format);

			expect(bytes.byteLength).toBe(2 * width);
			expect(Array.from(decodePcmSamples(bytes, format))).toEqual(
				expected,
			);
		});

		it('interleaves a stereo capture in the chosen representation', () => {
			const right = Float32Array.from([0.25, 0]);

			expect(
				captureOnce('source', [half, right], PcmSampleFormat.Int24),
			).toEqual([4194303, 2097151, -4194304, 0]);
		});

		it('downmixes to mono before applying the representation', () => {
			const right = Float32Array.from([-0.5, 0.5]);

			expect(
				captureOnce('mono-mix', [half, right], PcmSampleFormat.Float32),
			).toEqual([0, 0]);
		});

		// The reason the floating point representation is offered at all: a
		// take recorded too hot stays recoverable instead of being flattened
		// into the rails.
		it('keeps a floating point sample that ran past full scale', () => {
			const loud = Float32Array.from([1.5, -2.25]);

			expect(
				captureOnce('mono-left', [loud], PcmSampleFormat.Float32),
			).toEqual([1.5, -2.25]);
		});

		// The buffer holds a whole number of the 128-frame quanta the spec
		// defines today, and a build that rendered another size used to run a
		// sample off the end of it - silently dropped by a typed array
		// before, and a throw on the audio thread once a DataView writes it.
		it('keeps every sample of a quantum that does not divide the buffer', () => {
			const { processor, posted } = instantiate(
				'mono-left',
				PcmSampleFormat.Int16,
			);
			const quantum = Float32Array.from({ length: 100 }, () => 0.25);

			for (let index = 0; index < 82; index++) {
				processor.process([[quantum]]);
			}
			processor.port.onmessage?.({ data: { type: 'flush' } });

			const written = posted
				.filter(
					(message): message is ArrayBuffer =>
						message instanceof ArrayBuffer,
				)
				.reduce((total, chunk) => total + chunk.byteLength, 0);
			expect(written).toBe(82 * 100 * 2);
		});

		it('falls back to sixteen bits for a representation it does not know', () => {
			const bytes = captureBytes('mono-left', [half], 'int32');

			expect(bytes.byteLength).toBe(4);
			expect(
				Array.from(decodePcmSamples(bytes, PcmSampleFormat.Int16)),
			).toEqual([16383, -16384]);
		});
	});
});
