/**
 * Unit tests for the encoding worker handler, tested directly with mocked
 * mediabunny, plus the onmessage glue that only installs itself inside a real
 * worker - which is why it needed a module re-import to reach at all.
 * @module tests/unit/encodingWorker.test
 */

import { handleEncodingMessage } from 'src/audio/encodingWorker';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import type { WorkerRequest, WorkerResponse } from 'src/audio/encodingWorker';

const mockConversionExecute = jest.fn().mockResolvedValue(undefined);
const mockConversionInit = jest.fn();
const mockGetPrimaryAudioTrack = jest.fn();
const mockInputDispose = jest.fn();
const mockConvertedBuffer = new ArrayBuffer(64);

jest.mock('mediabunny', () => ({
	Input: jest.fn().mockImplementation(() => ({
		getPrimaryAudioTrack: (): unknown => mockGetPrimaryAudioTrack(),
		dispose: mockInputDispose,
	})),
	Output: jest.fn().mockImplementation(() => ({})),
	BlobSource: jest.fn(),
	BufferTarget: jest.fn().mockImplementation(() => ({
		buffer: mockConvertedBuffer,
	})),
	ALL_FORMATS: [],
	Conversion: {
		init: (...args: unknown[]): unknown => mockConversionInit(...args),
	},
}));

jest.mock('src/audio/AudioEncoder', () => ({
	ensureEncoderRegistered: jest.fn().mockResolvedValue(undefined),
	createOutputFormat: jest.fn().mockReturnValue({}),
	FORMAT_CODEC_MAP: {
		webm: 'opus',
		mp3: 'mp3',
		wav: 'pcm-s16',
	},
}));

const createRequest = (
	overrides: Partial<WorkerRequest> = {},
): WorkerRequest => ({
	id: 1,
	kind: 'convertBlob',
	blob: new Blob(['audio'], { type: 'audio/webm' }),
	targetFormat: 'mp3',
	bitrate: 128000,
	allowRemux: false,
	...overrides,
});

describe('handleEncodingMessage', () => {
	let responses: {
		response: WorkerResponse;
		transfer?: Transferable[] | undefined;
	}[];
	const post = (
		response: WorkerResponse,
		transfer?: Transferable[],
	): void => {
		responses.push({ response, transfer });
	};

	beforeEach(() => {
		responses = [];
		mockConversionInit.mockImplementation(() =>
			Promise.resolve({
				execute: mockConversionExecute,
				onProgress: undefined,
				isValid: true,
				discardedTracks: [],
			}),
		);
		mockGetPrimaryAudioTrack.mockResolvedValue({
			getCodec: jest.fn().mockResolvedValue('opus'),
			isAudioTrack: (): boolean => true,
			getNumberOfChannels: jest.fn().mockResolvedValue(2),
		});
	});

	it('should post the converted buffer as a transferable result', async () => {
		await handleEncodingMessage(createRequest(), post);

		const result = responses.find(
			(entry) => entry.response.kind === 'result',
		);
		expect(result).toBeDefined();
		expect(result?.response).toEqual({
			id: 1,
			kind: 'result',
			buffer: mockConvertedBuffer,
			mimeType: 'audio/mp3',
		});
		expect(result?.transfer).toEqual([mockConvertedBuffer]);
	});

	it('should forward whole-percent progress updates', async () => {
		await handleEncodingMessage(createRequest(), post);

		const conversion = (await at(mockConversionInit.mock.results, 0)
			.value) as {
			onProgress?: (progress: number) => void;
		};
		conversion.onProgress?.(0.5);
		conversion.onProgress?.(0.504);

		const progress = responses.filter(
			(entry) => entry.response.kind === 'progress',
		);
		expect(progress).toHaveLength(1);
		expect(at(progress, 0).response).toEqual({
			id: 1,
			kind: 'progress',
			percent: 50,
		});
	});

	it('should omit the bitrate for PCM targets', async () => {
		await handleEncodingMessage(
			createRequest({ targetFormat: 'wav' }),
			post,
		);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'pcm-s16' },
			}),
		);
	});

	it('should remux without a bitrate when codecs match and remux is allowed', async () => {
		await handleEncodingMessage(
			createRequest({ targetFormat: 'webm', allowRemux: true }),
			post,
		);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: { codec: 'opus' },
			}),
		);
	});

	it('should apply the requested channel mode', async () => {
		await handleEncodingMessage(
			createRequest({ channelMode: 'mono-mix' }),
			post,
		);

		expect(mockConversionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: expect.objectContaining({
					process: expect.any(Function),
					processedNumberOfChannels: 1,
				}),
			}),
		);
	});

	it('should normalize an unknown channel mode to the source layout', async () => {
		await handleEncodingMessage(
			createRequest({
				channelMode: 'bogus' as WorkerRequest['channelMode'],
			}),
			post,
		);

		const audio = (
			mockConversionInit.mock.calls[0][0] as {
				audio: Record<string, unknown>;
			}
		).audio;
		expect(audio.numberOfChannels).toBeUndefined();
		expect(audio.process).toBeUndefined();
	});

	it('should post an error for an unmapped format', async () => {
		await handleEncodingMessage(
			createRequest({ targetFormat: 'xyz' }),
			post,
		);

		expect(responses).toEqual([
			{
				response: {
					id: 1,
					kind: 'error',
					message: 'No codec mapping for format "xyz"',
				},
				transfer: undefined,
			},
		]);
	});

	it('should post an error when the audio track is discarded', async () => {
		mockConversionInit.mockImplementationOnce(() =>
			Promise.resolve({
				execute: mockConversionExecute,
				isValid: true,
				discardedTracks: [
					{ track: { isAudioTrack: (): boolean => true } },
				],
			}),
		);

		await handleEncodingMessage(createRequest(), post);

		const error = responses.find(
			(entry) => entry.response.kind === 'error',
		);
		expect(error?.response).toEqual({
			id: 1,
			kind: 'error',
			message: expect.stringContaining(
				'cannot process the input audio track',
			),
		});
	});
});

