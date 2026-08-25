/**
 * Per-platform feature policy. Each capability answers "is this feature
 * available here?" (or "which limit applies here?") so higher layers - the
 * settings UI, the recording pipeline, the players - branch on a named
 * capability instead of on the platform itself. Adding a platform
 * difference means adding one field to the table below, not sprinkling
 * platform checks through feature code.
 * @module platform/capabilities
 */

import {
	DESKTOP_FLUSH_THRESHOLD_BYTES,
	MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
	MAX_AUDIO_CLEANUP_SECONDS,
	MOBILE_BUFFER_LIMIT_BYTES,
	MOBILE_MAX_AUDIO_CLEANUP_SECONDS,
	MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
	MOBILE_MAX_DECODE_BYTES,
	WAVEFORM_MAX_DECODE_BYTES,
} from '../constants';
import { getPlatformKind, type PlatformKind } from './platformKind';

/**
 * Everything the plugin allows or bounds differently per platform.
 */
export interface PlatformCapabilities {
	/** Capturing several input devices at once (multi-track recording). */
	readonly multiTrackCapture: boolean;
	/**
	 * Selecting a specific input device. Off where the platform exposes
	 * no meaningful device list; capture then uses the system default
	 * microphone and stored device ids are ignored.
	 */
	readonly deviceSelection: boolean;
	/**
	 * Choosing a channel layout (mono downmix / channel pick) for the
	 * capture. Tied to real multi-channel input devices, which only the
	 * desktop platform exposes.
	 */
	readonly channelModeSelection: boolean;
	/** Choosing the capture sample rate (mobile OSes fix their own). */
	readonly sampleRateSelection: boolean;
	/** Automatic splitting of a live recording into part files. */
	readonly autoSplit: boolean;
	/** Direct PCM capture via AudioWorklet for WAV output. */
	readonly pcmWavCapture: boolean;
	/** Crash-recovery journaling of in-progress recordings. */
	readonly recoveryJournal: boolean;
	/** Local (on-device) whisper.cpp transcription. */
	readonly localTranscription: boolean;
	/** Floating on-screen recording banner (mobile has no ribbon/status bar). */
	readonly recordingBanner: boolean;
	/**
	 * Whether the settings framework gives a list its own labelled add row.
	 * From Obsidian 1.13 the add affordance of a declarative list is platform
	 * dependent: a tappable "+ name" row under the list on mobile, and a bare
	 * plus icon in the list header on desktop. Where the row is missing the
	 * tab declares one of its own, so adding an entry is never hidden behind
	 * an unlabelled icon.
	 */
	readonly settingsListAddRow: boolean;
	/** In-memory chunk buffer size that triggers a flush to disk. */
	readonly chunkFlushThresholdBytes: number;
	/**
	 * Largest encoded file size the decode-heavy features (waveform,
	 * cleanup, split) will load into memory.
	 */
	readonly maxDecodeBytes: number;
	/**
	 * Largest source file this platform will read into memory whole, before
	 * anything is done with the bytes.
	 *
	 * A separate ceiling from {@link PlatformCapabilities.maxDecodeBytes},
	 * because reading and decoding are separate allocations and only one of
	 * them expands the file. Desktop is unbounded: the splitter's lossless WAV
	 * byte path and the converter's streaming path both handle files far
	 * beyond the decode ceiling without ever expanding one, and cleanup points
	 * users at split for oversized files, so split must accept them. Mobile
	 * bounds every full-file read, because just holding the bytes (plus one
	 * working copy) can get the WebView killed.
	 */
	readonly maxSourceReadBytes: number;
	/** Largest decoded working set (frames x channels) cleanup accepts. */
	readonly maxCleanupDecodedSamples: number;
	/** Longest recording duration cleanup accepts, in seconds. */
	readonly maxCleanupSeconds: number;
}

const DESKTOP_CAPABILITIES: PlatformCapabilities = {
	multiTrackCapture: true,
	deviceSelection: true,
	channelModeSelection: true,
	sampleRateSelection: true,
	autoSplit: true,
	pcmWavCapture: true,
	recoveryJournal: true,
	localTranscription: true,
	recordingBanner: false,
	settingsListAddRow: false,
	chunkFlushThresholdBytes: DESKTOP_FLUSH_THRESHOLD_BYTES,
	maxDecodeBytes: WAVEFORM_MAX_DECODE_BYTES,
	maxSourceReadBytes: Number.POSITIVE_INFINITY,
	maxCleanupDecodedSamples: MAX_AUDIO_CLEANUP_DECODED_SAMPLES,
	maxCleanupSeconds: MAX_AUDIO_CLEANUP_SECONDS,
};

const MOBILE_CAPABILITIES: PlatformCapabilities = {
	multiTrackCapture: false,
	deviceSelection: false,
	channelModeSelection: false,
	sampleRateSelection: false,
	autoSplit: false,
	pcmWavCapture: false,
	recoveryJournal: false,
	localTranscription: false,
	recordingBanner: true,
	settingsListAddRow: true,
	chunkFlushThresholdBytes: MOBILE_BUFFER_LIMIT_BYTES,
	maxDecodeBytes: MOBILE_MAX_DECODE_BYTES,
	maxSourceReadBytes: MOBILE_MAX_DECODE_BYTES,
	maxCleanupDecodedSamples: MOBILE_MAX_CLEANUP_DECODED_SAMPLES,
	maxCleanupSeconds: MOBILE_MAX_AUDIO_CLEANUP_SECONDS,
};

