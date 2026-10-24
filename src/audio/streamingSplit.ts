/**
 * Splitting a compressed recording into re-encoded parts while it is being
 * decoded, so no more of it is ever held as PCM than the decoder has in hand.
 *
 * The split used to decode the whole file into one AudioBuffer and slice the
 * parts out of it. That is 32-bit floats for every sample of every channel: a
 * two-hour stereo recording at 48 kHz is 2.7 GB of buffer for a file of a few
 * dozen megabytes, which is the long recording splitting exists for. Here one
 * pass of mediabunny's decoder runs from the first packet to the last, and its
 * samples are cut into parts by frame count and handed to one encoder per
 * part, in order. Memory is the source bytes, the decoder's queue and the part
 * being encoded.
 *
 * The parts are cut out of one continuous decode on purpose. A separate
 * trimmed Conversion per part would start each decoder cold at the packet
 * holding the cut - no pre-roll, so the first AAC frame of a part decodes
 * without the half it overlaps, and the first MP3 frame without its bit
 * reservoir - and copying packets instead of re-encoding would ignore the
 * bitrate the split dialog asks for and cut on packet boundaries rather than
 * on frames. Cutting decoded frames keeps both: every boundary lands on the
 * exact frame the decode-everything path cut at, and every part is encoded at
 * the chosen bitrate.
 * @module audio/streamingSplit
 */

import type { AudioSample, AudioSampleSource, Input } from 'mediabunny';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	createOutputFormat,
	encodingConfigFor,
	probeOfflineEncodingSupport,
} from './AudioEncoder';
import { loadAudioEngine } from './audioEngine';
import { errorMessage } from '../errors';
import {
	NEVER_CANCELLED,
	throwIfCancelled,
	type CancellationToken,
} from '../utils/cancellation';

/**
 * How far short of the container's stated end the split plans its parts, in
 * seconds.
 *
 * The parts are named and counted before a frame is decoded, from the length
 * the container states, and that length is not the decoded one: encoder
 * priming and padding make the two differ by a few tens of milliseconds. A
 * plan that trusted it could open a last part after the decoded audio has
 * ended, which would be a file with nothing in it. Planning this much short
 * means the decoded audio always reaches the last part; a remainder shorter
 * than this rides on the part before it instead of becoming one of its own.
 *
 * The split that decodes the whole file first plans the same distance short
 * of its exact length, so a device that cannot stream a recording cuts it
 * into the parts a device that can would cut.
 */
export const SPLIT_TAIL_SECONDS = 0.25;

/**
 * The next decoded sample a player would present, with the frames before
 * time zero cut off.
 *
 * Codecs that prime their decoder - Opus with its pre-skip, AAC behind an
 * edit list - hand over leading samples stamped before zero, which are not
 * part of the recording. A decode into one buffer leaves them out, and so
 * must the split, or every cut would land that many frames early.
 * @param samples - The decoder's output, in order
 * @returns The sample, trimmed to what is presented, or null at the end
 */
async function nextPresentedSample(
	samples: AsyncIterator<AudioSample>,
): Promise<AudioSample | null> {
	for (;;) {
		const next = await samples.next();
		if (next.done) {
			return null;
		}
		const sample = next.value;
		if (sample.timestamp >= 0) {
			return sample;
		}
		const hidden = Math.round(-sample.timestamp * sample.sampleRate);
		if (hidden < sample.numberOfFrames) {
			const presented = sample.trim(hidden);
			sample.close();
			return presented;
		}
		sample.close();
	}
}

/**
 * The streamed split failed after it was set up, which the caller answers by
 * splitting the way it always did.
 */
export class StreamedSplitError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'StreamedSplitError';
	}
}

/**
 * A recording being split as it is decoded. Parts are encoded in order, each
 * continuing where the last one stopped.
 */
export class StreamedSplit implements Disposable {
	/** Frames handed to parts so far. */
	private consumed = 0;

	private constructor(
		private readonly input: Input,
		private readonly samples: AsyncIterator<AudioSample>,
		/** The decoded sample the next part starts with, possibly a remainder. */
		private pending: AudioSample | null,
		private readonly targetFormat: string,
		private readonly bitrate: number,
		/** Rate of the decoded audio, which is what frames are counted in. */
		readonly sampleRate: number,
		/** Channels of the decoded audio. */
		readonly numberOfChannels: number,
		/** Frames the parts are planned over, a little short of the end. */
		readonly plannedFrames: number,
		/** Stops the decode between two of its samples. */
		private readonly token: CancellationToken,
	) {}

