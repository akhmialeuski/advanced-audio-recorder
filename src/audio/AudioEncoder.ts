/**
 * Offline audio encoding module.
 * Converts AudioBuffer to compressed formats using Mediabunny
 * (WebCodecs-backed, with extension encoders for FLAC and MP3).
 * @module audio/AudioEncoder
 */

import {
	Output,
	BufferTarget,
	AudioBufferSource,
	canEncodeAudio,
	Quality,
} from 'mediabunny';
import type { AudioCodec, AudioEncodingConfig, OutputFormat } from 'mediabunny';
import { EncodingError } from '../errors';
import { FORMAT_MP3, FORMAT_FLAC } from '../constants';
import { FORMAT_REGISTRY, getFormatDescriptor } from './formatRegistry';
import { errorMessage } from '../errors';

/**
 * The codec string of AAC-LC, the profile every AAC file this plugin writes is
 * asked for.
 *
 * Left to itself, mediabunny picks the profile from the layout: at 24 kHz and
 * below it builds an HE-AAC string, v2 for stereo and v1 for mono, on the
 * guess that a low rate means a low bitrate. No guess is needed here, since
 * the plugin always wants plain AAC-LC, and the guess cost real files: an
 * encoder without HE-AAC, which is every Chromium build, was asked about a
 * profile it does not have and refused a rate it may well encode as AAC-LC.
 */
const AAC_LC_CODEC_STRING = 'mp4a.40.2';

/** The encoding parameters an encoder is asked about. */
interface EncoderQuestion {
	numberOfChannels?: number;
	sampleRate?: number;
	quality?: Quality;
}

/**
 * The codec string to encode with, when it is not mediabunny's own choice.
 *
 * AAC asks for AAC-LC first. Only where the encoder refuses that does it fall
 * back to the string mediabunny builds, so a platform whose encoder takes an
 * HE-AAC profile at a rate where it refuses AAC-LC still encodes, as it did
 * before; nothing that was encodable stops being so. Every other codec has
 * one string, which mediabunny builds.
 * @param codec - Codec being encoded
 * @param question - Layout, rate and quality of the encode
 * @returns The extra encoding option, or nothing to leave the choice alone
 */
async function codecStringFor(
	codec: AudioCodec,
	question: EncoderQuestion,
): Promise<{ fullCodecString?: string }> {
	if (codec !== 'aac') {
		return {};
	}
	const lowComplexity = { fullCodecString: AAC_LC_CODEC_STRING };
	return (await canEncodeAudio(codec, { ...question, ...lowComplexity }))
		? lowComplexity
		: {};
}

/**
 * Options for offline audio encoding.
 */
export interface EncodingOptions {
	/** Target audio format. */
	format: string;
	/** Bitrate in bits per second. */
	bitrate: number;
}

/**
 * Progress callback receiving percentage (0-100).
 */
export type ProgressCallback = (percent: number) => void;

/**
 * Creates the appropriate Mediabunny OutputFormat for the given format.
 */
export function createOutputFormat(format: string): OutputFormat {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		throw new EncodingError(`No output format for "${format}"`, format);
	}
	return descriptor.createOutputFormat();
}

/**
 * Ensures the encoder for the given format is available, registering
 * the Mediabunny extension encoder (FLAC, MP3) when the platform has
 * no native WebCodecs support. The canEncodeAudio guard makes repeat
 * calls no-ops: a registered extension encoder counts as encodable.
 * @param format - Target audio format
 */
export async function ensureEncoderRegistered(format: string): Promise<void> {
	if (
		format === FORMAT_FLAC &&
		!(await canEncodeAudio(FORMAT_REGISTRY[FORMAT_FLAC].codec))
	) {
		const { registerFlacEncoder } =
			await import('@mediabunny/flac-encoder');
		registerFlacEncoder();
	}
	if (
		format === FORMAT_MP3 &&
		!(await canEncodeAudio(FORMAT_REGISTRY[FORMAT_MP3].codec))
	) {
		const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
		registerMp3Encoder();
	}
}

/**
 * Encodes an AudioBuffer to the specified format.
 * Routes to the appropriate encoder based on format.
 * @param buffer - Source AudioBuffer to encode
 * @param options - Encoding configuration
 * @param onProgress - Optional progress callback (0-100)
 * @returns Blob containing the encoded audio
 */
export async function encodeAudioBuffer(
	buffer: AudioBuffer,
	options: EncodingOptions,
	onProgress?: ProgressCallback,
): Promise<Blob> {
	const { format } = options;

	if (getFormatDescriptor(format)) {
		return encodeWithMediabunny(buffer, options, onProgress);
	}

	throw new EncodingError(`Unsupported format: ${format}`, format);
}

