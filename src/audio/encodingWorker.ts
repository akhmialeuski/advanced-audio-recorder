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

import {
	runStreamingConversion,
	type ConvertedAudio,
} from './streamingConversion';
import { normalizeChannelMode, type ChannelMode } from './downmix';
import { errorMessage } from '../errors';
import { CancellationSource } from '../utils/cancellation';

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

/** Stops the conversion a request started, sent when its caller cancels. */
export interface WorkerCancel {
	/** The request whose conversion stops. */
	id: number;
	kind: 'cancel';
}

/** Everything the client sends the worker. */
export type WorkerMessage = WorkerRequest | WorkerCancel;

/**
 * Responses posted back to the client.
 */
export type WorkerResponse =
	| { id: number; kind: 'progress'; percent: number }
	| ({ id: number; kind: 'result' } & ConvertedAudio<ArrayBuffer>)
	| { id: number; kind: 'error'; message: string };

/**
 * The cancellation of each conversion the worker is running, by request id,
 * so a cancel message can reach the conversion it names. An entry lives
 * exactly as long as its conversion does.
 */
const running = new Map<number, CancellationSource>();

/**
 * Handles one message from the client. A conversion request runs through
 * the shared streaming conversion core (see streamingConversion.ts, also
 * used by the main-thread pipeline); failures are posted as error responses
 * and the client falls back to the main thread. A cancel stops the
 * conversion it names inside mediabunny, which then answers with an error
 * the client, having already given up on the request, ignores.
 * @param message - Conversion request, or the cancel of one
 * @param post - Posts a response (with optional transferables)
 */
export async function handleEncodingMessage(
	message: WorkerMessage,
	post: (response: WorkerResponse, transfer?: Transferable[]) => void,
): Promise<void> {
	if (message.kind === 'cancel') {
		running.get(message.id)?.cancel();
		return;
	}
	const request = message;
	const cancellation = new CancellationSource();
	running.set(request.id, cancellation);
	try {
		const { data, sampleRateChange } = await runStreamingConversion(
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
			cancellation.token,
		);
		post(
			{
				id: request.id,
				kind: 'result',
				data,
				sampleRateChange,
			},
			[data],
		);
	} catch (error) {
		post({
			id: request.id,
			kind: 'error',
			message: errorMessage(error),
		});
	} finally {
		running.delete(request.id);
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
			event.data as WorkerMessage,
			(response, transfer) => {
				self.postMessage(response, transfer);
			},
		);
	};
}
