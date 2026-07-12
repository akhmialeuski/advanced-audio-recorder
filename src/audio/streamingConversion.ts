/**
 * Shared core of the streaming audio conversion pipeline: demuxes the
 * input blob, transcodes (or remuxes) the audio track with mediabunny,
 * and muxes it into the target container without materializing the
 * whole recording as PCM in memory. Used identically by the
 * main-thread pipeline (AudioFormatConverter) and the encoding Web
 * Worker (encodingWorker), so the two execution paths cannot diverge.
 * @module audio/streamingConversion
 */

import {
	Input,
	Output,
	BlobSource,
	BufferTarget,
	ALL_FORMATS,
	AudioSample,
	Conversion,
} from 'mediabunny';
import type { AudioCodec, ConversionAudioOptions } from 'mediabunny';
import { ensureEncoderRegistered, createOutputFormat } from './AudioEncoder';
import { getFormatDescriptor } from './formatRegistry';
import {
	CHANNEL_MODE_SOURCE,
	CHANNEL_MODE_MONO_MIX,
	monoPickIndex,
	type ChannelMode,
} from './downmix';
import { disposableOf } from '../utils/disposables';

/**
 * Builds a mono AudioSample holding one picked channel of the input
 * sample. Used as the mediabunny `process` hook for the left/right
 * channel modes; mediabunny closes the input sample itself after the
 * hook returns. The pick is clamped so a right pick on mono input
 * returns that channel instead of failing. Exported for unit tests.
 * @param sample - Decoded input sample (any channel count)
 * @param channelIndex - Zero-based channel to keep
 * @returns Mono sample at the input's rate and timestamp
 */
export function extractChannelSample(
	sample: AudioSample,
	channelIndex: number,
): AudioSample {
	const pick = Math.max(
		0,
		Math.min(channelIndex, sample.numberOfChannels - 1),
	);
	const data = new Float32Array(sample.numberOfFrames);
	sample.copyTo(data, { planeIndex: pick, format: 'f32-planar' });
	return new AudioSample({
		data,
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: sample.sampleRate,
		timestamp: sample.timestamp,
	});
}

/**
 * Builds a mono AudioSample holding the plain average of every channel
 * of the input sample. Used as the mediabunny `process` hook for the
 * mono mix mode so the conversion downmix is sample-identical to the
 * PCM capture worklet and downmixChannelData - mediabunny's own
 * numberOfChannels remixing follows the Web Audio speaker rules
 * instead, which weight 5.1 layouts and drop the LFE. Exported for
 * unit tests.
 * @param sample - Decoded input sample (any channel count)
 * @returns Mono sample at the input's rate and timestamp
 */
export function averageChannelsSample(sample: AudioSample): AudioSample {
	const frames = sample.numberOfFrames;
	const channels = sample.numberOfChannels;
	const interleaved = new Float32Array(frames * channels);
	sample.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
	const mono = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame++) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel++) {
			sum += interleaved[frame * channels + channel] ?? 0;
		}
		mono[frame] = sum / channels;
	}
	return new AudioSample({
		data: mono,
		format: 'f32',
		numberOfChannels: 1,
		sampleRate: sample.sampleRate,
		timestamp: sample.timestamp,
	});
}

/**
 * Converts a compressed audio blob to the target format using the
 * streaming mediabunny Conversion pipeline. With allowRemux, packets
 * of an input whose codec already matches the target codec are copied
 * without re-encoding. A mono channel mode downmixes during the
 * conversion through custom process hooks: the mix averages every
 * channel and the left/right modes keep one picked channel, both
 * sample-identical to the capture-time downmix. Multichannel mono
 * conversions therefore always transcode; already-mono input keeps
 * its remux eligibility.
 * @param recordedBlob - Input audio blob
 * @param targetFormat - Desired output format
 * @param bitrate - Bitrate in bits per second (ignored for PCM targets)
 * @param allowRemux - Allow packet copy when the codecs match
 * @param onProgress - Optional progress callback (0-100, deduplicated)
 * @param channelMode - Channel layout for the output audio
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
	channelMode: ChannelMode = CHANNEL_MODE_SOURCE,
): Promise<ArrayBuffer> {
	const codec: AudioCodec | undefined =
		getFormatDescriptor(targetFormat)?.codec;
	if (!codec) {
		throw new Error(`No codec mapping for format "${targetFormat}"`);
	}

	await ensureEncoderRegistered(targetFormat);

	// The Input holds readers over the blob; `using` frees them on
	// success and on every throw path alike
	using input = disposableOf(
		new Input({
			source: new BlobSource(recordedBlob),
			formats: ALL_FORMATS,
		}),
	);
	return await convertWithInput(
		input,
		targetFormat,
		codec,
		bitrate,
		allowRemux,
		onProgress,
		channelMode,
	);
}

/**
 * Runs the conversion over an already-opened Input. Separated so the
 * caller can guarantee input disposal in one place.
 */
async function convertWithInput(
	input: Input,
	targetFormat: string,
	codec: AudioCodec,
	bitrate: number,
	allowRemux: boolean,
	onProgress?: (percent: number) => void,
	channelMode: ChannelMode = CHANNEL_MODE_SOURCE,
): Promise<ArrayBuffer> {
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
	// Resolve the mono processing hook first: it decides remux
	// eligibility below. Source-layout conversions do not need channel
	// metadata at all. Every mono mode is already satisfied by a
	// one-channel input, including a right-channel pick (which falls
	// back to that only channel), so a no-op transcode is unnecessary.
	let monoProcess: ((sample: AudioSample) => AudioSample) | null = null;
	if (channelMode !== CHANNEL_MODE_SOURCE) {
		const sourceChannels = await audioTrack.getNumberOfChannels();
		if (sourceChannels > 1 && channelMode === CHANNEL_MODE_MONO_MIX) {
			monoProcess = averageChannelsSample;
		} else if (sourceChannels > 1) {
			const pick = monoPickIndex(channelMode, sourceChannels);
			if (pick !== null) {
				monoProcess = (sample: AudioSample): AudioSample =>
					extractChannelSample(sample, pick);
			}
		}
	}

	const inputCodec = await audioTrack.getCodec();
	// PCM targets are uncompressed: a bitrate option is invalid there
	const isPcmTarget = codec.startsWith('pcm-');
	// A mono hook forces a transcode inside mediabunny, so the packet
	// copy is off the table and the bitrate must be sent along -
	// otherwise the forced re-encode would run at mediabunny's default
	// quality instead of the configured one
	const remuxEligible =
		allowRemux && inputCodec === codec && monoProcess === null;
	let audio: ConversionAudioOptions =
		remuxEligible || isPcmTarget ? { codec } : { codec, bitrate };
	if (monoProcess) {
		audio = {
			...audio,
			process: monoProcess,
			processedNumberOfChannels: 1,
		};
	}
	const conversion = await Conversion.init({
		input,
		output,
		audio,
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
