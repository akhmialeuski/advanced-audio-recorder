/**
 * A Web Audio decoder that takes what it is given, the way Chromium's does.
 *
 * `decodeAudioData` does not read its input: it transfers it, and the caller is
 * left holding a detached buffer whose length reads zero. Handing that buffer
 * to the decoder a second time is refused with a `DataCloneError`, which is
 * what a WebM transcription retried through Gemini reported to the user (issue
 * #136) and what the transcribe dialog once did to its own probe bytes. Every
 * earlier double resolved whatever it was handed and left the buffer intact,
 * so a second decode of the same bytes passed in the suite and failed in the
 * app. This one reproduces the ownership rule as well as the decode, so a
 * path that reuses bytes after decoding them fails here first.
 *
 * The offline context is installed alongside because every transcription
 * decode resamples through one, and it renders silence of the length asked
 * for: the tests built on this read how often audio was decoded and what was
 * uploaded, not the samples themselves.
 * @module tests/helpers/webAudioDecode
 */

import { createMockAudioBuffer } from './createMockAudioBuffer';
import { globals } from './doubles';

/** What Chromium answers when a detached buffer is handed to the decoder. */
export const DETACHED_DECODE_MESSAGE =
	"Failed to execute 'decodeAudioData' on 'BaseAudioContext': " +
	'Cannot decode detached ArrayBuffer';

/** What Chromium answers for bytes it cannot read as audio. */
const UNDECODABLE_MESSAGE = 'Unable to decode audio data';

/** The rate the source audio is reported at, the one recordings carry. */
const SOURCE_SAMPLE_RATE = 48000;

/**
 * The two ES2024 members of an ArrayBuffer this double relies on. Typed here
 * rather than through the compiler's lib, which the plugin pins to ES2022.
 */
interface TransferableBuffer {
	readonly detached: boolean;
	transfer(): ArrayBuffer;
}

/** Handle returned by {@link installTransferringDecoder}. */
export interface TransferringDecoder {
	/**
	 * The length of every buffer handed to `decodeAudioData`, in order, read
	 * before the decode took it. A detached buffer is recorded as 0.
	 */
	readonly decodedByteLengths: number[];
	/** Puts back the contexts that were installed before. */
	restore(): void;
}

/**
 * Installs an AudioContext whose decode transfers its input, and the offline
 * context the 16 kHz resample renders through.
 * @param durationSeconds - How long every decoded recording is
 * @returns The record of what was decoded, and the undo
 */
export function installTransferringDecoder(
	durationSeconds: number,
): TransferringDecoder {
	const decodedByteLengths: number[] = [];
	const scope = globals();
	const previousContext = scope['AudioContext'];
	const previousOffline = scope['OfflineAudioContext'];

	scope['AudioContext'] = class {
		readonly sampleRate = SOURCE_SAMPLE_RATE;
		state = 'running';

		decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
			decodedByteLengths.push(data.byteLength);
			const buffer = data as ArrayBuffer & TransferableBuffer;
			if (buffer.detached) {
				return Promise.reject(
					new DOMException(DETACHED_DECODE_MESSAGE, 'DataCloneError'),
				);
			}
			if (buffer.byteLength === 0) {
				return Promise.reject(
					new DOMException(UNDECODABLE_MESSAGE, 'EncodingError'),
				);
			}
			// Taken before the decode resolves, as the browser takes it: the
			// caller's buffer is already empty by the time it gets an answer.
			buffer.transfer();
			return Promise.resolve(
				createMockAudioBuffer(
					1,
					Math.round(durationSeconds * SOURCE_SAMPLE_RATE),
					SOURCE_SAMPLE_RATE,
				),
			);
		}

		close(): Promise<void> {
			this.state = 'closed';
			return Promise.resolve();
		}
	};

	scope['OfflineAudioContext'] = class {
		readonly destination = {};

		constructor(
			private readonly channels: number,
			private readonly frames: number,
			private readonly sampleRate: number,
		) {}

		createBufferSource(): object {
			return {
				buffer: null,
				connect: () => undefined,
				start: () => undefined,
			};
		}

		startRendering(): Promise<AudioBuffer> {
			return Promise.resolve(
				createMockAudioBuffer(
					this.channels,
					this.frames,
					this.sampleRate,
				),
			);
		}
	};

	return {
		decodedByteLengths,
		restore: () => {
			for (const [name, previous] of [
				['AudioContext', previousContext],
				['OfflineAudioContext', previousOffline],
			] as const) {
				if (previous === undefined) {
					delete scope[name];
				} else {
					scope[name] = previous;
				}
			}
		},
	};
}
