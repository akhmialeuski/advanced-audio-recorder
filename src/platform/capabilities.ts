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
	/** In-memory chunk buffer size that triggers a flush to disk. */
	readonly chunkFlushThresholdBytes: number;
	/**
	 * Largest encoded file size the decode-heavy features (waveform,
	 * cleanup, split) will load into memory.
	 */
	readonly maxDecodeBytes: number;
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
	chunkFlushThresholdBytes: DESKTOP_FLUSH_THRESHOLD_BYTES,
	maxDecodeBytes: WAVEFORM_MAX_DECODE_BYTES,
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
	chunkFlushThresholdBytes: MOBILE_BUFFER_LIMIT_BYTES,
	maxDecodeBytes: MOBILE_MAX_DECODE_BYTES,
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

/** Chunk-buffer size that triggers a flush to disk on this platform. */
export function getChunkFlushThresholdBytes(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).chunkFlushThresholdBytes;
}

/** Largest encoded file decode-heavy features load on this platform. */
export function getMaxDecodeBytes(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxDecodeBytes;
}

/** Largest decoded working set cleanup accepts on this platform. */
export function getMaxCleanupDecodedSamples(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxCleanupDecodedSamples;
}

/** Longest duration cleanup accepts on this platform, in seconds. */
export function getMaxCleanupSeconds(kind?: PlatformKind): number {
	return getPlatformCapabilities(kind).maxCleanupSeconds;
}
