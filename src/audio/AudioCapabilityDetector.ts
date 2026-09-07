/**
 * Runtime audio capability detection for MediaRecorder support.
 * Probes the browser for supported formats, sample rates, and validates
 * recording configurations before use.
 * @module audio/AudioCapabilityDetector
 */

import {
	FORMAT_WAV,
	FORMAT_WEBM,
	FORMAT_MP4,
	MIME_TYPE_AUDIO_PREFIX,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
} from '../constants';
import { probeOfflineEncodingSupport } from './AudioEncoder';
import { isPcmWavCaptureSupported } from '../platform/capabilities';
import {
	AUDIO_FORMAT_IDS,
	COMPRESSED_INTERMEDIATE_FORMATS,
	MEDIA_RECORDER_CANDIDATE_FORMATS,
	getFormatDescriptor,
	type AudioFormatId,
} from './formatRegistry';

const CANDIDATE_FORMATS = MEDIA_RECORDER_CANDIDATE_FORMATS;

const COMPRESSED_INTERMEDIATES = COMPRESSED_INTERMEDIATE_FORMATS;

const CANDIDATE_SAMPLE_RATES = [
	8000, 16000, 22050, 44100, 48000,
] as const satisfies readonly number[];
// The low end exists for mono speech: Opus at 24 kbps stays intelligible and
// keeps an hour of meeting inside the 25 MB a single Whisper request accepts.
// Not every codec reaches down here, which is what minBitrate settles.
const CANDIDATE_BITRATES_BPS = [
	24000, 32000, 48000, 64000, 96000, 128000, 160000, 192000, 256000, 320000,
] as const satisfies readonly number[];

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

/**
 * The MIME type MediaRecorder accepts for recording this format
 * directly, or null when it cannot. Probes the plain `audio/<ext>`
 * MIME first (certain Chromium builds require it), then the registry's
 * canonical container MIME - iOS WKWebView answers true only for
 * `audio/mp4`, which also covers m4a: the recording is an MP4
 * container saved with the .m4a extension, which is exactly what an
 * m4a file is.
 * @param format - Audio format identifier
 * @returns The MIME type to record with, or null
 */
export function directRecordingMimeType(format: string): string | null {
	if (typeof MediaRecorder === 'undefined') {
		return null;
	}
	const plain = buildMimeType(format);
	if (MediaRecorder.isTypeSupported(plain)) {
		return plain;
	}
	const canonical = getFormatDescriptor(format)?.mime;
	if (
		canonical &&
		canonical !== plain &&
		MediaRecorder.isTypeSupported(canonical)
	) {
		return canonical;
	}
	return null;
}

/**
 * Detects which audio formats can actually be recorded here: directly
 * by MediaRecorder, or through a recordable intermediate followed by a
 * probed offline encode. Async because encoder support is probed for
 * real (see {@link probeOfflineEncodingSupport}), not guessed from the
 * presence of a WebCodecs global.
 * @returns Array of supported format strings
 */
