/**
 * Auto-split part rotation for the recording pipeline. Owns the
 * active-time accounting, the reentry guard for in-flight rotations,
 * and the part finalization for both capture paths: MediaRecorder
 * sessions rotate by stopping and restarting the recorders, PCM/WAV
 * sessions split sample-exact by byte count.
 * @module recording/PartRotationController
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { RecordingStatus } from '../types';
import type { RecordingSessionConfig, RecordingTarget } from '../types';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { PLUGIN_LOG_PREFIX, MS_PER_MINUTE, FORMAT_WAV } from '../constants';
import { DebugLogger } from '../utils/DebugLogger';
import { resolveUniquePath } from '../audio/RecordingFileManager';
import {
	buildPartFileName,
	detachTrailingBytes,
	totalByteLength,
} from './AudioSplitter';
import type { TrackWriteQueue } from './TrackWriteQueue';
import type { RecordingFinalizer } from './RecordingFinalizer';
import { SessionJournal } from './SessionJournal';
import { computePartPosition, type PartPosition } from './recordingMarkers';

/**
 * Callbacks into the RecordingManager: recorder lifecycle stays with
 * the manager because rotation must stop and recreate the recorders
 * it does not own.
 */
export interface RotationHooks {
	/** Returns the recording targets of the active session. */
	getTargets: () => RecordingTarget[];
	/** Returns the current recording status. */
	getStatus: () => RecordingStatus;
	/** Stops the active MediaRecorders and waits for their stop events. */
	stopRecorders: () => Promise<void>;
	/** Recreates and starts the MediaRecorders after a rotation. */
	restartRecorders: () => void;
}

/**
 * Rotates auto-split recording parts and finalizes them.
 */
export class PartRotationController {
	/** Session configuration set by beginSession. */
	private session: RecordingSessionConfig | null = null;
	/** Active (unpaused) milliseconds accumulated in the current part. */
	private partActiveMs = 0;
	/** Active (unpaused) milliseconds accumulated across the whole session. */
	private sessionActiveMs = 0;
	/** Count of completed part rotations (the current part index). */
	private sessionPartOrdinal = 0;
	/** Timestamp of the last start/resume/rotation for active-time tracking. */
	private activeAnchor = 0;
	/** In-flight MediaRecorder part rotation, if any. */
	private rotationPromise: Promise<void> | null = null;
	/** Whether the session is being stopped (blocks new part rotations). */
	private isStopping = false;

	/**
	 * Creates a new PartRotationController.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings (live reference)
	 * @param writeQueue - Write queue used to flush buffers at boundaries
	 * @param finalizer - Finalizer producing the part files
	 * @param debugLogger - Debug logger
	 * @param hooks - Recorder lifecycle callbacks into the manager
	 * @param journal - Crash-recovery journal tracking part files
	 */
	constructor(
		private readonly app: App,
		private settings: AudioRecorderSettings,
		private readonly writeQueue: TrackWriteQueue,
		private readonly finalizer: RecordingFinalizer,
		private readonly debugLogger: DebugLogger,
		private readonly hooks: RotationHooks,
		private readonly journal: SessionJournal = new SessionJournal(
			null,
			app,
		),
	) {}

	/**
	 * Updates the live settings reference.
	 * @param settings - New settings
	 */
	updateSettings(settings: AudioRecorderSettings): void {
		this.settings = settings;
	}

	/**
	 * Starts a new recording session: stores the session snapshot and
	 * resets the rotation state.
	 * @param session - Session configuration snapshot
	 */
	beginSession(session: RecordingSessionConfig): void {
		this.session = session;
		this.partActiveMs = 0;
		this.sessionActiveMs = 0;
		this.sessionPartOrdinal = 0;
		this.activeAnchor = Date.now();
		this.rotationPromise = null;
		this.isStopping = false;
	}

	/**
	 * Freezes active-time accounting when the recording is paused. Folds the
	 * elapsed active span into both the per-part and the whole-session
	 * counters so paused time is excluded from marker positions too.
	 */
	markPaused(): void {
		const elapsed = Date.now() - this.activeAnchor;
		this.partActiveMs += elapsed;
		this.sessionActiveMs += elapsed;
	}

	/**
	 * Returns the current marker position: the part ordinal that is
	 * recording now and the offset within it. Derived from the controller's
	 * own active-time accounting in one synchronous read, so the pair is
	 * always internally consistent even mid-rotation. The live span since
	 * the last anchor is added only while actually recording, so a position
	 * taken during a pause excludes the paused time.
	 * @param status - Current recording status
	 */
	getCurrentPartPosition(status: RecordingStatus): PartPosition {
		const session = this.session;
		const liveMs =
			status === RecordingStatus.Recording
				? Date.now() - this.activeAnchor
				: 0;
		return computePartPosition({
			isWavPcm: session?.isWavPcm ?? false,
			splitEnabled: session?.splitEnabled ?? false,
			partMinutes: session?.partMinutes ?? 0,
			partActiveMs: this.partActiveMs + liveMs,
			sessionActiveMs: this.sessionActiveMs + liveMs,
			sessionPartOrdinal: this.sessionPartOrdinal,
		});
	}

