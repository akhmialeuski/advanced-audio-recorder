/**
 * Unit tests for EncodingWorkerClient module.
 * @module tests/unit/EncodingWorkerClient.test
 */

import { EncodingWorkerClient } from 'src/audio/EncodingWorkerClient';
import { ENCODING_WORKER_MIN_TIMEOUT_MS } from 'src/constants';
import { at } from '../helpers/assertions';
import type { WorkerResponse } from 'src/audio/encodingWorker';

/** Captured worker doubles created by the client. */
interface WorkerDouble {
	postMessage: jest.Mock;
	terminate: jest.Mock;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}
const createdWorkers: WorkerDouble[] = [];

/**
 * Starts a conversion that reports progress, which two suites drive: one
 * checks that the reports reach the caller, the other that they keep the
 * watchdog from firing.
 * @param client - The client to convert through
 * @returns The conversion, the worker it went to, and the progress spy
 */
function convertWatchingProgress(client: EncodingWorkerClient): {
	conversion: Promise<Blob>;
	worker: WorkerDouble;
	onProgress: jest.Mock;
} {
	const onProgress = jest.fn();
	const conversion = client.convertBlob(
		new Blob(['audio']),
		'mp3',
		128000,
		false,
		'source',
		onProgress,
	);
	return { conversion, worker: at(createdWorkers, 0), onProgress };
}

class MockWorker implements WorkerDouble {
	postMessage = jest.fn();
	terminate = jest.fn();
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;

	constructor(public readonly url: string) {
		createdWorkers.push(this);
	}
}

// Shared by both suites below: the client builds its worker from a Blob URL,
// so both the constructor and the URL functions have to exist before anything
// asks for one.
beforeEach(() => {
	createdWorkers.length = 0;
	jest.spyOn(console, 'warn').mockImplementation();
	(global as Record<string, unknown>).Worker = MockWorker;
	global.URL.createObjectURL = jest.fn().mockReturnValue('blob:worker-url');
	global.URL.revokeObjectURL = jest.fn();
});

describe('EncodingWorkerClient', () => {
	const respond = (worker: WorkerDouble, response: WorkerResponse): void => {
		worker.onmessage?.(new MessageEvent('message', { data: response }));
	};

	it('is unavailable without bundled worker source', async () => {
		const client = new EncodingWorkerClient(null);

		expect(client.isAvailable()).toBe(false);
		await expect(
			client.convertBlob(new Blob(['a']), 'mp3', 128000, false),
		).rejects.toThrow('not available');
	});

	it('posts the request and resolve with the result blob', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			true,
		);

		expect(createdWorkers).toHaveLength(1);
		const worker = at(createdWorkers, 0);
		expect(worker.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'convertBlob',
				targetFormat: 'mp3',
				bitrate: 128000,
				allowRemux: true,
				// The channel mode defaults to the source pass-through
				channelMode: 'source',
			}),
		);

		const requestId = (
			at(worker.postMessage.mock.calls, 0)[0] as { id: number }
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

	it('includes the requested channel mode in the worker request', () => {
		const client = new EncodingWorkerClient('worker-source');
		void client
			.convertBlob(new Blob(['audio']), 'mp3', 128000, false, 'mono-mix')
			.catch(() => {
				// The request is never answered in this test
			});

		const worker = at(createdWorkers, 0);
		expect(worker.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channelMode: 'mono-mix' }),
		);
	});

	it('forwards progress updates', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const { conversion, worker, onProgress } =
			convertWatchingProgress(client);
		const requestId = (
			at(worker.postMessage.mock.calls, 0)[0] as { id: number }
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

	it('rejects the matching request on a conversion error', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = at(createdWorkers, 0);
		const requestId = (
			at(worker.postMessage.mock.calls, 0)[0] as { id: number }
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

	it('degrades permanently on a worker-level error', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = at(createdWorkers, 0);

		worker.onerror?.({ message: 'worker crashed' } as ErrorEvent);

		await expect(conversion).rejects.toThrow('terminated');
		expect(client.isAvailable()).toBe(false);
		expect(worker.terminate).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:worker-url');
	});

	it('degrades permanently when the worker cannot start', async () => {
		(global as Record<string, unknown>).Worker = function (): never {
			throw new Error('CSP blocked');
		};
		const client = new EncodingWorkerClient('worker-source');

		await expect(
			client.convertBlob(new Blob(['a']), 'mp3', 128000, false),
		).rejects.toThrow('not available');
		expect(client.isAvailable()).toBe(false);
	});

	it('terminates the worker and reject in-flight requests', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		const worker = at(createdWorkers, 0);

		client.terminate();

		await expect(conversion).rejects.toThrow('terminated');
		expect(worker.terminate).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:worker-url');
	});
});

