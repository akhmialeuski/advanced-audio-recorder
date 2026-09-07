/**
 * Single source of truth for everything the plugin knows about an audio
 * format: the mediabunny codec and container used to encode it, how it can
 * be produced (MediaRecorder vs offline encoding), which MIME types
 * describe it, and the labels shown in the UI. Adding a format means
 * adding one entry here instead of touching parallel maps across the
 * encoder and the capability detector.
 * @module audio/formatRegistry
 */

import {
	Mp4OutputFormat,
	WebMOutputFormat,
	OggOutputFormat,
	FlacOutputFormat,
	Mp3OutputFormat,
	WavOutputFormat,
} from 'mediabunny';
import type { OutputFormat, AudioCodec } from 'mediabunny';
import {
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_MP4,
	FORMAT_M4A,
	FORMAT_AAC,
	FORMAT_FLAC,
	MIME_TYPE_AUDIO_PREFIX,
} from '../constants';

/**
 * Sample rate at and above which MP3 uses the MPEG-1 Layer III bitrate table.
 * Below it the encoder switches to the MPEG-2 and MPEG-2.5 tables.
 */
const MPEG1_MIN_SAMPLE_RATE = 32000;

/** Lowest bitrate MPEG-1 Layer III defines, in bits per second. */
const MP3_MPEG1_MIN_BITRATE = 32000;

/** Lowest bitrate MPEG-2 and MPEG-2.5 Layer III define, in bits per second. */
const MP3_MPEG2_MIN_BITRATE = 8000;

/** Lowest bitrate the Opus specification defines, in bits per second. */
const OPUS_MIN_BITRATE = 6000;

/**
 * A codec that constrains nothing: a lossless or PCM format, which takes no
 * bitrate at all, or one whose floor only the platform encoder knows. Both
 * leave every candidate bitrate on offer, and what refuses a value is caught
 * by the encoder probe instead.
 * @returns Always zero
 */
const noBitrateFloor = (): number => 0;

/**
 * Opus encodes from 6 kbit/s at every sample rate it accepts (RFC 6716
 * section 2.1.1), so its floor does not move.
 * @returns The Opus floor in bits per second
 */
const opusBitrateFloor = (): number => OPUS_MIN_BITRATE;

/**
 * MP3's floor moves with the sample rate. MPEG-1 Layer III, used at 32 kHz
 * and above, defines nothing below 32 kbit/s, while the MPEG-2 and MPEG-2.5
 * tables used below it start at 8 kbit/s. The bundled LAME bridge pins the
 * output rate to the input rate, so the encoder cannot reach the lower tables
 * on its own: it silently lifts an unreachable request to the nearest rate
 * the table does define.
 * @param sampleRate - Rate the encoder will write at
 * @returns The floor in bits per second
 */
const mp3BitrateFloor = (sampleRate: number): number =>
	sampleRate >= MPEG1_MIN_SAMPLE_RATE
		? MP3_MPEG1_MIN_BITRATE
		: MP3_MPEG2_MIN_BITRATE;

/**
 * Everything the plugin knows about one audio format.
 */
export interface AudioFormatDescriptor {
	/** Mediabunny codec used when encoding to this format. */
	readonly codec: AudioCodec;
	/** Creates the mediabunny container writer for this format. */
	readonly createOutputFormat: () => OutputFormat;
	/** Uncompressed PCM: a bitrate option is invalid for the encoder. */
	readonly isPcm: boolean;
	/**
	 * Lowest bitrate this format's codec encodes at the given sample rate, in
	 * bits per second. Zero means the format declares no floor of its own,
	 * which covers both a format that takes no bitrate and one whose floor the
	 * platform encoder settles and the bitrate row probes for.
	 */
	readonly minBitrate: (sampleRate: number) => number;
	/**
	 * Encoding goes through the WebCodecs AudioEncoder global; offline
	 * encoding to this format is unavailable when the global is missing.
	 */
	readonly requiresWebCodecs: boolean;
	/** Reachable only via offline encoding, never as a recorder format. */
	readonly offlineOnly: boolean;
	/** Probed as a direct MediaRecorder recording candidate. */
	readonly mediaRecorderCandidate: boolean;
	/**
	 * Compressed format usable as the intermediate recording container
	 * when the target format itself cannot be recorded directly.
	 */
	readonly compressedIntermediate: boolean;
	/** MediaRecorder codec strings probed for the diagnostics matrix. */
	readonly probeCodecs: readonly string[];
	/**
	 * Canonical container MIME type used for uploads and file analysis
	 * (mp3 maps to audio/mpeg). Distinct from the plain probing MIME
	 * built by buildMimeType (audio/mp3), which certain Chromium builds
	 * require for MediaRecorder.isTypeSupported checks.
	 */
	readonly mime: string;
	/** Codec label shown in the audio file info modal. */
	readonly codecLabel: string;
}

/**
 * The format registry. Key order is meaningful: derived candidate lists
 * preserve it, and it determines probing and settings-dropdown order.
 */
