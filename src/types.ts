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
