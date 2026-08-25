/**
 * Main-thread client for the encoding Web Worker. Starts the worker
 * from inlined source via a Blob URL (the technique the PCM recorder
 * uses for its AudioWorklet), correlates requests with responses, and
 * degrades permanently to the main-thread pipeline when the worker
 * cannot run - conversion never depends on worker availability.
 * @module audio/EncodingWorkerClient
 */

import {
	ENCODING_WORKER_BYTES_PER_MS,
	ENCODING_WORKER_MAX_TIMEOUT_MS,
	ENCODING_WORKER_MIN_TIMEOUT_MS,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import { scaledTimeoutMs } from '../utils/TimeUtils';
import { CHANNEL_MODE_SOURCE, type ChannelMode } from './downmix';
import type { WorkerRequest, WorkerResponse } from './encodingWorker';

/** Pending request bookkeeping. */
interface PendingRequest {
	resolve: (blob: Blob) => void;
	reject: (error: Error) => void;
	onProgress?: ((percent: number) => void) | undefined;
	/** Watchdog for a worker that stops answering; re-armed by progress. */
	timer: number;
	/** How long this request may go unanswered, for each re-arming. */
	readonly timeoutMs: number;
}

/**
 * Client for the encoding worker with graceful main-thread fallback.
 */
export class EncodingWorkerClient {
	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private nextRequestId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	/** Set after a startup or runtime failure: fall back permanently. */
	private unavailable = false;

	/**
	 * Creates a new EncodingWorkerClient.
	 * @param workerSource - Bundled worker source text, or null when
	 * the build did not inject it (the client is then a no-op)
	 */
	constructor(private readonly workerSource: string | null) {}

	/**
	 * Whether the worker can (still) be used.
	 */
	isAvailable(): boolean {
		return (
			!this.unavailable &&
			this.workerSource !== null &&
			typeof Worker !== 'undefined'
		);
	}

	/**
	 * Converts a compressed audio blob to the target format inside the
	 * worker.
	 * @param blob - Input audio blob
	 * @param targetFormat - Desired output format
	 * @param bitrate - Bitrate in bits per second
	 * @param allowRemux - Allow packet copy when the codecs match
	 * @param channelMode - Channel layout for the output audio
	 * @param onProgress - Optional progress callback (0-100)
	 * @returns Converted blob
	 * @throws Error when the worker is unavailable or the conversion
	 * fails (the caller falls back to the main-thread pipeline)
	 */
	convertBlob(
		blob: Blob,
		targetFormat: string,
		bitrate: number,
		allowRemux: boolean,
		channelMode: ChannelMode = CHANNEL_MODE_SOURCE,
		onProgress?: (percent: number) => void,
	): Promise<Blob> {
		// Asked before the worker is handed over, not only inside
		// ensureWorker: a client given up on after a hang still holds a live
		// worker object, and returning it would send the next conversion to
		// wait on the thread that already stopped answering.
		if (!this.isAvailable()) {
			return Promise.reject(
				new Error('Encoding worker is not available'),
			);
		}
		const worker = this.ensureWorker();
		if (!worker) {
			return Promise.reject(
				new Error('Encoding worker is not available'),
			);
		}

		const id = this.nextRequestId++;
		const timeoutMs = scaledTimeoutMs(blob.size, {
			floorMs: ENCODING_WORKER_MIN_TIMEOUT_MS,
			bytesPerMs: ENCODING_WORKER_BYTES_PER_MS,
			maxMs: ENCODING_WORKER_MAX_TIMEOUT_MS,
		});
		return new Promise<Blob>((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject,
				onProgress,
				timeoutMs,
				timer: this.armWatchdog(id, timeoutMs),
			});
			const request: WorkerRequest = {
				id,
				kind: 'convertBlob',
				blob,
				targetFormat,
				bitrate,
				allowRemux,
				channelMode,
			};
			worker.postMessage(request);
		});
	}

	/**
	 * Starts the deadline by which this request must have heard something.
	 *
	 * Only this request is failed. The worker keeps running and its siblings
	 * keep their own deadlines, because multi-track finalization converts
	 * several tracks through one worker and terminating it would take the
	 * healthy ones down with the wedged one. The client is marked unavailable
	 * though: a worker that hung once will hang again, and every later
	 * conversion would otherwise sit out its whole budget before falling back
	 * to the main thread.
	 * @param id - Request the deadline belongs to
	 * @param timeoutMs - How long to wait for anything at all
	 * @returns The timer handle
	 */
	private armWatchdog(id: number, timeoutMs: number): number {
		return window.setTimeout(() => {
			const request = this.pending.get(id);
			if (!request) {
				return;
			}
			this.pending.delete(id);
			this.unavailable = true;
			request.reject(
				new Error(
					`Encoding worker did not answer within ${String(
						timeoutMs,
					)} ms`,
				),
			);
		}, timeoutMs);
	}

	/**
	 * Terminates the worker and rejects everything in flight. Called on
	 * plugin unload.
	 */
	terminate(): void {
		if (this.worker) {
			// Detach the handlers before terminating so a message already
			// queued cannot fire into a client that is tearing down.
			this.worker.onmessage = null;
			this.worker.onerror = null;
			this.worker.terminate();
			this.worker = null;
		}
		if (this.workerUrl) {
			URL.revokeObjectURL(this.workerUrl);
			this.workerUrl = null;
		}
		this.rejectAllPending(new Error('Encoding worker was terminated'));
	}

	/**
	 * Lazily creates the worker. A creation failure (CSP, missing
	 * source) marks the client unavailable so every later call falls
	 * back to the main thread immediately.
	 * @returns The worker, or null when it cannot run
	 */
	private ensureWorker(): Worker | null {
		if (this.worker) {
			return this.worker;
		}
		if (!this.isAvailable() || this.workerSource === null) {
			return null;
		}
		try {
			this.workerUrl = URL.createObjectURL(
				new Blob([this.workerSource], {
					type: 'application/javascript',
				}),
			);
			this.worker = new Worker(this.workerUrl);
			this.worker.onmessage = (event: MessageEvent): void => {
				this.dispatch(event.data as WorkerResponse);
			};
			this.worker.onerror = (event: ErrorEvent): void => {
				// A worker-level error is unrecoverable: reject everything
				// and degrade to the main-thread pipeline for good
				console.warn(
					`${PLUGIN_LOG_PREFIX} Encoding worker failed; falling back to the main thread:`,
					event.message,
				);
				this.unavailable = true;
				this.terminate();
			};
			return this.worker;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Encoding worker could not start; falling back to the main thread:`,
				error,
			);
			this.unavailable = true;
			this.terminate();
			return null;
		}
	}

	/**
	 * Routes one worker response to its pending request.
	 * @param response - Worker response
	 */
	private dispatch(response: WorkerResponse): void {
		const request = this.pending.get(response.id);
		if (!request) {
			return;
		}
		switch (response.kind) {
			case 'progress':
				// A worker that is reporting progress is working, so the
				// deadline starts over: what it bounds is silence, not the
				// length of a legitimately long conversion.
				window.clearTimeout(request.timer);
				request.timer = this.armWatchdog(
					response.id,
					request.timeoutMs,
				);
				request.onProgress?.(response.percent);
				break;
			case 'result':
				window.clearTimeout(request.timer);
				this.pending.delete(response.id);
				request.resolve(
					new Blob([response.buffer], { type: response.mimeType }),
				);
				break;
			case 'error':
				window.clearTimeout(request.timer);
				this.pending.delete(response.id);
				request.reject(new Error(response.message));
				break;
		}
	}

	/**
	 * Rejects all in-flight requests.
	 * @param error - Rejection error
	 */
	private rejectAllPending(error: Error): void {
		for (const request of this.pending.values()) {
			window.clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}