export const FORMAT_REGISTRY = {
	[FORMAT_WAV]: {
		codec: 'pcm-s16',
		createOutputFormat: (): OutputFormat => new WavOutputFormat(),
		isPcm: true,
		minBitrate: noBitrateFloor,
		requiresWebCodecs: false,
		offlineOnly: false,
		mediaRecorderCandidate: false,
		compressedIntermediate: false,
		probeCodecs: [],
		mime: `${MIME_TYPE_AUDIO_PREFIX}wav`,
		codecLabel: 'pcm',
	},
	[FORMAT_WEBM]: {
		codec: 'opus',
		createOutputFormat: (): OutputFormat => new WebMOutputFormat(),
		isPcm: false,
		minBitrate: opusBitrateFloor,
		requiresWebCodecs: true,
		offlineOnly: false,
		mediaRecorderCandidate: true,
		compressedIntermediate: true,
		probeCodecs: ['opus', 'vorbis', 'pcm'],
		mime: `${MIME_TYPE_AUDIO_PREFIX}webm`,
		codecLabel: 'opus',
	},
	[FORMAT_OGG]: {
		codec: 'opus',
		createOutputFormat: (): OutputFormat => new OggOutputFormat(),
		isPcm: false,
		minBitrate: opusBitrateFloor,
		requiresWebCodecs: true,
		offlineOnly: false,
		mediaRecorderCandidate: true,
		compressedIntermediate: true,
		probeCodecs: ['opus', 'vorbis'],
		mime: `${MIME_TYPE_AUDIO_PREFIX}ogg`,
		codecLabel: 'opus/vorbis',
	},
	[FORMAT_MP3]: {
		codec: 'mp3',
		createOutputFormat: (): OutputFormat => new Mp3OutputFormat(),
		isPcm: false,
		minBitrate: mp3BitrateFloor,
		requiresWebCodecs: false,
		offlineOnly: true,
		mediaRecorderCandidate: true,
		compressedIntermediate: false,
		probeCodecs: ['mp3'],
		mime: `${MIME_TYPE_AUDIO_PREFIX}mpeg`,
		codecLabel: 'mp3',
	},
	[FORMAT_M4A]: {
		codec: 'aac',
		createOutputFormat: (): OutputFormat => new Mp4OutputFormat(),
		isPcm: false,
		minBitrate: noBitrateFloor,
		requiresWebCodecs: true,
		offlineOnly: false,
		mediaRecorderCandidate: true,
		compressedIntermediate: false,
		probeCodecs: ['mp4a.40.2', 'mp4a.40.5'],
		mime: `${MIME_TYPE_AUDIO_PREFIX}mp4`,
		codecLabel: 'aac',
	},
	[FORMAT_MP4]: {
		codec: 'aac',
		createOutputFormat: (): OutputFormat => new Mp4OutputFormat(),
		isPcm: false,
		minBitrate: noBitrateFloor,
		requiresWebCodecs: true,
		offlineOnly: false,
		mediaRecorderCandidate: true,
		// iOS WKWebView's MediaRecorder supports neither WebM nor OGG -
		// audio/mp4 (AAC) is its only container, so mp4 must be usable as
		// the intermediate for WAV and the offline-only formats there.
		// Listed after webm/ogg (registry order), so platforms that can
		// record opus keep preferring it.
		compressedIntermediate: true,
		probeCodecs: ['mp4a.40.2', 'mp4a.40.5', 'opus'],
		mime: `${MIME_TYPE_AUDIO_PREFIX}mp4`,
		codecLabel: 'aac',
	},
	[FORMAT_FLAC]: {
		codec: 'flac',
		createOutputFormat: (): OutputFormat => new FlacOutputFormat(),
		isPcm: false,
		minBitrate: noBitrateFloor,
		requiresWebCodecs: false,
		offlineOnly: true,
		mediaRecorderCandidate: false,
		compressedIntermediate: false,
		probeCodecs: [],
		mime: `${MIME_TYPE_AUDIO_PREFIX}flac`,
		codecLabel: 'flac',
	},
	[FORMAT_AAC]: {
		codec: 'aac',
		createOutputFormat: (): OutputFormat => new Mp4OutputFormat(),
		isPcm: false,
		minBitrate: noBitrateFloor,
		requiresWebCodecs: true,
		offlineOnly: true,
		mediaRecorderCandidate: false,
		compressedIntermediate: false,
		probeCodecs: [],
		mime: `${MIME_TYPE_AUDIO_PREFIX}aac`,
		codecLabel: 'aac',
	},
} as const satisfies Record<string, AudioFormatDescriptor>;

/** A format id known to the registry. */
export type AudioFormatId = keyof typeof FORMAT_REGISTRY;

/** All registered format ids, in registry (probing/display) order. */
export const AUDIO_FORMAT_IDS = Object.keys(
	FORMAT_REGISTRY,
) as readonly AudioFormatId[];

/**
 * Looks up the descriptor for a format id or file extension.
 * @param format - Format id or lowercased file extension
 * @returns The descriptor, or undefined for unknown formats
 */
export function getFormatDescriptor(
	format: string,
): AudioFormatDescriptor | undefined {
	return (FORMAT_REGISTRY as Record<string, AudioFormatDescriptor>)[format];
}

/**
 * Resolves the canonical container MIME type for a file extension,
 * defaulting to `audio/<ext>` for anything not in the registry.
 * @param extension - Lowercased file extension
 * @returns Container MIME type string
 */
export function audioMimeForExtension(extension: string): string {
	return (
		getFormatDescriptor(extension)?.mime ??
		`${MIME_TYPE_AUDIO_PREFIX}${extension}`
	);
}

/** Formats probed as direct MediaRecorder candidates, in registry order. */
export const MEDIA_RECORDER_CANDIDATE_FORMATS: readonly AudioFormatId[] =
	AUDIO_FORMAT_IDS.filter((id) => FORMAT_REGISTRY[id].mediaRecorderCandidate);

/** Compressed formats usable as recording intermediates. */
export const COMPRESSED_INTERMEDIATE_FORMATS: readonly AudioFormatId[] =
	AUDIO_FORMAT_IDS.filter((id) => FORMAT_REGISTRY[id].compressedIntermediate);