describe('the worker entry point', () => {
	/**
	 * Re-imports the module with `self` shaped like a worker global - the only
	 * condition under which it installs its message handler - and runs the
	 * body while that scope is still in place, since the handler reads
	 * `self.postMessage` when it replies, not when it is installed.
	 * @param body - Receives the installed handler and the posted messages
	 */
	async function inWorkerScope(
		body: (scope: {
			onmessage: ((event: MessageEvent) => void) | null;
			posted: unknown[];
		}) => void | Promise<void>,
	): Promise<void> {
		const posted: unknown[] = [];
		const scope = globalThis as unknown as Record<string, unknown>;
		const previous = {
			importScripts: scope.importScripts,
			postMessage: scope.postMessage,
			onmessage: scope.onmessage,
		};
		scope.importScripts = jest.fn();
		scope.postMessage = jest.fn((message: unknown) => {
			posted.push(message);
		});
		scope.onmessage = null;
		try {
			jest.isolateModules(() => {
				require('src/audio/encodingWorker');
			});
			await body({
				onmessage: scope.onmessage as
					| ((event: MessageEvent) => void)
					| null,
				posted,
			});
		} finally {
			scope.importScripts = previous.importScripts;
			scope.postMessage = previous.postMessage;
			scope.onmessage = previous.onmessage;
		}
	}

	it('installs a message handler when it is running as a worker', async () => {
		await inWorkerScope(({ onmessage }) => {
			expect(onmessage).toEqual(expect.any(Function));
		});
	});

	it('installs nothing on the main thread', () => {
		// The module is imported by the main thread too, to reach
		// handleEncodingMessage and the request types; taking over
		// window.onmessage there would break the host page.
		const scope = globalThis as unknown as Record<string, unknown>;
		scope.onmessage = null;

		jest.isolateModules(() => {
			require('src/audio/encodingWorker');
		});

		expect(scope.onmessage).toBeNull();
	});

	it('answers a message the host posted', async () => {
		await inWorkerScope(async ({ onmessage, posted }) => {
			onmessage?.({
				data: { id: 7, type: 'nonsense' },
			} as MessageEvent);
			await tick();

			// Whatever the request was, the worker replies: a host left
			// waiting on a request that silently died would hang the
			// conversion.
			expect(posted).toHaveLength(1);
			expect(posted[0]).toMatchObject({ id: 7 });
		});
	});
});
