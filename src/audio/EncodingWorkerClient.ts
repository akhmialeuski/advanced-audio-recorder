/**
 * Main-thread client for the encoding Web Worker. Starts the worker
 * from inlined source via a Blob URL (the technique the PCM recorder
 * uses for its AudioWorklet), correlates requests with responses, and
 * degrades permanently to the main-thread pipeline when the worker
 * cannot run - conversion never depends on worker availability.
 * @module audio/EncodingWorkerClient
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { WorkerRequest, WorkerResponse } from './encodingWorker';

/** Pending request bookkeeping. */
interface PendingRequest {
	resolve: (blob: Blob) => void;
	reject: (error: Error) => void;
	onProgress?: (percent: number) => void;
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
		onProgress?: (percent: number) => void,
	): Promise<Blob> {
		const worker = this.ensureWorker();
		if (!worker) {
			return Promise.reject(
				new Error('Encoding worker is not available'),
			);
		}

		const id = this.nextRequestId++;
		return new Promise<Blob>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
			const request: WorkerRequest = {
				id,
				kind: 'convertBlob',
				blob,
				targetFormat,
				bitrate,
				allowRemux,
			};
			worker.postMessage(request);
		});
	}

	/**
	 * Terminates the worker and rejects everything in flight. Called on
	 * plugin unload.
	 */
	terminate(): void {
		if (this.worker) {
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
				request.onProgress?.(response.percent);
				break;
			case 'result':
				this.pending.delete(response.id);
				request.resolve(
					new Blob([response.buffer], { type: response.mimeType }),
				);
				break;
			case 'error':
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
			request.reject(error);
		}
		this.pending.clear();
	}
}

/** Active client used by the conversion pipeline, set by the plugin. */
let activeClient: EncodingWorkerClient | null = null;

/**
 * Registers the encoding worker client for the conversion pipeline.
 * @param client - Client instance, or null to disable worker offload
 */
export function setEncodingWorkerClient(
	client: EncodingWorkerClient | null,
): void {
	activeClient = client;
}

/**
 * Returns the active encoding worker client, if any is usable.
 */
export function getEncodingWorkerClient(): EncodingWorkerClient | null {
	return activeClient && activeClient.isAvailable() ? activeClient : null;
}
