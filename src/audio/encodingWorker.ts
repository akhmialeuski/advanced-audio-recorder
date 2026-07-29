/**
 * Web Worker entry for the streaming audio conversion pipeline. The
 * mediabunny demux/transcode/mux loop is pure computation plus
 * WebCodecs (both available in dedicated workers), so running it here
 * keeps long re-encodes off the UI thread. Web Audio decoding is NOT
 * available in workers; the main-thread decode fallback stays in
 * AudioFormatConverter.
 *
 * The module is bundled separately by esbuild and injected into the
 * main bundle as source text (see esbuild.config.mjs); the client
 * starts it via a Blob URL, the same technique the PCM recorder uses
 * for its AudioWorklet.
 * @module audio/encodingWorker
 */

import { runStreamingConversion } from './streamingConversion';
import { normalizeChannelMode, type ChannelMode } from './downmix';
import { MIME_TYPE_AUDIO_PREFIX } from '../constants';

/**
 * Conversion request sent to the worker.
 */
export interface WorkerRequest {
	/** Correlates responses with the originating request. */
	id: number;
	kind: 'convertBlob';
	/** Input audio blob (structured-cloned by reference). */
	blob: Blob;
	/** Desired output format. */
	targetFormat: string;
	/** Bitrate in bits per second. */
	bitrate: number;
	/** Allow packet copy when the codecs match. */
	allowRemux: boolean;
	/** Channel layout for the output audio (source kept when absent). */
	channelMode?: ChannelMode | undefined;
}

/**
 * Responses posted back to the client.
 */
export type WorkerResponse =
	| { id: number; kind: 'progress'; percent: number }
	| { id: number; kind: 'result'; buffer: ArrayBuffer; mimeType: string }
	| { id: number; kind: 'error'; message: string };

/**
 * Handles one conversion request through the shared streaming
 * conversion core (see streamingConversion.ts, also used by the
 * main-thread pipeline); failures are posted as error responses and
 * the client falls back to the main thread.
 * @param request - Conversion request
 * @param post - Posts a response (with optional transferables)
 */
export async function handleEncodingMessage(
	request: WorkerRequest,
	post: (response: WorkerResponse, transfer?: Transferable[]) => void,
): Promise<void> {
	try {
		const resultBuffer = await runStreamingConversion(
			request.blob,
			request.targetFormat,
			request.bitrate,
			request.allowRemux,
			(percent) => {
				post({ id: request.id, kind: 'progress', percent });
			},
			// Structured-clone delivers plain data; normalize so an
			// unexpected value degrades to the source layout
			normalizeChannelMode(request.channelMode),
		);
		post(
			{
				id: request.id,
				kind: 'result',
				buffer: resultBuffer,
				mimeType: `${MIME_TYPE_AUDIO_PREFIX}${request.targetFormat}`,
			},
			[resultBuffer],
		);
	} catch (error) {
		post({
			id: request.id,
			kind: 'error',
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

// Worker glue: only active inside a dedicated worker scope, detected
// positively via importScripts, which exists in worker scopes only.
// The module is also imported (types only) by the client on the main
// thread, where this block must stay inert.
declare const self:
	| {
			onmessage: ((event: MessageEvent) => void) | null;
			postMessage: (message: unknown, transfer?: Transferable[]) => void;
			importScripts?: (...urls: string[]) => void;
	  }
	| undefined;

if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
	self.onmessage = (event: MessageEvent): void => {
		void handleEncodingMessage(
			event.data as WorkerRequest,
			(response, transfer) => {
				self.postMessage(response, transfer);
			},
		);
	};
}
