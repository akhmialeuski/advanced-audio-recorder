/**
 * Creation of the capture primitives for a recording session: MediaRecorder
 * instances (chunked compressed capture) and PcmStreamRecorder instances
 * (direct PCM capture for desktop WAV). Kept separate from the session
 * lifecycle so RecordingManager only orchestrates.
 * @module recording/RecorderFactory
 */

import { CHUNK_TIMESLICE_MS } from '../constants';
import { CHANNEL_MODE_SOURCE, type ChannelMode } from '../audio/downmix';
import { PcmStreamRecorder } from './PcmStreamRecorder';

/** Configuration for a batch of MediaRecorders. */
export interface MediaRecorderConfig {
	/** Full MIME type passed to the MediaRecorder constructor. */
	mimeType: string;
	/** Encoder bitrate in bits per second. */
	bitrate: number;
}

/** Callbacks attached to every created MediaRecorder. */
export interface MediaRecorderCallbacks {
	/** Called with each non-empty data chunk. */
	onChunk: (index: number, data: Blob) => void;
	/** Called when a recorder reports an error event. */
	onError: (index: number, event: Event) => void;
}

/**
 * Creates MediaRecorder instances on the given streams, attaches
 * chunk/error handlers, and starts them with the chunk timeslice.
 * Used at recording start and after each auto-split part rotation.
 * @param streams - Audio streams to record, one recorder per stream
 * @param config - MIME type and bitrate for every recorder
 * @param callbacks - Chunk and error handlers
 * @returns The started recorders, in stream order
 */
export function createAndStartMediaRecorders(
	streams: MediaStream[],
	config: MediaRecorderConfig,
	callbacks: MediaRecorderCallbacks,
): MediaRecorder[] {
	const recorders = streams.map(
		(stream) =>
			new MediaRecorder(stream, {
				mimeType: config.mimeType,
				audioBitsPerSecond: config.bitrate,
			}),
	);
	recorders.forEach((recorder, index) => {
		recorder.ondataavailable = (event: BlobEvent): void => {
			if (event.data.size > 0) {
				callbacks.onChunk(index, event.data);
			}
		};
		recorder.onerror = (event: Event): void => {
			callbacks.onError(index, event);
		};
		recorder.start(CHUNK_TIMESLICE_MS);
	});
	return recorders;
}

/**
 * Detaches the chunk and error handlers from recorders that are being
 * discarded, so a chunk already queued by the browser cannot fire into a
 * torn-down session (e.g. after stop, unload, or a failed start).
 * @param recorders - Recorders about to be dropped
 */
export function detachRecorderHandlers(recorders: MediaRecorder[]): void {
	for (const recorder of recorders) {
		recorder.ondataavailable = null;
		recorder.onerror = null;
	}
}

/**
 * Creates PcmStreamRecorder instances for direct PCM capture, one per
 * stream. The recorders are not started; the caller starts them so it can
 * read the negotiated channel count and sample rate per recorder.
 * @param streams - Audio streams to capture
 * @param sampleRate - Requested capture sample rate in Hz
 * @param onChunk - Called with each captured PCM chunk
 * @param channelModes - Channel layout per stream (aligned by index)
 * applied by each recorder's capture worklet; a missing entry keeps
 * the source pass-through
 * @returns The created recorders, in stream order
 */
export function createPcmRecorders(
	streams: MediaStream[],
	sampleRate: number,
	onChunk: (index: number, data: ArrayBuffer) => void,
	channelModes: readonly ChannelMode[] = [],
): PcmStreamRecorder[] {
	return streams.map(
		(stream, index) =>
			new PcmStreamRecorder(
				stream,
				sampleRate,
				(data: ArrayBuffer) => {
					onChunk(index, data);
				},
				channelModes[index] ?? CHANNEL_MODE_SOURCE,
			),
	);
}