	/**
	 * Returns the active (unpaused) milliseconds elapsed since the session
	 * began. The live span since the last anchor is added only while
	 * recording, so a value read during a pause excludes the paused time.
	 * This is the single source of truth for pause-aware elapsed time.
	 * @param status - Current recording status
	 */
	getSessionActiveMs(status: RecordingStatus): number {
		const liveMs =
			status === RecordingStatus.Recording
				? Date.now() - this.activeAnchor
				: 0;
		return this.sessionActiveMs + liveMs;
	}

	/**
	 * Re-anchors active-time accounting when the recording resumes
	 * (and when capture actually starts).
	 */
	markResumed(): void {
		this.activeAnchor = Date.now();
	}

	/**
	 * Marks the session as stopping, blocking new part rotations.
	 * @returns False when the session is already stopping (reentry)
	 */
	requestStop(): boolean {
		if (this.isStopping) {
			return false;
		}
		this.isStopping = true;
		return true;
	}

	/**
	 * Lets an in-flight part rotation finish: it replaces the
	 * recorders, and its part files must be written before the
	 * residual is saved.
	 */
	async waitForPendingRotation(): Promise<void> {
		if (this.rotationPromise) {
			await this.rotationPromise;
		}
	}

	/**
	 * The session's size-rotation boundary in bytes, or null when plain
	 * buffer flushes are allowed (journaled desktop pipeline). The chunk
	 * handler consults this to decide between a plain flush and leaving
	 * the boundary to a rotation.
	 */
	sizeRotationBytes(): number | null {
		return this.session?.chunkRotationBytes ?? null;
	}

	/**
	 * Launches a part rotation when the session reached a part
	 * boundary - the auto-split time boundary, or the platform's
	 * chunk-buffer size boundary (platforms whose flushes must produce
	 * standalone files). Runs outside the per-target pendingWrite
	 * chains and is guarded against reentry.
	 */
	maybeRotate(): void {
		if (!this.shouldRotate()) {
			return;
		}
		this.rotationPromise = this.rotate()
			.catch((error: unknown) => {
				// Backstop: the rotation contains its own error
				// handling, but an unexpected rejection must not
				// become unhandled or poison a concurrent
				// stopRecording awaiting this promise
				console.error(
					`${PLUGIN_LOG_PREFIX} Unexpected error during part rotation:`,
					error,
				);
			})
			.finally(() => {
				this.rotationPromise = null;
			});
	}

	/**
	 * Checks whether the MediaRecorder-based recording reached a part
	 * boundary: the auto-split time boundary, or the chunk-buffer size
	 * boundary on platforms whose flushes must produce standalone files
	 * (see {@link RecordingSessionConfig.chunkRotationBytes}). PCM/WAV
	 * recordings split by exact byte count instead (see
	 * finalizePcmPart).
	 */
	private shouldRotate(): boolean {
		const session = this.session;
		if (
			!session ||
			session.isWavPcm ||
			this.isStopping ||
			this.rotationPromise !== null ||
			this.hooks.getStatus() !== RecordingStatus.Recording
		) {
			return false;
		}
		if (session.splitEnabled) {
			const activeMs =
				this.partActiveMs + (Date.now() - this.activeAnchor);
			if (activeMs >= session.partMinutes * MS_PER_MINUTE) {
				return true;
			}
		}
		const sizeBoundary = session.chunkRotationBytes;
		if (sizeBoundary !== null) {
			return this.hooks
				.getTargets()
				.some((target) => target.bufferedBytes >= sizeBoundary);
		}
		return false;
	}

	/**
	 * Finalizes the current auto-split part of a PCM/WAV recording.
	 * Splits the last buffer at the exact part boundary, assembles the
	 * part WAV file from flushed segments, and carries the overshoot
	 * into the next part, keeping parts sample-exact. Runs inside the
	 * target's pendingWrite chain; errors are contained so they cannot
	 * poison subsequent writes.
	 * @param target - Recording target to finalize
	 * @param partLimitBytes - Exact part size in bytes
	 */
	async finalizePcmPart(
		target: RecordingTarget,
		partLimitBytes: number,
	): Promise<void> {
		const session = this.session;
		if (!session) {
			return;
		}
		const overshoot = target.partPcmBytes - partLimitBytes;
		const carry =
			overshoot > 0
				? detachTrailingBytes(target.pcmBuffers, overshoot)
				: [];

		target.partIndex += 1;
		try {
			const fileName = buildPartFileName(
				target.fileBaseName,
				session.partSuffix,
				target.partIndex,
				FORMAT_WAV,
			);
			const filePath = await resolveUniquePath(
				fileName,
				this.app,
				this.settings,
			);
			await this.writeQueue.flushPcmBuffer(target);
			if (target.segmentPaths.length > 0) {
				await this.finalizer.assembleWavFile(target, filePath);
				target.partPaths.push(filePath);
				this.journal.addPart(target.fileBaseName, filePath);
				this.debugLogger.log('Auto-split part saved', { filePath });
				new Notice(`Recording part ${String(target.partIndex)} saved`);
			}
			target.segmentPaths = [];
			target.segmentIndex = 0;
		} catch (error) {
			// Keep recording without losing audio: whatever was not
			// flushed stays buffered (with the carry re-attached in
			// capture order), flushed segments stay on disk, and all of
			// it lands in the next part. Part accounting restarts from
			// zero so the failed save is retried one part length later,
			// not on every chunk.
			target.partIndex -= 1;
			target.pcmBuffers.push(...carry);
			target.pcmBufferedBytes = totalByteLength(target.pcmBuffers);
			target.partPcmBytes = 0;
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
				error,
			);
			new Notice(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
			return;
		}
		target.pcmBuffers = carry;
		target.pcmBufferedBytes = totalByteLength(carry);
		target.partPcmBytes = target.pcmBufferedBytes;
	}