	/**
	 * Opens a recording for a streamed split, or answers null where this device
	 * cannot run one: a container mediabunny does not read, a codec it has no
	 * decoder for (WebKit without WebCodecs' AudioDecoder), or a target format
	 * the encoder refuses at the decoded layout and rate. Null sends the caller
	 * to the decode-everything path, which needs none of these.
	 *
	 * The first sample is decoded here rather than when the first part is
	 * written, because the decoder's output, not the container's header, says
	 * what rate and layout the frames are counted in: an HE-AAC stream states
	 * its core rate and decodes at twice it.
	 * @param bytes - The recording's bytes, which are read and not taken
	 * @param targetFormat - Format the parts are encoded to
	 * @param bitrate - Bitrate the parts are encoded at
	 * @param token - Cancels the split while a part is being encoded
	 * @returns The open split, or null where it cannot run here
	 */
	static async open(
		bytes: ArrayBuffer,
		targetFormat: string,
		bitrate: number,
		token: CancellationToken = NEVER_CANCELLED,
	): Promise<StreamedSplit | null> {
		const { ALL_FORMATS, AudioSampleSink, BufferSource, Input } =
			await loadAudioEngine();
		const input = new Input({
			source: new BufferSource(bytes),
			formats: ALL_FORMATS,
		});
		let samples: AsyncIterator<AudioSample> | null = null;
		try {
			const track = await input.getPrimaryAudioTrack();
			if (!track || !(await track.canDecode())) {
				input.dispose();
				return null;
			}
			const end = await input.computeDuration();
			samples = new AudioSampleSink(track).samples();
			const sample = await nextPresentedSample(samples);
			if (!sample) {
				input.dispose();
				return null;
			}
			const { sampleRate, numberOfChannels } = sample;
			if (
				!(await probeOfflineEncodingSupport(targetFormat, {
					numberOfChannels,
					sampleRate,
					bitrate,
				}))
			) {
				sample.close();
				await samples.return?.();
				input.dispose();
				return null;
			}
			const seconds =
				end - Math.max(0, sample.timestamp) - SPLIT_TAIL_SECONDS;
			return new StreamedSplit(
				input,
				samples,
				sample,
				targetFormat,
				bitrate,
				sampleRate,
				numberOfChannels,
				Math.max(0, Math.floor(seconds * sampleRate)),
				token,
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The recording cannot be split as it is decoded; decoding it whole instead:`,
				error,
			);
			await samples?.return?.();
			input.dispose();
			return null;
		}
	}

	/**
	 * Encodes the next part: every decoded frame from where the previous part
	 * stopped up to, not including, the given frame, or to the end of the
	 * recording.
	 * @param endFrame - Frame the part stops before, or null for the last part
	 * @returns The encoded part
	 * @throws StreamedSplitError when decoding or encoding fails, when the
	 *   audio ends before the part has any frames, or once the token is
	 *   cancelled; the caller asks the token to tell a cancel apart
	 */
	async nextPart(endFrame: number | null): Promise<ArrayBuffer> {
		try {
			return await this.encodeUntil(endFrame);
		} catch (error) {
			if (error instanceof StreamedSplitError) {
				throw error;
			}
			throw new StreamedSplitError(
				`Splitting while decoding failed: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	/**
	 * Feeds decoded samples to a fresh encoder until the part is full.
	 * @param endFrame - Frame the part stops before, or null for the end
	 * @returns The encoded part
	 */
	private async encodeUntil(endFrame: number | null): Promise<ArrayBuffer> {
		const { AudioSampleSource, BufferTarget, Output } =
			await loadAudioEngine();
		const target = new BufferTarget();
		const output = new Output({
			format: await createOutputFormat(this.targetFormat),
			target,
		});
		const source = new AudioSampleSource(
			await encodingConfigFor(this.targetFormat, this.bitrate, {
				numberOfChannels: this.numberOfChannels,
				sampleRate: this.sampleRate,
			}),
		);
		output.addAudioTrack(source);
		try {
			await output.start();
			await this.fill(source, endFrame);
			source.close();
			await output.finalize();
		} catch (error) {
			// The encoder behind the output is a platform resource, released
			// by cancelling rather than by being forgotten, whichever step
			// failed. A cancel after a finalize that failed part-way is a
			// no-op in mediabunny, so it is safe on every path.
			await output.cancel();
			throw error;
		}
		if (!target.buffer) {
			throw new StreamedSplitError(
				'The part encoder produced no output.',
			);
		}
		return target.buffer;
	}

	/**
	 * Hands the encoder decoded frames until the part is full or the
	 * recording ends.
	 * @param source - The part's encoder input
	 * @param endFrame - Frame the part stops before, or null for the end
	 * @throws StreamedSplitError when the recording ended before the part began
	 */
	private async fill(
		source: AudioSampleSource,
		endFrame: number | null,
	): Promise<void> {
		const partStart = this.consumed;
		while (endFrame === null || this.consumed < endFrame) {
			// Asked per decoded sample, since one part of a long recording
			// is minutes of decoding with no boundary in between.
			throwIfCancelled(this.token);
			const sample =
				this.pending ?? (await nextPresentedSample(this.samples));
			this.pending = null;
			if (!sample) {
				break;
			}
			const room =
				endFrame === null
					? sample.numberOfFrames
					: endFrame - this.consumed;
			let piece = sample;
			if (sample.numberOfFrames > room) {
				// The sample straddles the cut: its head ends this part and
				// its tail opens the next.
				piece = sample.trim(0, room);
				this.pending = sample.trim(room);
				sample.close();
			}
			// Frames are counted rather than timestamps trusted, as a decode
			// into one buffer counts them, so a stream whose timestamps jitter
			// is cut where that decode would have cut it.
			piece.setTimestamp((this.consumed - partStart) / this.sampleRate);
			try {
				await source.add(piece);
			} finally {
				piece.close();
			}
			this.consumed += piece.numberOfFrames;
		}

		if (this.consumed === partStart) {
			throw new StreamedSplitError(
				'The recording ended before this part began.',
			);
		}
	}

	/** Stops the decoder and releases the recording, however the split ended. */
	[Symbol.dispose](): void {
		this.pending?.close();
		this.pending = null;
		// Not awaited, since disposal is synchronous; a decoder that fails to
		// stop is logged rather than left as an unhandled rejection.
		this.samples.return?.(undefined).catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The streamed split could not stop the decoder:`,
				error,
			);
		});
		this.input.dispose();
	}
}
