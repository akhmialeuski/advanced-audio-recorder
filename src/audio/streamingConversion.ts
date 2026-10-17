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
	Quality,
} from 'mediabunny';
import type { AudioCodec, ConversionAudioOptions } from 'mediabunny';
import {
	ensureEncoderRegistered,
	createOutputFormat,
	encodableSampleRate,
} from './AudioEncoder';
import { getFormatDescriptor } from './formatRegistry';
import { ChannelMode, monoPickIndex } from './downmix';
import { disposableOf } from '../utils/disposables';
import { PLUGIN_LOG_PREFIX } from '../constants';

/** A conversion written at another sample rate than its source has. */
export interface SampleRateChange {
	/** Rate of the source, in Hz. */
	readonly from: number;
	/** Rate the converted file is written at, in Hz. */
	readonly to: number;
}

/**
 * What a conversion produced, in whatever shape its caller holds files in.
 *
 * One type from the streaming core up to the conversion ladder, so the rate
 * change travels with the file through the worker and every step instead of
 * being restated beside each of them.
 */
export interface ConvertedAudio<T> {
	/** The converted file. */
	readonly data: T;
	/**
	 * Set when the encoder refused the source's rate and the file was written
	 * at another, null when it keeps the source's rate.
	 */
	readonly sampleRateChange: SampleRateChange | null;
}

/**
 * How far a copied stream may be shifted to start at zero, in seconds.
 *
 * Wide enough for any codec's priming - AAC's 2112 samples are under a tenth
 * of a second even at 22.05 kHz, Opus pre-skip at most 80 ms - and narrow
 * enough that a stream starting later than that, which is a recording with a
 * real gap at its head, is transcoded rather than shifted over the gap.
 */
const REMUX_SHIFT_TOLERANCE_SECONDS = 0.25;

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
 * PCM capture worklet and downmixChannelData.
 *
 * Mediabunny's own `numberOfChannels: 1` is not a substitute, not even for
 * stereo, where its mixer computes the same 0.5 * (L + R). The remix runs
 * inside its resampler, which interpolates every output frame between two
 * source frames at a position computed in floating point, so at an unchanged
 * rate the fraction is a rounding residue rather than zero: measured against
 * this hook, about one sample in ten comes out one float32 step away. The
 * resampler also cuts the stream into buffers of its own and sums decoded
 * samples whose timestamps overlap, where this hook passes each one through
 * as it was decoded. Beyond two channels it follows the Web Audio speaker
 * rules instead, which weight 5.1 layouts and drop the LFE. Exported for
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
 * @returns The converted file, with the rate it was written at when that is
 *   not the source's
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
	channelMode: ChannelMode = ChannelMode.Source,
): Promise<ConvertedAudio<ArrayBuffer>> {
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
	channelMode: ChannelMode = ChannelMode.Source,
): Promise<ConvertedAudio<ArrayBuffer>> {
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
	if (channelMode !== ChannelMode.Source) {
		const sourceChannels = await audioTrack.getNumberOfChannels();
		if (sourceChannels > 1 && channelMode === ChannelMode.MonoMix) {
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
	// The bitrate is asked through Quality, as the offline encoder asks it:
	// mediabunny deprecated the bare field, and any quality still forces the
	// re-encode the remux rule above relies on.
	let audio: ConversionAudioOptions = { codec };
	let sampleRateChange: SampleRateChange | null = null;
	if (!remuxEligible && !isPcmTarget) {
		const quality = new Quality({ bitrate });
		audio = { codec, quality };
		const sourceRate = await audioTrack.getSampleRate();
		// The encoder is handed what the mono hook returns, so that is the
		// channel count it is asked about.
		const numberOfChannels = monoProcess
			? 1
			: await audioTrack.getNumberOfChannels();
		const rate = await encodableSampleRate(codec, {
			numberOfChannels,
			sampleRate: sourceRate,
			quality,
		});
		if (rate === null) {
			// Conversion then falls back to its own fixed layout, stereo at
			// 48 kHz, which nothing here can name in advance or report.
			console.warn(
				`${PLUGIN_LOG_PREFIX} The ${targetFormat} encoder takes no standard rate for a ${String(numberOfChannels)}-channel layout; mediabunny will choose the layout.`,
			);
		} else if (rate !== sourceRate) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The ${targetFormat} encoder does not take ${String(sourceRate)} Hz; converting at ${String(rate)} Hz instead.`,
			);
			audio = { ...audio, sampleRate: rate };
			sampleRateChange = { from: sourceRate, to: rate };
		}
	}
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
		// A copy into a container that stamps no time on its frames - ADTS,
		// MP3, FLAC, WAV - has to start at zero, and a codec's priming puts the
		// first packet a little before it: AAC behind an edit list, which is
		// how iOS records. Refused, the copy silently became a transcode at
		// mediabunny's default quality rather than the session's bitrate.
		// Shifting the whole stream onto zero moves nothing relative to
		// anything else in a one-track file.
		copy: { shiftTolerance: REMUX_SHIFT_TOLERANCE_SECONDS },
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
	// Reported with the bytes rather than when the rate is chosen, so a
	// conversion that fails after choosing it says nothing about a file it
	// never wrote.
	return { data: resultBuffer, sampleRateChange };
}
