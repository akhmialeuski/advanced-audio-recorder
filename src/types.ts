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
