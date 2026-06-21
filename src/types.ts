/**
 * Shared types and enums for the Audio Recorder plugin.
 * @module types
 */

import type { OutputMode } from './settings/Settings';

/**
 * Recording status states.
 */
export enum RecordingStatus {
	Idle = 'idle',
	Recording = 'recording',
	Paused = 'paused',
	Saving = 'saving',
}

/**
 * Progress information during the save phase.
 */
export type SaveProgress = {
	percent: number;
	description: string;
};

/**
 * Callbacks for recording control buttons in the status bar.
 */
export type RecordingControls = {
	onPauseResume: () => void;
	onStop: () => void;
	isPaused: boolean;
};

/**
 * Captured insertion context at recording start.
 */
export interface InsertionContext {
	/** Path of the note that was active when recording started. */
	filePath: string;
	/** Cursor line number at recording start. */
	line: number;
	/** Cursor character offset at recording start. */
	ch: number;
}

/**
 * Result of finalizing a recording: the vault paths of the audio files
 * written, and the note the audio links were inserted into (null when no
 * note received them). The post-save hook uses `notePath` so an automatic
 * transcription targets the same note the recording embed landed in, instead
 * of whatever file happens to be active when the async job runs.
 */
export interface RecordingSaveResult {
	/** Vault paths of the audio files that were written. */
	audioPaths: string[];
	/** Note the audio links were inserted into, or null when none was. */
	notePath: string | null;
}

/**
 * Immutable snapshot of the session-scoped recording configuration,
 * taken at recording start. The per-track part and finalization paths
 * read these values repeatedly during the session; without the
 * snapshot, a settings change mid-recording could switch formats
 * between parts or reroute the finalization topology (outputMode
 * decides whether a multi-track session merges, and the auto-split
 * decision already depended on it at start). The mobile flush path
 * deliberately keeps reading live settings (see
 * TrackWriteQueue.flushChunkBuffer).
 */
export interface RecordingSessionConfig {
	/** Whether the session runs in the mobile app. */
	isMobile: boolean;
	/** Whether the session captures raw PCM for WAV output (desktop). */
	isWavPcm: boolean;
	/** Container format produced by the MediaRecorders. */
	recorderFormat: string;
	/** Output format of the final files. */
	outputFormat: string;
	/** Output mode: 'single' merges multi-track sessions at stop. */
	outputMode: OutputMode;
	/** Encoder bitrate in bits per second. */
	bitrate: number;
	/** Whether auto-split is active for the session. */
	splitEnabled: boolean;
	/** Auto-split part duration in minutes. */
	partMinutes: number;
	/** Auto-split part name suffix. */
	partSuffix: string;
}

/**
 * State for a single recording track (audio source).
 */
export type RecordingTarget = {
	fileBaseName: string;
	sourceName: string;
	bufferedChunks: Blob[];
	bufferedBytes: number;
	segmentIndex: number;
	segmentPaths: string[];
	pendingWrite: Promise<void>;
	pcmBuffers: ArrayBuffer[];
	pcmBufferedBytes: number;
	pcmChannels: number;
	pcmSampleRate: number;
	/** Number of auto-split parts already finalized for this track. */
	partIndex: number;
	/** Saved auto-split part file paths in order of creation. */
	partPaths: string[];
	/** Bytes of PCM data accumulated toward the current auto-split part. */
	partPcmBytes: number;
};