export async function detectSupportedFormats(): Promise<string[]> {
	const supported: string[] = [];

	for (const format of CANDIDATE_FORMATS) {
		if (directRecordingMimeType(format) !== null) {
			supported.push(format);
		}
	}

	// WAV is available via direct PCM capture where the platform allows
	// it (desktop), and everywhere a compressed intermediate can be
	// recorded and offline-converted afterwards (mobile)
	const hasCompressedIntermediate = COMPRESSED_INTERMEDIATES.some((format) =>
		MediaRecorder.isTypeSupported(buildMimeType(format)),
	);
	const hasPcmCapture =
		isPcmWavCaptureSupported() && typeof AudioContext !== 'undefined';
	if (hasPcmCapture || hasCompressedIntermediate) {
		supported.push(FORMAT_WAV);
	}

	// A format that MediaRecorder cannot produce directly is reachable
	// through an intermediate recording plus an offline encode - when
	// the encoder genuinely works here
	if (hasCompressedIntermediate) {
		for (const format of AUDIO_FORMAT_IDS) {
			if (format === FORMAT_WAV || supported.includes(format)) {
				continue;
			}
			if (await probeOfflineEncodingSupport(format)) {
				supported.push(format);
			}
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
 * Bitrates offered for a format, floored by what its codec encodes at the
 * given sample rate. Called without a format it returns every candidate,
 * which is what the diagnostics report asks for.
 * @param format - Target audio format, or undefined for every candidate
 * @param sampleRate - Rate the encoder will write at. Defaults to the
 *   plugin's own default, the conservative case for a caller that does not
 *   know the rate its source carries.
 * @returns Array of reachable bitrates in bps, ascending
 */
export function getSupportedBitrates(
	format?: string,
	sampleRate: number = DEFAULT_SAMPLE_RATE,
): number[] {
	const floor = format
		? (getFormatDescriptor(format)?.minBitrate(sampleRate) ?? 0)
		: 0;
	return CANDIDATE_BITRATES_BPS.filter((bps) => bps >= floor);
}

/**
 * The bitrate a format really encodes at: the configured one, lifted to the
 * format's floor.
 *
 * Clamped rather than read straight through, for the reason
 * localWhisperTimeoutMs is: the row that offers only reachable values is not
 * the only way a value reaches the field. A data.json edited by hand, synced
 * from an install on another format, or simply left behind by a format change
 * never passes that row, and the load path fills a missing field from the
 * defaults without normalising any number it does find.
 *
 * What makes an unreachable value worth guarding is that nothing downstream
 * refuses it. LAME lifts a rate its table does not define to the nearest one
 * that it does, without a word, so the file ends up at a bitrate the
 * interface never mentioned.
 * @param format - Format the file will be written in
 * @param bitrate - The configured bitrate in bps
 * @param sampleRate - Rate the encoder will write at
 * @returns The bitrate encoding will really use, in bps
 */
export function effectiveBitrate(
	format: string,
	bitrate: number,
	sampleRate: number = DEFAULT_SAMPLE_RATE,
): number {
	const requested =
		Number.isFinite(bitrate) && bitrate > 0 ? bitrate : DEFAULT_BITRATE;
	return Math.max(
		requested,
		getFormatDescriptor(format)?.minBitrate(sampleRate) ?? 0,
	);
}

/**
 * Validates that a recording configuration is viable. Checks direct
 * MediaRecorder support, and for everything else the pair the indirect
 * path really needs: a recordable intermediate AND a probed working
 * offline encoder for the target format.
 * @param format - Audio format to validate
 * @returns Validation result with diagnostic info
 */
export async function validateRecordingCapability(
	format: string,
): Promise<ValidationResult> {
	if (format === FORMAT_WAV) {
		// WAV records via direct PCM capture where the platform allows it
		// (desktop), or via a compressed intermediate plus offline
		// conversion elsewhere (mobile)
		const hasPcmCapture =
			isPcmWavCaptureSupported() && typeof AudioContext !== 'undefined';
		const hasIntermediate = COMPRESSED_INTERMEDIATES.some((f) =>
			MediaRecorder.isTypeSupported(buildMimeType(f)),
		);
		if (!hasPcmCapture && !hasIntermediate) {
			return {
				valid: false,
				reason: 'WAV output requires direct PCM capture or an intermediate compressed format, but neither is available on this device.',
			};
		}
		return { valid: true, reason: '' };
	}

	if (directRecordingMimeType(format) !== null) {
		return { valid: true, reason: '' };
	}

	// Format not directly recordable - the indirect path needs an
	// intermediate recording format plus a genuinely working encoder
	const hasIntermediate = COMPRESSED_INTERMEDIATES.some((f) =>
		MediaRecorder.isTypeSupported(buildMimeType(f)),
	);
	if (!hasIntermediate) {
		return {
			valid: false,
			reason: `The format "${format}" requires an intermediate recording format, but none of ${COMPRESSED_INTERMEDIATES.join(
				', ',
			)} is supported on this device.`,
		};
	}
	if (await probeOfflineEncodingSupport(format)) {
		return { valid: true, reason: '' };
	}

	return {
		valid: false,
		reason: `The format "${format}" (${buildMimeType(
			format,
		)}) cannot be recorded or encoded on this device.`,
	};
}

/**
 * Availability of one registry format for recording on this device.
 */
export interface FormatAvailabilityEntry {
	/** Registry format id. */
	format: AudioFormatId;
	/** Whether the format can be recorded here (directly or offline). */
	available: boolean;
	/** Whether MediaRecorder records it directly (no offline encoding). */
	direct: boolean;
}

/**
 * Reports the recordability of every registry format on this device, in
 * registry (display) order. The settings UI renders all of them and
 * blocks the unavailable ones, so users see the full format list with
 * the subset their platform supports enabled. Async because encoder
 * support is probed for real.
 * @returns One availability entry per registry format
 */
export async function listFormatAvailability(): Promise<
	FormatAvailabilityEntry[]
> {
	const entries: FormatAvailabilityEntry[] = [];
	for (const format of AUDIO_FORMAT_IDS) {
		entries.push({
			format,
			available: (await validateRecordingCapability(format)).valid,
			direct: directRecordingMimeType(format) !== null,
		});
	}
	return entries;
}

/**
 * Availability of one candidate bitrate for a format on this device.
 */
export interface BitrateAvailabilityEntry {
	/** Candidate bitrate in bps. */
	bitrate: number;
	/** Whether this device's encoder accepts it for the format. */
	available: boolean;
}

/**
 * Reports which of a format's offered bitrates this device's encoder really
 * accepts, in ascending order. AAC is the case this exists for: WebCodecs
 * hands the decision to the platform encoder, so the answer differs between
 * Windows, macOS and iOS and no declaration can stand in for it.
 *
 * It says nothing new about MP3 or FLAC, whose bundled encoders report
 * support without reading the bitrate at all, and it cannot answer where the
 * WebCodecs AudioEncoder is missing, when every entry comes back unavailable.
 * A caller that gets nothing available has learnt nothing and should leave
 * the choice open; the registry's declared floor is the claim that holds in
 * all three cases.
 * @param format - Target audio format
 * @param sampleRate - Rate the encoder will write at
 * @returns One entry per offered bitrate
 */
export async function listBitrateAvailability(
	format: string,
	sampleRate: number = DEFAULT_SAMPLE_RATE,
): Promise<BitrateAvailabilityEntry[]> {
	const entries: BitrateAvailabilityEntry[] = [];
	for (const bitrate of getSupportedBitrates(format, sampleRate)) {
		entries.push({
			bitrate,
			available: await probeOfflineEncodingSupport(format, {
				sampleRate,
				bitrate,
			}),
		});
	}
	return entries;
}

/**
 * The output format a recording session should actually use: the
 * requested (stored) format when this device can record it, otherwise
 * the platform's best recordable format. Keeps a synced or stale
 * preference from silently producing a failed - or worse, corrupt -
 * recording: the session records something that genuinely works here
 * and the caller tells the user about the substitution.
 * @param requested - The stored output format preference
 * @returns The effective format and whether it is a fallback
 * @throws Error when this device cannot record any format at all
 */
export async function resolveEffectiveOutputFormat(
	requested: string,
): Promise<{ format: string; fellBack: boolean; reason: string }> {
	const normalized = requested.toLowerCase();
	const validation = await validateRecordingCapability(normalized);
	if (validation.valid) {
		return { format: normalized, fellBack: false, reason: '' };
	}
	const capabilities = await detectCapabilities();
	const fallback = capabilities.supportedFormats.includes(
		capabilities.defaultFormat,
	)
		? capabilities.defaultFormat
		: capabilities.supportedFormats[0];
	if (!fallback) {
		throw new Error(validation.reason);
	}
	return { format: fallback, fellBack: true, reason: validation.reason };
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
	const codecs = getFormatDescriptor(format)?.probeCodecs;
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
		const codecs = getFormatDescriptor(format)?.probeCodecs ?? [];
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
export async function detectCapabilities(): Promise<AudioCapabilities> {
	const supportedFormats = await detectSupportedFormats();
	const supportedSampleRates = getSupportedSampleRates();
	const supportedBitrates = getSupportedBitrates();

	const defaultFormat = supportedFormats.includes(FORMAT_WEBM)
		? FORMAT_WEBM
		: supportedFormats.includes(FORMAT_MP4)
			? FORMAT_MP4
			: (supportedFormats[0] ?? FORMAT_WEBM);

	return {
		supportedFormats,
		supportedSampleRates,
		supportedBitrates,
		defaultFormat,
		defaultSampleRate: DEFAULT_SAMPLE_RATE,
		defaultBitrate: DEFAULT_BITRATE,
	};
}
