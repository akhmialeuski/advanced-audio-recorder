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
import {
	isOfflineEncodingSupported,
	probeOfflineEncodingSupport,
} from './AudioEncoder';
import { isPcmWavCaptureSupported } from '../platform/capabilities';
import {
	AUDIO_FORMAT_IDS,
	COMPRESSED_INTERMEDIATE_FORMATS,
	MEDIA_RECORDER_CANDIDATE_FORMATS,
	getFormatDescriptor,
	takesBitrate,
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
 * The audio an encoder will be handed, as far as that decides what it accepts.
 * A platform encoder answers per sample rate and per channel layout, and for
 * AAC mediabunny even picks the codec profile from the two, so a capability
 * question asked without them is asked about a different file.
 */
export interface EncodingDimensions {
	readonly sampleRate: number;
	readonly numberOfChannels: number;
}

/**
 * What a recording session will hand the encoder, for validating a format
 * against it before the first sample is captured.
 *
 * One session is described by one encoding, which is exact for the single
 * file a merged session writes and an upper bound for a session writing its
 * tracks separately: there `numberOfChannels` is the widest track's layout,
 * while each file is encoded with its own. The two answers can only differ
 * for AAC at 24 kHz and below, where mediabunny asks about HE-AAC v2 for a
 * stereo layout and v1 for a mono one, and no encode this plugin runs reaches
 * that rate - `offlineEncodeSampleRate` reports the device's own, which is
 * 44.1 or 48 kHz on real hardware. Describing each file separately would mean
 * one validation and one bitrate resolution per track for a distinction
 * nothing can currently observe.
 */
export interface RecordingEncoding extends EncodingDimensions {
	/**
	 * Whether the session mixes its tracks into one file. A merged file is
	 * rendered and then encoded by mediabunny even for a format MediaRecorder
	 * records directly, so the direct-recording shortcut does not apply and
	 * the offline encoder has to be asked.
	 */
	readonly mergesTracks: boolean;
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
 * A sample rate as a reader names it: kilohertz without trailing zeros, so
 * 44100 reads as 44.1 and 48000 as 48.
 *
 * Shared because the same rate is named in three sentences a user can see one
 * after the other - the format refusal, the bitrate refusal, and the note
 * under the bitrate row - and rounding it in one of them had 22050 appear as
 * both 22.05 and 22 kHz for one setting.
 * @param sampleRate - Rate in hertz
 * @returns The rate in kHz, as text
 */
export function kilohertz(sampleRate: number): string {
	return String(sampleRate / 1000);
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
 * The offered bitrate closest to a requested one, preferring the higher of two
 * equally distant ones so a tie never costs quality.
 *
 * Exported because snapping happens at two moments that must agree: here, when
 * a stored value is normalised against the format's own tables, and in the
 * bitrate row, when the encoder's answer moves the selection off a rate it
 * refused.
 * @param offered - Candidate bitrates in ascending order
 * @param requested - The bitrate asked for
 * @returns The closest candidate, or the requested value when none is offered
 */
export function closestBitrate(
	offered: readonly number[],
	requested: number,
): number {
	return offered.reduce(
		(closest, bps) =>
			Math.abs(bps - requested) <= Math.abs(closest - requested)
				? bps
				: closest,
		// Seeding with the first candidate keeps the comparison honest and
		// makes an empty list answer with the value asked for, so no caller
		// has to test the list before handing it over.
		offered[0] ?? requested,
	);
}

/**
 * The bitrate a format really encodes at: the configured one, snapped onto the
 * rates offered for that format and sample rate.
 *
 * Normalised rather than read straight through, for the reason
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
 *
 * Snapping to the offered list rather than only lifting to the floor is what
 * keeps one answer everywhere: the dropdown, the output summary and the
 * session snapshot all read this, and a value between two offered rates would
 * otherwise be shown as one thing by the row and encoded as another.
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
	return closestBitrate(getSupportedBitrates(format, sampleRate), requested);
}

/**
 * Validates that a recording configuration is viable. Checks direct
 * MediaRecorder support, and for everything else the pair the indirect
 * path really needs: a recordable intermediate AND a probed working
 * offline encoder for the target format.
 * @param format - Audio format to validate
 * @param encoding - What the session will hand the encoder. Without it only
 *   the codec is asked about, which is all the settings search and the
 *   diagnostics summary need; a session about to record passes it, because a
 *   codec the device has is not a file the device can write at every rate.
 * @returns Validation result with diagnostic info
 */
export async function validateRecordingCapability(
	format: string,
	encoding?: RecordingEncoding,
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

	// A merged session mixes and then encodes offline whatever MediaRecorder
	// could have produced directly, so for it the direct path answers nothing.
	if (!encoding?.mergesTracks && directRecordingMimeType(format) !== null) {
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
	const dimensions = encoding
		? {
				sampleRate: encoding.sampleRate,
				numberOfChannels: encoding.numberOfChannels,
			}
		: undefined;
	if (await probeOfflineEncodingSupport(format, dimensions)) {
		return { valid: true, reason: '' };
	}

	return {
		valid: false,
		reason: encoding
			? `The format "${format}" cannot be encoded at ${kilohertz(
					encoding.sampleRate,
				)} kHz with ${String(encoding.numberOfChannels)} channel${
					encoding.numberOfChannels === 1 ? '' : 's'
				} on this device.`
			: `The format "${format}" (${buildMimeType(
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
	/** Why it cannot be, empty when it can. */
	reason: string;
	/** Whether MediaRecorder records it directly (no offline encoding). */
	direct: boolean;
}

/**
 * Reports the recordability of every registry format on this device, in
 * registry (display) order. The settings UI renders all of them and
 * blocks the unavailable ones, so users see the full format list with
 * the subset their platform supports enabled. Async because encoder
 * support is probed for real.
 * @param encoding - What a session under the current settings will hand the
 *   encoder. Without it every entry answers about the codec alone, which is
 *   what a report describing the device rather than a session asks for.
 * @returns One availability entry per registry format
 */
export async function listFormatAvailability(
	encoding?: RecordingEncoding,
): Promise<FormatAvailabilityEntry[]> {
	const entries: FormatAvailabilityEntry[] = [];
	for (const format of AUDIO_FORMAT_IDS) {
		const validation = await validateRecordingCapability(format, encoding);
		entries.push({
			format,
			available: validation.valid,
			reason: validation.reason,
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
 * support without reading the bitrate at all. Where the WebCodecs
 * AudioEncoder is missing it cannot answer either, and every entry comes back
 * unavailable; a caller must ask {@link isOfflineEncodingSupported} first
 * rather than read that silence as a refusal.
 *
 * The channel layout is stated rather than left to mediabunny's own default of
 * two, because the encoder answers a different question for each: a platform
 * AAC encoder accepts its own set of rates per layout, and mediabunny builds
 * the codec string itself from the count, so at 24 kHz and below two channels
 * ask about HE-AAC v2 while one asks about HE-AAC v1.
 * @param format - Target audio format
 * @param sampleRate - Rate the encoder will write at
 * @param numberOfChannels - Layout the output will have, from
 *   {@link channelCountFor}. Stated rather than defaulted: a default here
 *   would be mediabunny's own, which is what made the probe describe a file
 *   nobody was recording.
 * @returns One entry per offered bitrate
 */
export async function listBitrateAvailability(
	format: string,
	sampleRate: number,
	numberOfChannels: number,
): Promise<BitrateAvailabilityEntry[]> {
	const entries: BitrateAvailabilityEntry[] = [];
	for (const bitrate of getSupportedBitrates(format, sampleRate)) {
		entries.push({
			bitrate,
			available: await probeOfflineEncodingSupport(format, {
				numberOfChannels,
				sampleRate,
				bitrate,
			}),
		});
	}
	return entries;
}

/**
 * What this device's own encoder said about a bitrate list. `confirmed`: it
 * accepted the values listed. `unavailable`: there was no encoder to ask, so
 * the codec's declared range is offered unverified. `refused`: it was asked
 * and accepted none of them, which is not a missing answer but a real one -
 * the format cannot be written at this sample rate and layout here at all,
 * and it is the format, not the bitrate, that has to change.
 */
export type EncoderVerdict = 'confirmed' | 'unavailable' | 'refused';

/**
 * The bitrates a format can be written at here, and where that answer came
 * from.
 */
export interface BitrateOffer {
	/** Bitrates to offer, in bps, ascending and never empty. */
	readonly bitrates: number[];
	/** What the encoder said about them. */
	readonly encoder: EncoderVerdict;
}

/**
 * The bitrates to offer for a format: the codec's own range, narrowed to what
 * this device's encoder accepts when it accepts anything at all.
 *
 * The answer holds for the sample rate and layout it was asked about, and for
 * no others. Asking a second time at a rate nobody is recording at was how
 * one answer came to mean two things: the bitrate row narrowed its list to
 * what a 48 kHz encode would accept while the recording path, reading the
 * same offer, refused to move a session onto rates measured somewhere else.
 * Every caller now asks at the rate an offline encode runs at, which
 * `offlineEncodeSampleRate` reads from the device, so an answer given for
 * another rate has no reader left.
 *
 * An encoder that accepts none of them has not narrowed the list, it has
 * ruled the format out at this sample rate and layout. Chromium refuses every
 * AAC rate at 24 kHz and below, because mediabunny asks it about HE-AAC
 * there and only AAC-LC can be encoded. There is no bitrate to move to, so
 * the declared range is kept for the row to show and the verdict says the
 * format itself is what has to change; the format check at recording start
 * asks the same question and falls back before any audio is captured.
 * @param format - Target audio format
 * @param sampleRate - Rate the encoder will write at
 * @param numberOfChannels - Layout the output will have
 * @returns The list to offer and whether the encoder confirmed it
 */
export async function resolveBitrateOffer(
	format: string,
	sampleRate: number,
	numberOfChannels: number,
): Promise<BitrateOffer> {
	const declared = getSupportedBitrates(format, sampleRate);
	if (!isOfflineEncodingSupported(format)) {
		return { bitrates: declared, encoder: 'unavailable' };
	}
	// probeOfflineEncodingSupport is the error boundary: a registration or
	// probe that throws comes back as "unavailable", so a failed probe reaches
	// here as an empty list and is answered the same way as a refusal.
	const accepted = await acceptedBitrates(
		format,
		sampleRate,
		numberOfChannels,
	);
	if (accepted.length === 0) {
		return { bitrates: declared, encoder: 'refused' };
	}
	return { bitrates: accepted, encoder: 'confirmed' };
}

/**
 * The offered bitrates this device's encoder accepts for a format.
 *
 * Exported because the System info report asks the same question of every
 * compressed format, and a second filter over {@link listBitrateAvailability}
 * written there is the same rule kept in two places.
 * @param format - Target audio format
 * @param sampleRate - Rate the encoder is asked about
 * @param numberOfChannels - Layout the encoder is asked about
 * @returns Accepted bitrates in bps, ascending, possibly none
 */
export async function acceptedBitrates(
	format: string,
	sampleRate: number,
	numberOfChannels: number,
): Promise<number[]> {
	return (await listBitrateAvailability(format, sampleRate, numberOfChannels))
		.filter((entry) => entry.available)
		.map((entry) => entry.bitrate);
}

/**
 * The bitrate a recording should really start with: the configured one when
 * this device's encoder accepts it, otherwise the nearest rate it does.
 *
 * {@link effectiveBitrate} settles what the format's own tables allow, which
 * is all a synchronous caller can know. It cannot settle what a platform AAC
 * encoder accepts, because only the encoder knows, and a rate it refuses does
 * not fail until the recording is already over and its audio is being encoded
 * to the target format. Asking before the first sample is captured is what
 * turns a lost take into a notice and a slightly different file.
 *
 * The question is only worth asking about a session mediabunny will encode.
 * The session shape decides that, exactly as it decides the format check:
 * a lossless target carries no bitrate for an encoder to refuse, and a
 * single-track file MediaRecorder writes itself never reaches the WebCodecs
 * encoder at all, so its answer describes another encoder than the one
 * running. Substituting on it moved a recording off a rate it could have
 * used, and told the user an encoder had refused a value it was never asked
 * about.
 * @param format - Format the file will be written in
 * @param bitrate - The configured bitrate in bps
 * @param encoding - What the session hands the encoder, from
 *   {@link recordingEncodingFor}
 * @returns The bitrate to record with, and why it differs when it does
 */
export async function resolveEffectiveBitrate(
	format: string,
	bitrate: number,
	encoding: RecordingEncoding,
): Promise<{ bitrate: number; fellBack: boolean; reason: string }> {
	const requested = effectiveBitrate(format, bitrate, encoding.sampleRate);
	const encodedHere =
		takesBitrate(format) &&
		(encoding.mergesTracks || directRecordingMimeType(format) === null);
	if (!encodedHere) {
		return { bitrate: requested, fellBack: false, reason: '' };
	}
	const offer = await resolveBitrateOffer(
		format,
		encoding.sampleRate,
		encoding.numberOfChannels,
	);
	if (offer.encoder !== 'confirmed' || offer.bitrates.includes(requested)) {
		// Unavailable: nothing to check against. Refused: no rate would help,
		// and the format check at start has already moved the session off
		// this format.
		return { bitrate: requested, fellBack: false, reason: '' };
	}
	return {
		bitrate: closestBitrate(offer.bitrates, requested),
		fellBack: true,
		reason: `This device's ${format.toUpperCase()} encoder does not accept ${String(
			Math.round(requested / 1000),
		)} kbps at ${kilohertz(encoding.sampleRate)} kHz.`,
	};
}

/**
 * The output format a recording session should actually use: the
 * requested (stored) format when this device can record it, otherwise
 * the platform's best recordable format. Keeps a synced or stale
 * preference from silently producing a failed - or worse, corrupt -
 * recording: the session records something that genuinely works here
 * and the caller tells the user about the substitution.
 * @param requested - The stored output format preference
 * @param encoding - What the session will hand the encoder. Every candidate
 *   is held to it as well, so a fallback cannot be one that would fail at the
 *   end of the recording the way the requested format just did.
 * @returns The effective format and whether it is a fallback
 * @throws Error when this device cannot record any format at all
 */
export async function resolveEffectiveOutputFormat(
	requested: string,
	encoding?: RecordingEncoding,
): Promise<{ format: string; fellBack: boolean; reason: string }> {
	const normalized = requested.toLowerCase();
	const validation = await validateRecordingCapability(normalized, encoding);
	if (validation.valid) {
		return { format: normalized, fellBack: false, reason: '' };
	}
	// The platform's preference order, each candidate held to the same
	// question the requested format just failed: a fallback that only has
	// the codec would fail at the end of the recording the same way.
	const capabilities = await detectCapabilities();
	const candidates = [
		capabilities.defaultFormat,
		...capabilities.supportedFormats,
	].filter((format, index, all) => all.indexOf(format) === index);
	for (const candidate of candidates) {
		if (candidate === normalized) {
			continue;
		}
		if ((await validateRecordingCapability(candidate, encoding)).valid) {
			return {
				format: candidate,
				fellBack: true,
				reason: validation.reason,
			};
		}
	}
	throw new Error(validation.reason);
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
