/**
 * Unit tests for the encoding worker handler. The onmessage glue is a
 * thin wrapper; the handler is tested directly with mocked mediabunny.
 * @module tests/unit/encodingWorker.test
 */

import { handleEncodingMessage } from 'src/audio/encodingWorker';
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
	let responses: { response: WorkerResponse; transfer?: Transferable[] }[];
	const post = (
		response: WorkerResponse,
		transfer?: Transferable[],
	): void => {
		responses.push({ response, transfer });
	};

	beforeEach(() => {
		jest.clearAllMocks();
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

		const conversion = (await mockConversionInit.mock.results[0].value) as {
			onProgress?: (progress: number) => void;
		};
		conversion.onProgress?.(0.5);
		conversion.onProgress?.(0.504);

		const progress = responses.filter(
			(entry) => entry.response.kind === 'progress',
		);
		expect(progress).toHaveLength(1);
		expect(progress[0].response).toEqual({
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
				audio: expect.objectContaining({ numberOfChannels: 1 }),
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
