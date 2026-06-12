/**
 * Runtime audio capability detection for MediaRecorder support.
 * Probes the browser for supported formats, sample rates, and validates
 * recording configurations before use.
 * @module recording/AudioCapabilityDetector
 */

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
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
} from '../constants';
import { isOfflineEncodingSupported } from './AudioEncoder';

const CANDIDATE_FORMATS = [
	FORMAT_WEBM,
	FORMAT_OGG,
	FORMAT_MP3,
	FORMAT_M4A,
	FORMAT_MP4,
];

/** Candidate codecs to probe per container format. */
const FORMAT_CODECS: Record<string, string[]> = {
	[FORMAT_WEBM]: ['opus', 'vorbis', 'pcm'],
	[FORMAT_OGG]: ['opus', 'vorbis'],
	[FORMAT_MP4]: ['mp4a.40.2', 'mp4a.40.5', 'opus'],
	[FORMAT_M4A]: ['mp4a.40.2', 'mp4a.40.5'],
	[FORMAT_MP3]: ['mp3'],
};
const COMPRESSED_INTERMEDIATES = [FORMAT_WEBM, FORMAT_OGG];

const CANDIDATE_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000];
const CANDIDATE_BITRATES_BPS = [
	64000, 96000, 128000, 160000, 192000, 256000, 320000,
];

/**
 * Result of a full capability detection.
 */
export interface AudioCapabilities {
	/** Formats the browser can record to directly. */
	supportedFormats: string[];
	/** Sample rates the browser accepts. */
	supportedSampleRates: number[];
	/** Bitrates available for compressed recording. */
	supportedBitrates: number[];
	/** Best default format for the current environment. */
	defaultFormat: string;
	/** Default sample rate. */
	defaultSampleRate: number;
	/** Default bitrate in bps. */
	defaultBitrate: number;
}

/**
 * Codec probing result for a single codec variant.
 */
export interface CodecVariantEntry {
	/** Codec identifier (e.g. 'opus', 'mp4a.40.2'). */
	codec: string;
	/** Full MIME type string with codec suffix. */
	mimeType: string;
	/** Whether MediaRecorder.isTypeSupported() returns true for this variant. */
	supported: boolean;
}

/**
 * Codec support report for a single container format.
 */
export interface CodecSupportEntry {
	/** Plain MIME type without codec suffix (e.g. 'audio/webm'). */
	mimeType: string;
	/** Whether the plain MIME type is supported. */
	supported: boolean;
	/** Per-codec variant probing results. */
	withCodecs: CodecVariantEntry[];
}

/**
 * Diagnostic result from a pre-recording validation.
 */
export interface ValidationResult {
	/** Whether the configuration is viable. */
	valid: boolean;
	/** Human-readable reason when invalid. */
	reason: string;
}

/**
 * Builds a plain MIME type string for the given format.
 * Does NOT append codec suffixes to avoid silent recording bugs
 * in certain Chromium/Electron builds.
 * @param format - Audio format identifier (e.g. 'webm', 'ogg')
 * @returns Plain MIME type string
 */
export function buildMimeType(format: string): string {
	return `${MIME_TYPE_AUDIO_PREFIX}${format}`;
}

/** Formats available only via offline encoding (not MediaRecorder). */
const OFFLINE_ONLY_FORMATS = [FORMAT_MP3, FORMAT_FLAC, FORMAT_AAC];

/**
 * Detects which audio formats the current browser supports
 * for MediaRecorder output or offline encoding.
 * @returns Array of supported format strings
 */
export function detectSupportedFormats(): string[] {
	const supported: string[] = [];

	for (const format of CANDIDATE_FORMATS) {
		const mimeType = buildMimeType(format);
		if (MediaRecorder.isTypeSupported(mimeType)) {
			supported.push(format);
		}
	}

	// WAV is always available on desktop via direct PCM capture,
	// and available on mobile if a compressed intermediate is supported
	const hasCompressedIntermediate = COMPRESSED_INTERMEDIATES.some((format) =>
		MediaRecorder.isTypeSupported(buildMimeType(format)),
	);
	const hasAudioContext = typeof AudioContext !== 'undefined';
	if (hasAudioContext || hasCompressedIntermediate) {
		supported.push(FORMAT_WAV);
	}

	// Add offline-only formats if their encoder is available
	// and they weren't already added via MediaRecorder support
	for (const format of OFFLINE_ONLY_FORMATS) {
		if (!supported.includes(format) && isOfflineEncodingSupported(format)) {
			supported.push(format);
		}
	}

	return supported;
}

/**
 * Returns the list of candidate sample rates.
 * All standard rates are returned since getUserMedia
 * will silently fall back to the closest supported rate.
 * @returns Array of sample rates in Hz
 */
