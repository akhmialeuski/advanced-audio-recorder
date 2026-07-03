/**
 * Unit tests for EncodingWorkerClient module.
 * @module tests/unit/EncodingWorkerClient.test
 */

import { EncodingWorkerClient } from 'src/audio/EncodingWorkerClient';
import type { WorkerResponse } from 'src/audio/encodingWorker';

/** Captured worker doubles created by the client. */
interface WorkerDouble {
	postMessage: jest.Mock;
	terminate: jest.Mock;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}
const createdWorkers: WorkerDouble[] = [];

class MockWorker implements WorkerDouble {
	postMessage = jest.fn();
	terminate = jest.fn();
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;

	constructor(public readonly url: string) {
		createdWorkers.push(this);
	}
}

describe('EncodingWorkerClient', () => {
	let consoleWarnSpy: jest.SpyInstance;

	const respond = (worker: WorkerDouble, response: WorkerResponse): void => {
		worker.onmessage?.(new MessageEvent('message', { data: response }));
	};

	beforeEach(() => {
		jest.clearAllMocks();
		createdWorkers.length = 0;
		consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
		(global as Record<string, unknown>).Worker = MockWorker;
		global.URL.createObjectURL = jest
			.fn()
			.mockReturnValue('blob:worker-url');
		global.URL.revokeObjectURL = jest.fn();
	});

	afterEach(() => {
		consoleWarnSpy.mockRestore();
	});

	it('should be unavailable without bundled worker source', async () => {
		const client = new EncodingWorkerClient(null);

		expect(client.isAvailable()).toBe(false);
		await expect(
			client.convertBlob(new Blob(['a']), 'mp3', 128000, false),
		).rejects.toThrow('not available');
	});

	it('should post the request and resolve with the result blob', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			true,
		);

		expect(createdWorkers).toHaveLength(1);
		const worker = createdWorkers[0];
		expect(worker.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'convertBlob',
				targetFormat: 'mp3',
				bitrate: 128000,
				allowRemux: true,
			}),
		);

		const requestId = (
			worker.postMessage.mock.calls[0][0] as { id: number }
		).id;
		respond(worker, {
			id: requestId,
			kind: 'result',
			buffer: new Uint8Array([1, 2, 3]).buffer,
			mimeType: 'audio/mp3',
		});

		const blob = await conversion;
		expect(blob.type).toBe('audio/mp3');
		expect(blob.size).toBe(3);
	});

	it('should forward progress updates', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const onProgress = jest.fn();
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
			onProgress,
		);
		const worker = createdWorkers[0];
		const requestId = (
			worker.postMessage.mock.calls[0][0] as { id: number }
		).id;

		respond(worker, { id: requestId, kind: 'progress', percent: 42 });
		expect(onProgress).toHaveBeenCalledWith(42);

		respond(worker, {
			id: requestId,
			kind: 'result',
			buffer: new ArrayBuffer(1),
			mimeType: 'audio/mp3',
		});
		await conversion;
	});

	it('should reject the matching request on a conversion error', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = createdWorkers[0];
		const requestId = (
			worker.postMessage.mock.calls[0][0] as { id: number }
		).id;

		respond(worker, {
			id: requestId,
			kind: 'error',
			message: 'no audio track',
		});

		await expect(conversion).rejects.toThrow('no audio track');
		// A conversion-level error does not kill the worker
		expect(client.isAvailable()).toBe(true);
	});

	it('should degrade permanently on a worker-level error', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = createdWorkers[0];

		worker.onerror?.({ message: 'worker crashed' } as ErrorEvent);

		await expect(conversion).rejects.toThrow('terminated');
		expect(client.isAvailable()).toBe(false);
		expect(worker.terminate).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:worker-url');
	});

	it('should degrade permanently when the worker cannot start', async () => {
		(global as Record<string, unknown>).Worker = function (): never {
			throw new Error('CSP blocked');
		};
		const client = new EncodingWorkerClient('worker-source');

		await expect(
			client.convertBlob(new Blob(['a']), 'mp3', 128000, false),
		).rejects.toThrow('not available');
		expect(client.isAvailable()).toBe(false);
	});

	it('should terminate the worker and reject in-flight requests', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = createdWorkers[0];

		client.terminate();

		await expect(conversion).rejects.toThrow('terminated');
		expect(worker.terminate).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:worker-url');
	});
});