/**
 * The encoder configuration for one format at one bitrate, for audio of a
 * known layout and rate. Shared by every encode the plugin feeds itself - a
 * decoded buffer here, decoded samples in the streamed split - so they ask
 * the encoder the same question the probe asked.
 *
 * PCM is uncompressed: passing a bitrate is invalid for it. The rest ask
 * through Quality, the field mediabunny still supports - its bare `bitrate`
 * is deprecated, and phrasing the encode differently from the probe in
 * probeOfflineEncodingSupport is what lets the two drift. The codec string is
 * settled the same way the probe settles it, on the layout and rate the audio
 * really has.
 * @param format - Target audio format
 * @param bitrate - Bitrate in bits per second, ignored for PCM
 * @param layout - Channels and sample rate of the audio being encoded
 * @returns The configuration for a mediabunny audio source
 * @throws EncodingError for a format the registry does not know
 */
export async function encodingConfigFor(
	format: string,
	bitrate: number,
	layout: { numberOfChannels: number; sampleRate: number },
): Promise<AudioEncodingConfig> {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		throw new EncodingError(`No codec mapping for "${format}"`, format);
	}
	const { codec } = descriptor;
	if (descriptor.isPcm) {
		return { codec };
	}
	const quality = new Quality({ bitrate });
	return {
		codec,
		quality,
		...(await codecStringFor(codec, { ...layout, quality })),
	};
}

/**
 * Encodes AudioBuffer using Mediabunny (WebCodecs-backed for Opus/AAC,
 * extension-backed for FLAC and MP3).
 */
async function encodeWithMediabunny(
	buffer: AudioBuffer,
	options: EncodingOptions,
	onProgress?: ProgressCallback,
): Promise<Blob> {
	const { format, bitrate } = options;

	try {
		await ensureEncoderRegistered(format);

		const outputFormat = createOutputFormat(format);
		const target = new BufferTarget();
		const output = new Output({ format: outputFormat, target });

		const audioSource = new AudioBufferSource(
			await encodingConfigFor(format, bitrate, {
				numberOfChannels: buffer.numberOfChannels,
				sampleRate: buffer.sampleRate,
			}),
		);
		output.addAudioTrack(audioSource);

		await output.start();
		onProgress?.(10);

		await audioSource.add(buffer);
		onProgress?.(80);

		await output.finalize();
		onProgress?.(100);

		const mimeType = `audio/${format}`;
		const resultBuffer = target.buffer;
		if (!resultBuffer) {
			throw new EncodingError('Encoding produced no output', format);
		}
		return new Blob([resultBuffer], { type: mimeType });
	} catch (error) {
		if (error instanceof EncodingError) {
			throw error;
		}
		throw new EncodingError(errorMessage(error), format, error);
	}
}

/**
 * Synchronous heuristic for offline-encoding support: WAV always, MP3
 * and FLAC through the bundled extension encoders, WebCodecs formats
 * when the AudioEncoder global exists. The global alone does not prove
 * the codec is encodable (a browser may ship WebCodecs without an AAC
 * or Opus encoder), so this is only for cosmetic decisions - extension
 * pickers and description labels - where a wrong guess degrades to a
 * handled runtime error. Anything that ADVERTISES recordability (the
 * settings format list, recording-start validation) must use
 * {@link probeOfflineEncodingSupport} instead.
 * @param format - Audio format to check
 * @returns true if offline encoding to this format is plausible
 */
export function isOfflineEncodingSupported(format: string): boolean {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		return false;
	}
	if (descriptor.requiresWebCodecs) {
		return typeof AudioEncoder !== 'undefined';
	}
	return true;
}

/**
 * Definitive offline-encoding probe: registers the bundled extension
 * encoder for the format when needed, then asks Mediabunny whether the
 * format's codec is actually encodable here - for WebCodecs codecs
 * that includes the browser's own `isConfigSupported` answer, so a
 * WebView that ships the AudioEncoder global without an AAC or Opus
 * encoder is reported honestly. This is the source of truth behind
 * every recordability claim.
 *
 * The encoding parameters are optional because the codec question comes
 * first: a caller asking whether a format is recordable at all leaves them
 * out and gets the same answer it always did. A caller asking whether one
 * bitrate is reachable passes them, which is the only way to learn what a
 * platform AAC encoder accepts.
 * @param format - Audio format to check
 * @param quality - Encoding parameters to ask about, codec alone when absent
 * @returns Whether offline encoding to this format will actually work
 */
export async function probeOfflineEncodingSupport(
	format: string,
	quality?: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number;
	},
): Promise<boolean> {
	const descriptor = getFormatDescriptor(format);
	if (!descriptor) {
		return false;
	}
	try {
		await ensureEncoderRegistered(format);
		const { bitrate, ...dimensions } = quality ?? {};
		const question: EncoderQuestion = {
			...dimensions,
			// PCM is uncompressed, so nothing is asked about its bitrate,
			// the same veto encodeAudioBuffer applies.
			...(descriptor.isPcm || bitrate === undefined
				? {}
				: { quality: new Quality({ bitrate }) }),
		};
		// An encoder that takes AAC-LC has answered; only one that refuses it
		// is asked about mediabunny's own profile, exactly as the encode
		// falls back.
		if (
			(await codecStringFor(descriptor.codec, question)).fullCodecString
		) {
			return true;
		}
		return await canEncodeAudio(descriptor.codec, question);
	} catch {
		// A failed registration or probe means encoding cannot work
		return false;
	}
}
