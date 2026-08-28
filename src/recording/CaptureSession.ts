/**
 * The settings a recording session is fixed to at its start.
 *
 * A session decides once what it is: the format it writes, whether it captures
 * raw PCM, how it splits, and what each track does with its channels. Those
 * answers must not move afterwards - a settings edit half way through a
 * two-hour recording would otherwise split the session's own behaviour, and
 * every collaborator that already began work under the old answer would carry
 * on under it while the manager reported the new one.
 *
 * The manager used to hold eight fields for this and then assemble the same
 * values into a second object for the write queue, the finalizer and the
 * rotation controller, so every value existed twice and stayed in step by hand.
 * Here it exists once, is frozen, and is the object those three are handed.
 * @module recording/CaptureSession
 */

import {
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	FORMAT_WEBM,
} from '../constants';
import type { RecordingSessionConfig } from '../types';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TrackAudioSource } from './AudioStreamHandler';
import { normalizeChannelMode, type ChannelMode } from '../audio/downmix';
import { clampSplitMinutes, sanitizePartSuffix } from './AudioSplitter';
import {
	getChunkFlushThresholdBytes,
	isMidStreamSegmentFlushAllowed,
} from '../platform/capabilities';

/**
 * One session's fixed answers. Extends the configuration its collaborators
 * take, so they receive this object itself rather than a rebuilt copy.
 */
export interface CaptureSession extends RecordingSessionConfig {
	/**
	 * Channel mode per stream, aligned with the acquired streams. Normalized
	 * once here: the capture primitives branch on these, and a hand-edited
	 * data.json must not leave a session split between mono and pass-through.
	 */
	readonly channelModes: readonly ChannelMode[];
}

/** A session, and whether building it had to overrule a setting. */
export interface CaptureSessionPlan {
	readonly session: CaptureSession;
	/**
	 * True when auto-split was asked for and refused: a merged multi-track
	 * output has one file to write at stop, so there is nothing to rotate.
	 */
	readonly autoSplitSkipped: boolean;
}

/** What the session is built from, gathered before the first recorder exists. */
export interface CaptureSessionRequest {
	/** Live settings, read once here and never again for this session. */
	readonly settings: AudioRecorderSettings;
	/** Number of acquired audio streams. */
	readonly streamCount: number;
	/** Per-track sources, empty for a single-track session. */
	readonly trackOrder: readonly TrackAudioSource[];
	/** Output format resolved for this session, after any platform fallback. */
	readonly outputFormat: string;
	/** Container the MediaRecorders produce, unused on the PCM path. */
	readonly recorderFormat: string;
	/** Whether this session captures raw PCM for WAV output. */
	readonly isWavPcm: boolean;
}

/**
 * Fixes a session's settings for as long as it runs.
 *
 * Nothing here reads the clock or the vault, so a session is fully described by
 * its request and can be built in a test without a recorder.
 * @param request - What the session is being started with
 * @returns The frozen session, and whether auto-split was refused
 */
export function createCaptureSession(
	request: CaptureSessionRequest,
): CaptureSessionPlan {
	const { settings, streamCount, trackOrder } = request;
	// Multi-track device ids and channel modes were captured together before
	// getUserMedia, so a settings edit while permission is pending cannot
	// combine one device with another device's mode. The global setting covers
	// the single-track session.
	const channelModes: ChannelMode[] =
		trackOrder.length > 0
			? trackOrder.map((source) =>
					normalizeChannelMode(source.channelMode),
				)
			: Array.from({ length: streamCount }, () =>
					normalizeChannelMode(settings.recordingChannels),
				);
	const requestedSplit = settings.autoSplitEnabled;
	const autoSplitSkipped =
		requestedSplit && settings.outputMode === 'single' && streamCount > 1;
	const session: CaptureSession = Object.freeze({
		// Platforms that must not leave raw mid-stream segments behind run
		// their buffer flushes as full part rotations at this size boundary.
		chunkRotationBytes: isMidStreamSegmentFlushAllowed()
			? null
			: getChunkFlushThresholdBytes(),
		isWavPcm: request.isWavPcm,
		recorderFormat: request.recorderFormat,
		outputFormat: request.outputFormat,
		outputMode: settings.outputMode,
		bitrate: settings.bitrate,
		splitEnabled: requestedSplit && !autoSplitSkipped,
		partMinutes: clampSplitMinutes(settings.splitChunkMinutes),
		partSuffix: sanitizePartSuffix(settings.splitPartSuffix),
		channelModes: Object.freeze(channelModes),
	});
	return { session, autoSplitSkipped };
}

/** The session an idle manager reports, so no reader has to test for null. */
export const IDLE_CAPTURE_SESSION: CaptureSession = Object.freeze({
	chunkRotationBytes: null,
	isWavPcm: false,
	recorderFormat: FORMAT_WEBM,
	outputFormat: FORMAT_WEBM,
	outputMode: 'multiple' as const,
	bitrate: 0,
	splitEnabled: false,
	partMinutes: DEFAULT_SPLIT_CHUNK_MINUTES,
	partSuffix: DEFAULT_SPLIT_PART_SUFFIX,
	channelModes: Object.freeze([]),
});
