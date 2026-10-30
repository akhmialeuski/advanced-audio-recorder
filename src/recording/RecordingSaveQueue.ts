/**
 * Saves of stopped recordings, run one at a time in the order they stopped.
 * A stop hands its session over as a snapshot and the recorder is free at
 * once, so the next recording captures while this one is written. One at a
 * time, because decoding and mixing a long recording expands it to full PCM
 * in memory, and two of those at once would double that peak.
 * @module recording/RecordingSaveQueue
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type {
	InsertionContext,
	RecordingSaveResult,
	RecordingSessionConfig,
	RecordingTarget,
	SaveProgress,
} from '../types';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { DebugLogger } from '../utils/DebugLogger';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { errorMessage } from '../errors';
import { RecordingFinalizer } from './RecordingFinalizer';
import { TrackWriteQueue } from './TrackWriteQueue';
import type { SessionJournal } from './SessionJournal';
import type { RecordingMarkerCoordinator } from './RecordingMarkerCoordinator';
import type { RecordingMarkerDraft } from './recordingMarkers';

/**
 * Everything the save of one stopped session needs, fixed when its capture
 * ended. Its buffers were flushed before the hand-over, so every byte it
 * refers to is on disk and in the session's journal entry.
 */
export interface RecordingSnapshot {
	/** The configuration the session was captured with. */
	readonly session: RecordingSessionConfig;
	/** The session's tracks, with their segment and part paths. */
	readonly targets: RecordingTarget[];
	/** Session timestamp the merged file is named after. */
	readonly timestamp: string | null;
	/** Where the file links go. */
	readonly insertionContext: InsertionContext | null;
	/** The markers dropped during the session. */
	readonly markerDrafts: readonly RecordingMarkerDraft[];
	/** Active recorded time, paused spans excluded. */
	readonly durationSeconds: number;
	/** True when capture ended because its last input went away. */
	readonly interrupted: boolean;
}

/** What the save queue is doing, for the surfaces that show it. */
export interface RecordingSaveState {
	/**
	 * Saving or Interrupted while a save runs, by why its capture ended, and
	 * Idle when none runs.
	 */
	readonly status: RecordingStatus;
	/** Progress of the running save, once it has reported any. */
	readonly progress: SaveProgress | undefined;
	/** Saves waiting behind the running one. */
	readonly waiting: number;
}

/** The state of a queue with nothing to save. */
export const IDLE_SAVE_STATE: RecordingSaveState = Object.freeze({
	status: RecordingStatus.Idle,
	progress: undefined,
	waiting: 0,
});

/** The answer of a save that never ran because the plugin was unloaded. */
export const ABANDONED_SAVE_MESSAGE =
	'The plugin was unloaded before the recording was saved. ' +
	'It is offered for recovery on the next start.';

/** The running save, as the state reports it. */
interface RunningSave {
	readonly status: RecordingStatus;
	readonly progress: SaveProgress | undefined;
}

/** What one save is given, besides its snapshot. */
export interface RecordingSaveQueueDeps {
	readonly app: App;
	readonly settings: AudioRecorderSettings;
	readonly journal: SessionJournal;
	readonly markers: RecordingMarkerCoordinator;
	readonly debugLogger: DebugLogger;
	/** Receives every change of the queue's state. */
	readonly onChange: (state: RecordingSaveState) => void;
	/** Runs after a save that wrote at least one file. */
	readonly onRecordingSaved?:
		((result: RecordingSaveResult) => void) | undefined;
	readonly getWorkerClient?: (() => EncodingWorkerClient | null) | undefined;
}

/**
 * Runs the saves of stopped sessions, first in, first out.
 */
export class RecordingSaveQueue {
	/** The end of the chain every save waits behind. Never rejects. */
	private tail: Promise<void> = Promise.resolve();
	private waiting = 0;
	private running: RunningSave | null = null;
	private abandoned = false;
	private settings: AudioRecorderSettings;

	/**
	 * @param deps - What every save is run with
	 */
	constructor(private readonly deps: RecordingSaveQueueDeps) {
		this.settings = deps.settings;
	}

