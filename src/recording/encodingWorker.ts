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
 * @module recording/encodingWorker
 */

import {
	Input,
	Output,
	BlobSource,
	BufferTarget,
	ALL_FORMATS,
	Conversion,
} from 'mediabunny';
import type { AudioCodec } from 'mediabunny';
import {
	ensureEncoderRegistered,
	createOutputFormat,
	FORMAT_CODEC_MAP,
} from './AudioEncoder';
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
}

/**
 * Responses posted back to the client.
 */
export type WorkerResponse =
	| { id: number; kind: 'progress'; percent: number }
	| { id: number; kind: 'result'; buffer: ArrayBuffer; mimeType: string }
	| { id: number; kind: 'error'; message: string };

/**
 * Handles one conversion request. Mirrors the main-thread streaming
 * pipeline of AudioFormatConverter.convertBlobWithConversion; failures
 * are posted as error responses and the client falls back to the main
 * thread.
 * @param request - Conversion request
 * @param post - Posts a response (with optional transferables)
 */
export async function handleEncodingMessage(
	request: WorkerRequest,
	post: (response: WorkerResponse, transfer?: Transferable[]) => void,
): Promise<void> {
	try {
		const codec: AudioCodec | undefined =
			FORMAT_CODEC_MAP[request.targetFormat];
		if (!codec) {
			throw new Error(
				`No codec mapping for format "${request.targetFormat}"`,
			);
		}

		await ensureEncoderRegistered(request.targetFormat);

		const input = new Input({
			source: new BlobSource(request.blob),
			formats: ALL_FORMATS,
		});
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			throw new Error('Input contains no audio track');
		}

		const target = new BufferTarget();
		const output = new Output({
			format: createOutputFormat(request.targetFormat),
			target,
		});

		const inputCodec = await audioTrack.getCodec();
		// PCM targets are uncompressed: a bitrate option is invalid there
		const isPcmTarget = codec.startsWith('pcm-');
		const conversion = await Conversion.init({
			input,
			output,
			audio:
				(request.allowRemux && inputCodec === codec) || isPcmTarget
					? { codec }
					: { codec, bitrate: request.bitrate },
			showWarnings: false,
		});

		const audioDiscarded = conversion.discardedTracks.some((discarded) =>
			discarded.track.isAudioTrack(),
		);
		if (!conversion.isValid || audioDiscarded) {
			throw new Error(
				`Conversion to "${request.targetFormat}" cannot process the input audio track`,
			);
		}

		let lastPercent = -1;
		conversion.onProgress = (progress: number): void => {
			const percent = Math.round(progress * 100);
			if (percent !== lastPercent) {
				lastPercent = percent;
				post({ id: request.id, kind: 'progress', percent });
			}
		};

		await conversion.execute();

		const resultBuffer = target.buffer;
		if (!resultBuffer || resultBuffer.byteLength === 0) {
			throw new Error(
				`Conversion to "${request.targetFormat}" produced no output`,
			);
		}
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

// Worker glue: only active inside a dedicated worker scope. The
// module is also imported (types only) by the client on the main
// thread, where this block must stay inert.
declare const self:
	| {
			onmessage: ((event: MessageEvent) => void) | null;
			postMessage: (message: unknown, transfer?: Transferable[]) => void;
			document?: unknown;
	  }
	| undefined;

if (
	typeof self !== 'undefined' &&
	typeof self.postMessage === 'function' &&
	typeof self.document === 'undefined'
) {
	self.onmessage = (event: MessageEvent): void => {
		void handleEncodingMessage(
			event.data as WorkerRequest,
			(response, transfer) => {
				self.postMessage(response, transfer);
			},
		);
	};
}