// The one asynchronous boundary of the plugin that had no watchdog, and the
// one that handles the largest payloads. A worker wedged inside its demux loop
// answers neither a result nor an error, so the promise never settled, the save
// sat at "encoding" with its cancel button disabled, and the only way out was
// restarting Obsidian. The main-thread fallback the caller wraps this in was
// unreachable dead code, because a hang raises nothing to fall back from.
describe('a worker that stops answering', () => {
	/** Comfortably past any budget these small payloads work out to. */
	const PAST_THE_BUDGET = ENCODING_WORKER_MIN_TIMEOUT_MS * 2;

	/** Builds a worker double and the conversion waiting on it. */
	function convertThrough(client: EncodingWorkerClient): {
		worker: WorkerDouble;
		conversion: Promise<Blob>;
	} {
		const conversion = client.convertBlob(
			new Blob(['audio']),
			'mp3',
			128000,
			false,
		);
		return { worker: at(createdWorkers, 0), conversion };
	}

	/** The id the worker was asked to answer under. */
	function requestId(worker: WorkerDouble, call = 0): number {
		return (at(worker.postMessage.mock.calls, call)[0] as { id: number })
			.id;
	}

	/** Delivers one worker response. */
	function answer(worker: WorkerDouble, response: WorkerResponse): void {
		worker.onmessage?.(new MessageEvent('message', { data: response }));
	}

	/** A result response for the given request. */
	function resultFor(id: number): WorkerResponse {
		return {
			id,
			kind: 'result',
			buffer: new Uint8Array([1]).buffer,
			mimeType: 'audio/mp3',
		};
	}

	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/**
	 * Sends one conversion into a worker that never answers and waits out its
	 * budget, asserting the rejection along the way.
	 *
	 * The expectation is attached before the clock moves, because the
	 * rejection lands inside the advance and a handler added afterwards
	 * arrives too late.
	 * @returns The client and the worker double, after the timeout has fired
	 */
	async function waitOutTheBudget(): Promise<{
		client: EncodingWorkerClient;
		worker: WorkerDouble;
	}> {
		const client = new EncodingWorkerClient('worker-source');
		const { worker, conversion } = convertThrough(client);
		const rejected = expect(conversion).rejects.toThrow('did not answer');

		await jest.advanceTimersByTimeAsync(PAST_THE_BUDGET);
		await rejected;

		return { client, worker };
	}

	it('rejects the request once the worker has gone quiet for its budget', async () => {
		// The rejection itself is the assertion, made inside the helper.
		await expect(waitOutTheBudget()).resolves.toBeDefined();
	});

	it('leaves nothing waiting behind a timed-out request', async () => {
		const { worker } = await waitOutTheBudget();

		// A late answer to a request nobody waits on must find nothing to
		// resolve, or the entry is a leak that also settles a second time.
		expect(() => {
			answer(worker, resultFor(requestId(worker)));
		}).not.toThrow();
	});

	// A wedged worker stays wedged, so every later conversion would pay the
	// whole budget before falling back. The caller checks availability first,
	// so marking it unavailable sends them straight to the main thread.
	it('stops offering the worker after one has hung', async () => {
		const { client } = await waitOutTheBudget();

		expect(client.isAvailable()).toBe(false);
	});

	it('refuses a conversion once the worker has been given up on', async () => {
		const { client } = await waitOutTheBudget();

		await expect(
			client.convertBlob(new Blob(['a']), 'mp3', 128000, false),
		).rejects.toThrow('not available');
	});

	// A long conversion that is making progress is healthy, and cutting it off
	// at a fixed deadline would abandon work that was going to finish.
	it('gives a worker reporting progress its budget again', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const { conversion, worker, onProgress } =
			convertWatchingProgress(client);
		const id = requestId(worker);

		for (let round = 0; round < 3; round++) {
			await jest.advanceTimersByTimeAsync(
				ENCODING_WORKER_MIN_TIMEOUT_MS - 1,
			);
			answer(worker, { id, kind: 'progress', percent: round * 30 });
		}
		answer(worker, resultFor(id));

		await expect(conversion).resolves.toBeInstanceOf(Blob);
		expect(onProgress).toHaveBeenCalledTimes(3);
	});

	// Multi-track finalization converts the tracks side by side through one
	// worker. Terminating it on one timeout would take the healthy siblings.
	it('leaves a second conversion of the same worker alone', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const { worker, conversion: first } = convertThrough(client);
		const rejected = expect(first).rejects.toThrow('did not answer');
		const second = client.convertBlob(
			new Blob(['b']),
			'mp3',
			128000,
			false,
		);

		await jest.advanceTimersByTimeAsync(
			ENCODING_WORKER_MIN_TIMEOUT_MS / 2,
		);
		answer(worker, resultFor(requestId(worker, 1)));
		await expect(second).resolves.toBeInstanceOf(Blob);

		await jest.advanceTimersByTimeAsync(PAST_THE_BUDGET);
		await rejected;
		expect(worker.terminate).not.toHaveBeenCalled();
	});

	it('clears the watchdog when the worker answers in time', async () => {
		const client = new EncodingWorkerClient('worker-source');
		const { worker, conversion } = convertThrough(client);
		answer(worker, resultFor(requestId(worker)));
		await conversion;

		await jest.advanceTimersByTimeAsync(PAST_THE_BUDGET);

		expect(client.isAvailable()).toBe(true);
	});
});