	/**
	 * Updates the settings the next save reads, the save folder and the file
	 * prefix among them. A running save keeps the ones it started with.
	 * @param settings - New settings
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.settings = settings;
	}

	/** What the queue is doing right now. */
	getState(): RecordingSaveState {
		return this.running === null && this.waiting === 0
			? IDLE_SAVE_STATE
			: {
					status: this.running?.status ?? RecordingStatus.Idle,
					progress: this.running?.progress,
					waiting: this.waiting,
				};
	}

	/**
	 * Queues the save of a stopped session behind every save queued before.
	 * @param snapshot - The session, as its capture left it
	 * @returns Settles once this save is over: with the reason it failed, or
	 *   null once its files are written
	 */
	enqueue(snapshot: RecordingSnapshot): Promise<string | null> {
		this.waiting += 1;
		this.report();
		const save = this.tail.then(() => this.run(snapshot));
		this.tail = save.then(() => undefined);
		return save;
	}

	/**
	 * Gives up every save that has not started, on unload. Their journal
	 * entries stay open on disk, so the next launch offers them for recovery.
	 * A save already running is left to finish: its files are being written
	 * through the vault, which outlives the plugin.
	 */
	abandon(): void {
		this.abandoned = true;
	}

	/**
	 * Runs one save: the finalizer's sequence, the markers, the journal, then
	 * the post-save hook. The finalizer and write queue are this save's own,
	 * started on the snapshot's session, so a session recording meanwhile
	 * cannot change the format, the journal entry or the progress this save
	 * reads.
	 * @param snapshot - The session to save
	 * @returns The reason it failed, or null once it is saved
	 */
	private async run(snapshot: RecordingSnapshot): Promise<string | null> {
		this.waiting -= 1;
		if (this.abandoned) {
			return ABANDONED_SAVE_MESSAGE;
		}
		const { app, journal, debugLogger, getWorkerClient } = this.deps;
		const status = snapshot.interrupted
			? RecordingStatus.Interrupted
			: RecordingStatus.Saving;
		this.running = { status, progress: undefined };
		const writeQueue = new TrackWriteQueue(app, this.settings, journal);
		writeQueue.beginSession(snapshot.session);
		const finalizer = new RecordingFinalizer(
			app,
			this.settings,
			writeQueue,
			debugLogger,
			(progress) => {
				this.running = { status, progress };
				this.report();
			},
			journal,
			getWorkerClient,
		);
		finalizer.beginSession(snapshot.session);
		try {
			finalizer.reportProgress(0, 'Saving...');
			const finalized = await finalizer.saveRecording(
				snapshot.targets,
				snapshot.timestamp,
				snapshot.insertionContext,
			);
			const result: RecordingSaveResult = {
				...finalized,
				durationSeconds: snapshot.durationSeconds,
			};
			// Persisted before the hook, so they are on disk when a post-save
			// action (opening the player, for one) reads the sidecar
			await this.deps.markers.persistMarkers(
				snapshot.markerDrafts,
				result,
			);
			if (result.audioPaths.length > 0) {
				// A hook failure must never fail the save it follows
				try {
					this.deps.onRecordingSaved?.(result);
				} catch (hookError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Post-save hook failed:`,
						hookError,
					);
				}
			}
			// The session finalized cleanly: leftovers already produced their
			// own Notices, and keeping them journaled would raise misleading
			// recovery prompts for audio that is in the final files
			journal.endSession(snapshot.session.sessionId);
			await journal.flush();
			finalizer.reportProgress(100, 'Saved');
			return null;
		} catch (error) {
			// The journal entry stays open, so the next launch offers what
			// this save could not write
			const failure = `Error saving recording: ${errorMessage(error)}`;
			new Notice(failure);
			console.error(
				`${PLUGIN_LOG_PREFIX} Error saving recording:`,
				error,
			);
			return failure;
		} finally {
			this.running = null;
			this.report();
		}
	}

	/** Tells the surfaces what the queue is doing now. */
	private report(): void {
		this.deps.onChange(this.getState());
	}
}