	/**
	 * Rotates MediaRecorder-based recording at a part boundary (the
	 * auto-split time boundary, or the platform size boundary):
	 * stops the recorders to obtain a complete container, detaches the
	 * buffered data of each track as a snapshot of plain segment files,
	 * restarts the recorders on the same streams, and only then
	 * transcodes the snapshots into part files. Restarting before the
	 * potentially slow transcoding keeps the capture gap limited to
	 * recorder stop plus raw buffer flush time. The recording status
	 * stays Recording the whole time. Errors are contained so the
	 * session keeps recording.
	 */
	private async rotate(): Promise<void> {
		const targets = this.hooks.getTargets();
		const snapshots: {
			target: RecordingTarget;
			segmentPaths: string[];
		}[] = [];
		try {
			await this.hooks.stopRecorders();
			await this.writeQueue.drain(targets);

			for (const target of targets) {
				try {
					// Plain file write of already-captured bytes; the
					// expensive transcoding happens after the restart
					await this.writeQueue.flushChunkBuffer(target);
				} catch (error) {
					// Chunks stay buffered in capture order and land in
					// the next part
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to flush buffers at part boundary:`,
						error,
					);
					new Notice(
						'Failed to save recording part. Recording continues; data is kept for the next part.',
					);
					continue;
				}
				if (target.segmentPaths.length > 0) {
					snapshots.push({
						target,
						segmentPaths: target.segmentPaths,
					});
					target.segmentPaths = [];
					target.segmentIndex = 0;
				}
			}
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Error during part rotation:`,
				error,
			);
			new Notice('Failed to rotate recording part. Recording continues.');
		} finally {
			// Restart only while still recording or paused; a concurrent
			// stopRecording awaits this rotation and tears recorders down
			const status = this.hooks.getStatus();
			if (
				!this.isStopping &&
				(status === RecordingStatus.Recording ||
					status === RecordingStatus.Paused)
			) {
				this.hooks.restartRecorders();
			}
			// Close out the part that just ended: fold its active span into
			// the session clock, open a new part, and advance the ordinal so
			// markers dropped after this point attach to the new part.
			this.sessionActiveMs += Date.now() - this.activeAnchor;
			this.sessionPartOrdinal += 1;
			this.partActiveMs = 0;
			this.activeAnchor = Date.now();
		}

		// Transcode and write the part files while the next part is
		// already being captured by the restarted recorders
		for (const snapshot of snapshots) {
			await this.finalizeMediaPartSnapshot(
				snapshot.target,
				snapshot.segmentPaths,
			);
		}
	}

	/**
	 * Transcodes one detached rotation snapshot into a part file and
	 * records it on the target. On failure the snapshot segments are
	 * re-attached in front of the data captured since the restart, so
	 * the audio lands in the next part instead of being lost.
	 * @param target - Recording target the snapshot belongs to
	 * @param segmentPaths - Detached segment files in capture order
	 */
	private async finalizeMediaPartSnapshot(
		target: RecordingTarget,
		segmentPaths: string[],
	): Promise<void> {
		const session = this.session;
		if (!session) {
			return;
		}
		target.partIndex += 1;
		try {
			const fileName = buildPartFileName(
				target.fileBaseName,
				session.partSuffix,
				target.partIndex,
				session.outputFormat,
			);
			const filePath = await this.finalizer.finalizeSegmentsToFile(
				segmentPaths,
				fileName,
			);
			if (filePath) {
				target.partPaths.push(filePath);
				this.journal.addPart(target.fileBaseName, filePath);
				this.debugLogger.log('Auto-split part saved', { filePath });
				new Notice(`Recording part ${String(target.partIndex)} saved`);
			} else {
				target.partIndex -= 1;
			}
		} catch (error) {
			target.partIndex -= 1;
			target.segmentPaths = [...segmentPaths, ...target.segmentPaths];
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to finalize recording part:`,
				error,
			);
			new Notice(
				'Failed to save recording part. Recording continues; data is kept for the next part.',
			);
		}
	}
}
