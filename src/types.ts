/**
 * Shared types and enums for the Audio Recorder plugin.
 * @module types
 */

/**
 * Output mode for multi-track recordings.
 */
export type OutputMode = 'single' | 'multiple';

/**
 * Recording status states.
 */
export const RecordingStatus = {
	Idle: 'idle',
	Recording: 'recording',
	Paused: 'paused',
	/**
	 * Capture ended without the user asking for it: the input device went
	 * away mid-session. A state of its own because it is the one ending the
	 * user did not initiate, and every surface that shows what the recorder
	 * is doing has to say so rather than showing an ordinary save.
	 *
	 * It holds for the whole save that follows, not for the instant the input
	 * went. The session is saving either way, and the reason is the only thing
	 * separating this from a stop somebody pressed, so a {@link
	 * RecordingStatus.Saving} does not displace it - which is what used to
	 * happen on the finalizer's first progress line, leaving the reason
	 * nowhere but a Notice already dismissed. The session leaves it for Idle
	 * when the save is done.
	 */
	Interrupted: 'interrupted',
	Saving: 'saving',
} as const;

/** A recording lifecycle state (derived from {@link RecordingStatus}). */
export type RecordingStatus =
	(typeof RecordingStatus)[keyof typeof RecordingStatus];

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
	/** Drops a marker/chapter at the current position; absent when markers
	 * are disabled, so the button is hidden. */
	onAddMarker?: (() => void) | undefined;
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
	/** Written files grouped per track in part order, so recording-time
	 * markers can be resolved to the right file. Absent only when a caller
	 * (e.g. a test mock) does not provide it. */
	trackFiles?: TrackFileGroup[];
	/** Active recording duration in seconds, excluding paused intervals.
	 * Runtime recording results always include it; optional for compatibility
	 * with recovery paths and external/test callers. */
	durationSeconds?: number;
}

/**
 * One track's final files in part order: a single file for a plain track,
 * the ordered part files for an auto-split track, or the one merged file for
 * a single-output multi-track session. All tracks of a session share one
 * audio timeline, so a marker at a given part/offset applies to each track's
 * file at the same index.
 */
export interface TrackFileGroup {
	/** Index of the track in the session's target order. */
	trackIndex: number;
	/** This track's files, ordered: [...parts, residual]. */
	files: string[];
}

/**
 * Immutable snapshot of the session-scoped recording configuration,
 * taken at recording start. The per-track part and finalization paths
 * read these values repeatedly during the session; without the
 * snapshot, a settings change mid-recording could switch formats
 * between parts or reroute the finalization topology (outputMode
 * decides whether a multi-track session merges, and the auto-split
 * decision already depended on it at start).
 */
export interface RecordingSessionConfig {
	/**
	 * Chunk-buffer size that forces a part rotation, or null where a
	 * plain buffer flush may write raw mid-stream segments instead.
	 * A mid-stream segment carries no container header, so it only means
	 * anything together with its siblings and the journal that lists
	 * them. Where the operating system may kill the app without warning
	 * (mobile), each flush has to leave a file that plays on its own,
	 * which requires stopping and restarting the recorders: a rotation.
	 * The platform capability midStreamSegmentFlush decides which of the
	 * two a session gets.
	 */
	chunkRotationBytes: number | null;
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
	/**
	 * Bytes of PCM data destined for the WAV file being written now.
	 *
	 * Separate from {@link partPcmBytes}, which only exists while auto-split
	 * runs: this counter is what the container ceiling applies to, and the
	 * ceiling applies to every WAV whether or not the session splits. With
	 * auto-split on it tracks the current part, with it off the whole session.
	 */
	filePcmBytes: number;
	/**
	 * Whether the user has already been warned that this file is approaching
	 * the WAV size ceiling. Held per target so the warning is shown once per
	 * file rather than once per chunk over the threshold.
	 */
	wavCeilingWarned: boolean;
};

/**
 * What happens to the note link after a conversion or split produces a
 * new file: leave the original link, replace it, or insert the new
 * link after it.
 */
export type ConversionLinkAction = 'none' | 'replace' | 'after';
