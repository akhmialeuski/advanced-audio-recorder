/**
 * Shared core of the streaming audio conversion pipeline: demuxes the
 * input blob, transcodes (or remuxes) the audio track with mediabunny,
 * and muxes it into the target container without materializing the
 * whole recording as PCM in memory. Used identically by the
 * main-thread pipeline (AudioFormatConverter) and the encoding Web
 * Worker (encodingWorker), so the two execution paths cannot diverge.
 * @module recording/streamingConversion
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

/**
 * Converts a compressed audio blob to the target format using the
 * streaming mediabunny Conversion pipeline. With allowRemux, packets
 * of an input whose codec already matches the target codec are copied
 * without re-encoding.
 * @param recordedBlob - Input audio blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second (ignored for PCM targets)
 * @param allowRemux - Allow packet copy when the codecs match
 * @param onProgress - Optional progress callback (0-100, deduplicated)
 * @returns Bytes of the converted file
 * @throws Error when the target format has no codec mapping, the
 * input has no audio track, the conversion cannot process the audio
 * track, or it produces no output (the caller falls back to decode
 * and re-encode)
 */
export async function runStreamingConversion(
	recordedBlob: Blob,
	targetFormat: string,
	bitrate: number,
	allowRemux: boolean,
	onProgress?: (percent: number) => void,
): Promise<ArrayBuffer> {
	const codec: AudioCodec | undefined = FORMAT_CODEC_MAP[targetFormat];
	if (!codec) {
		throw new Error(`No codec mapping for format "${targetFormat}"`);
	}

	await ensureEncoderRegistered(targetFormat);

	const input = new Input({
		source: new BlobSource(recordedBlob),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) {
		throw new Error('Input contains no audio track');
	}

	const target = new BufferTarget();
	const output = new Output({
		format: createOutputFormat(targetFormat),
		target,
	});

	// Omitting bitrate lets mediabunny copy packets (remux) when the
	// input codec matches the target; setting it always forces a
	// re-encode per the Conversion contract. Remux is allowed only
	// when the caller knows the input is already at the requested
	// bitrate. Discarded tracks are handled explicitly below, so
	// mediabunny's own console warnings about them are disabled.
	const inputCodec = await audioTrack.getCodec();
	// PCM targets are uncompressed: a bitrate option is invalid there
	const isPcmTarget = codec.startsWith('pcm-');
	const conversion = await Conversion.init({
		input,
		output,
		audio:
			(allowRemux && inputCodec === codec) || isPcmTarget
				? { codec }
				: { codec, bitrate },
		showWarnings: false,
	});

	// Conversion.init does not throw for codec problems: it silently
	// discards the track (undecodable_source_codec or
	// no_encodable_target_codec) and would emit a container without
	// audio. Fail here instead, so the caller's decode-and-re-encode
	// fallback processes the input.
	const audioDiscarded = conversion.discardedTracks.some((discarded) =>
		discarded.track.isAudioTrack(),
	);
	if (!conversion.isValid || audioDiscarded) {
		throw new Error(
			`Conversion to "${targetFormat}" cannot process the input audio track`,
		);
	}

	if (onProgress) {
		let lastPercent = -1;
		conversion.onProgress = (progress: number): void => {
			const percent = Math.round(progress * 100);
			if (percent !== lastPercent) {
				lastPercent = percent;
				onProgress(percent);
			}
		};
	}

	await conversion.execute();

	const resultBuffer = target.buffer;
	if (!resultBuffer || resultBuffer.byteLength === 0) {
		throw new Error(`Conversion to "${targetFormat}" produced no output`);
	}
	return resultBuffer;
}
