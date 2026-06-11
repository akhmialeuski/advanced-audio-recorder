/**
 * Shared types and enums for the Audio Recorder plugin.
 * @module types
 */

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