const CAPABILITY_TABLE: Record<PlatformKind, PlatformCapabilities> = {
	desktop: DESKTOP_CAPABILITIES,
	mobile: MOBILE_CAPABILITIES,
};

/**
 * The capability set of a platform. Resolves the current platform lazily
 * per call, so tests (and Obsidian itself) may flip the platform flags at
 * any time.
 * @param kind - Platform to look up (defaults to the current one)
 * @returns The platform's capability set
 */
export function getPlatformCapabilities(
	kind: PlatformKind = getPlatformKind(),
): PlatformCapabilities {
	return CAPABILITY_TABLE[kind];
}

/** Whether multi-track capture is available on this platform. */
export function isMultiTrackCaptureSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).multiTrackCapture;
}

/** Whether a specific input device can be selected on this platform. */
export function isDeviceSelectionSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).deviceSelection;
}

/** Whether capture channel layouts can be selected on this platform. */
export function isChannelModeSelectionSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).channelModeSelection;
}

/** Whether the capture sample rate can be selected on this platform. */
export function isSampleRateSelectionSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).sampleRateSelection;
}

/** Whether live recordings can auto-split into parts on this platform. */
export function isAutoSplitSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).autoSplit;
}

/** Whether WAV records via direct PCM capture on this platform. */
export function isPcmWavCaptureSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).pcmWavCapture;
}

/** Whether in-progress recordings are journaled for crash recovery. */
export function isRecoveryJournalSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).recoveryJournal;
}

/** Whether local whisper.cpp transcription is available on this platform. */
export function isLocalTranscriptionSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).localTranscription;
}

/** Whether the floating recording banner is used on this platform. */
export function isRecordingBannerSupported(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).recordingBanner;
}

/** Whether a declarative settings list gets its own add row on this platform. */
export function isSettingsListAddRowProvided(kind?: PlatformKind): boolean {
	return getPlatformCapabilities(kind).settingsListAddRow;
}

/** Chunk-buffer size that triggers a flush to disk on this platform. */
export function getChunkFlushThresholdBytes(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).chunkFlushThresholdBytes;
}

/** Largest encoded file decode-heavy features load on this platform. */
export function getMaxDecodeBytes(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxDecodeBytes;
}

/**
 * Whether a file of this size may be decoded whole on this platform.
 *
 * Decoding expands a file to full PCM in memory, so every path that does it
 * asks this first: the waveform, cleanup, the splitter, and the metadata read
 * that falls back to a decode when the container headers carry no duration.
 * The ceiling is far lower on mobile, whose WebView is killed by the OS rather
 * than given a catchable error, which is why the question is asked before the
 * allocation rather than answered by it.
 * @param bytes - Encoded size of the file
 * @param kind - Platform to answer for (defaults to the current one)
 */
export function isDecodableSize(bytes: number, kind?: PlatformKind): boolean {
	return bytes <= getMaxDecodeBytes(kind);
}

/**
 * What to tell a user whose file will not fit under {@link isDecodableSize}.
 *
 * One limit used to produce three different pieces of advice: the splitter
 * pointed at the desktop app, cleanup said to split the file first, and
 * conversion said nothing because it never asked. Which advice is the useful
 * one is a fact about the platform rather than about the operation. A phone has
 * a bigger machine to move to, and the desktop app does not, so there the only
 * thing that helps is making the file smaller.
 * @param action - The operation the user asked for, named as a verb phrase
 * @param kind - Platform to answer for (defaults to the current one)
 * @returns The refusal, ready to show
 */
export function tooLargeToDecodeMessage(
	action: string,
	kind: PlatformKind = getPlatformKind(),
): string {
	if (kind === 'mobile') {
		return (
			`File is too large to ${action} on this device. ` +
			'Convert or split it on desktop instead.'
		);
	}
	return `File is too large to ${action}. Split it into parts first.`;
}

/** Largest source file this platform reads into memory whole. */
export function getMaxSourceReadBytes(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxSourceReadBytes;
}

/**
 * Whether a file of this size may be read into memory whole on this platform.
 *
 * The mirror of {@link isDecodableSize}, and separate from it on purpose: a
 * path that streams or remuxes reads the bytes without ever expanding them,
 * so it is bounded by this and not by the decode ceiling. Asking the decode
 * question at an entry point that may never decode refuses files the platform
 * handles perfectly well.
 * @param bytes - Size of the source file
 * @param kind - Platform to answer for (defaults to the current one)
 */
export function isReadableSize(bytes: number, kind?: PlatformKind): boolean {
	return bytes <= getMaxSourceReadBytes(kind);
}

/** Largest decoded working set cleanup accepts on this platform. */
export function getMaxCleanupDecodedSamples(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxCleanupDecodedSamples;
}

/** Longest duration cleanup accepts on this platform, in seconds. */
export function getMaxCleanupSeconds(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxCleanupSeconds;
}