export function getSupportedSampleRates(): number[] {
	return [...CANDIDATE_SAMPLE_RATES];
}

/**
 * Returns the list of candidate bitrates.
 * @returns Array of bitrates in bps
 */
export function getSupportedBitrates(): number[] {
	return [...CANDIDATE_BITRATES_BPS];
}

/**
 * Validates that a recording configuration is viable.
 * Checks MediaRecorder format support and offline encoding availability.
 * @param format - Audio format to validate
 * @returns Validation result with diagnostic info
 */
export function validateRecordingCapability(format: string): ValidationResult {
	if (format === FORMAT_WAV) {
		// WAV is available via direct PCM capture (AudioContext) on desktop,
		// or via compressed intermediate on mobile
		const hasAudioContext = typeof AudioContext !== 'undefined';
		const hasIntermediate = COMPRESSED_INTERMEDIATES.some((f) =>
			MediaRecorder.isTypeSupported(buildMimeType(f)),
		);
		if (!hasAudioContext && !hasIntermediate) {
			return {
				valid: false,
				reason: 'WAV output requires AudioContext or an intermediate compressed format, but neither is available in this browser.',
			};
		}
		return { valid: true, reason: '' };
	}

	const mimeType = buildMimeType(format);
	if (MediaRecorder.isTypeSupported(mimeType)) {
		return { valid: true, reason: '' };
	}

	// Format not supported by MediaRecorder — check if offline encoding
	// is available and an intermediate recording format exists
	if (isOfflineEncodingSupported(format)) {
		const hasIntermediate = COMPRESSED_INTERMEDIATES.some((f) =>
			MediaRecorder.isTypeSupported(buildMimeType(f)),
		);
		if (hasIntermediate) {
			return { valid: true, reason: '' };
		}
		return {
			valid: false,
			reason: `The format "${format}" requires offline encoding with an intermediate recording format, but neither WebM nor OGG is supported.`,
		};
	}

	return {
		valid: false,
		reason: `The format "${format}" (${mimeType}) is not supported for recording in this browser.`,
	};
}

/**
 * Attempts to predict the codec that the browser will use for the
 * given format by probing codec variants in order of preference.
 * @param format - Audio format (e.g. 'webm', 'mp4')
 * @returns The expected codec string (e.g. 'opus', 'mp4a.40.2'), or undefined
 */
export function getExpectedCodec(format: string): string | undefined {
	if (typeof MediaRecorder === 'undefined') {
		return undefined;
	}
	const codecs = FORMAT_CODECS[format];
	if (!codecs || codecs.length === 0) {
		return undefined;
	}
	const plainMime = buildMimeType(format);
	for (const codec of codecs) {
		if (MediaRecorder.isTypeSupported(`${plainMime};codecs=${codec}`)) {
			return codec;
		}
	}
	return undefined;
}

/**
 * Probes MediaRecorder codec support for all candidate formats.
 * For each container format, tests the plain MIME type and each
 * codec variant to produce a complete support matrix.
 * @returns Array of codec support entries per format
 */
export function detectCodecSupport(): CodecSupportEntry[] {
	return CANDIDATE_FORMATS.map((format) => {
		const plainMime = buildMimeType(format);
		const supported =
			typeof MediaRecorder !== 'undefined'
				? MediaRecorder.isTypeSupported(plainMime)
				: false;
		const codecs = FORMAT_CODECS[format] ?? [];
		const withCodecs: CodecVariantEntry[] = codecs.map((codec) => {
			const mimeType = `${plainMime};codecs=${codec}`;
			return {
				codec,
				mimeType,
				supported:
					typeof MediaRecorder !== 'undefined'
						? MediaRecorder.isTypeSupported(mimeType)
						: false,
			};
		});
		return { mimeType: plainMime, supported, withCodecs };
	});
}

/**
 * Detects all audio capabilities of the current environment.
 * @returns Full capability report
 */
export function detectCapabilities(): AudioCapabilities {
	const supportedFormats = detectSupportedFormats();
	const supportedSampleRates = getSupportedSampleRates();
	const supportedBitrates = getSupportedBitrates();

	const defaultFormat = supportedFormats.includes(FORMAT_WEBM)
		? FORMAT_WEBM
		: supportedFormats.includes(FORMAT_MP4)
			? FORMAT_MP4
			: supportedFormats.length > 0
				? supportedFormats[0]
				: FORMAT_WEBM;

	return {
		supportedFormats,
		supportedSampleRates,
		supportedBitrates,
		defaultFormat,
		defaultSampleRate: DEFAULT_SAMPLE_RATE,
		defaultBitrate: DEFAULT_BITRATE,
	};
}
