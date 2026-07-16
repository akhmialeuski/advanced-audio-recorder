/**
 * Serialized per-track write queue for the recording pipeline.
 * Owns the pendingWrite promise chain of each RecordingTarget and the
 * buffer-flush operations it serializes. Chain failures are contained:
 * a rejected link would otherwise skip every later queued task (audio
 * chunks silently dropped) and surface as unhandled rejections in the
 * fire-and-forget recorder callbacks.
 * @module recording/TrackWriteQueue
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { RecordingSessionConfig, RecordingTarget } from '../types';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { concatArrayBuffers } from '../utils/buffers';
import { resolveUniquePath } from '../audio/RecordingFileManager';
import { buildMimeType } from '../audio/AudioCapabilityDetector';
import { SessionJournal } from './SessionJournal';

/**
 * Serializes buffer and flush operations per recording target and
 * writes buffered audio to vault segment files.
 */
export class TrackWriteQueue {
	/** Session configuration set by beginSession. */
	private session: RecordingSessionConfig | null = null;
	/** Whether a buffered-write failure Notice is currently shown. */
	private writeFailureNotified = false;

	/**
	 * Creates a new TrackWriteQueue.
	 * @param app - The Obsidian App instance
	 * @param settings - Plugin settings (live reference)
	 * @param journal - Crash-recovery journal tracking segment files
	 */
	constructor(
		private readonly app: App,
		private settings: AudioRecorderSettings,
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
	 * re-arms the write-failure Notice.
	 * @param session - Session configuration snapshot
	 */
	beginSession(session: RecordingSessionConfig): void {
		this.session = session;
		this.writeFailureNotified = false;
	}

	/**
	 * Returns the active session configuration.
	 * @throws Error when called outside a recording session
	 */
	private requireSession(): RecordingSessionConfig {
		if (!this.session) {
			throw new Error('No active recording session');
		}
		return this.session;
	}

	/**
	 * Appends a task to the target's serialized write chain, containing
	 * failures so one failed flush can never poison the chain. A failed
	 * flush keeps its data buffered, so containment loses no audio -
	 * the flush is retried on the next chunk over the threshold and at
	 * finalization.
	 * @param target - Recording target whose chain to append to
	 * @param task - Buffer or flush operation to serialize
	 * @returns Promise resolving when the task settled (never rejects)
	 */
	enqueue(target: RecordingTarget, task: () => Promise<void>): Promise<void> {
		const link = target.pendingWrite.then(task).catch((error: unknown) => {
			this.reportWriteFailure(error);
		});
		target.pendingWrite = link;
		return link;
	}

	/**
	 * Waits until every queued write of the given targets has settled.
	 * Never rejects: chain links contain their own failures.
	 * @param targets - Recording targets to drain
	 */
	async drain(targets: RecordingTarget[]): Promise<void> {
		await Promise.all(targets.map((target) => target.pendingWrite));
	}

	/**
	 * Reports a failed buffered write once per failure streak: once the
	 * buffer is over the flush threshold every following chunk retries
	 * the flush, and a Notice per retry would flood the UI. The notice
	 * re-arms after the next successful flush and at session start.
	 * @param error - The write failure
	 */
	private reportWriteFailure(error: unknown): void {
		console.error(
			`${PLUGIN_LOG_PREFIX} Failed to write buffered audio; data stays buffered for retry:`,
			error,
		);
		if (this.writeFailureNotified) {
			return;
		}
		this.writeFailureNotified = true;
		new Notice(
			'Failed to write recording data to disk. Audio stays buffered and writing is retried while the recording continues.',
		);
	}

	/**
	 * Flushes buffered MediaRecorder chunks of a target to a raw `.tmp`
	 * segment file in the recorder container. Segments are byte
	 * fragments of one continuous recorder stream; the finalization
	 * paths concatenate them back into a whole container before any
	 * conversion, so a flush is valid at any point of the stream. On
	 * platforms whose flushes must produce standalone files instead
	 * (mobile, no recovery journal), the rotation controller stops the
	 * recorders before calling this, so the flushed segment is a
	 * complete container that finalization immediately converts and
	 * removes. Journaling is a no-op where no journal session is active.
	 * @param target - Recording target to flush
	 */
	async flushChunkBuffer(target: RecordingTarget): Promise<void> {
		if (target.bufferedChunks.length === 0) {
			return;
		}
		const session = this.requireSession();
		// The index is committed only after a successful write so a
		// failed flush retries under the same segment number
		const segmentIndex = target.segmentIndex + 1;
		const segmentName = `${target.fileBaseName}-part${String(segmentIndex)}.${session.recorderFormat}.tmp`;
		const segmentPath = await resolveUniquePath(
			segmentName,
			this.app,
			this.settings,
		);
		const combined = new Blob(target.bufferedChunks, {
			type: buildMimeType(session.recorderFormat),
		});
		// Temporary segment: a plain adapter write skips
		// createBinary's synchronous vault-index update and event
		// dispatch on the hot recording path (the watcher
		// reconciles the file later); final files use createBinary
		await this.app.vault.adapter.writeBinary(
			segmentPath,
			await combined.arrayBuffer(),
		);
		target.segmentPaths.push(segmentPath);
		this.journal.addSegment(target.fileBaseName, segmentPath);

		target.segmentIndex = segmentIndex;
		target.bufferedChunks = [];
		target.bufferedBytes = 0;
		// A successful flush ends the failure streak: re-arm the Notice
		this.writeFailureNotified = false;
	}

	/**
	 * Flushes buffered raw PCM data of a target to a `.tmp` segment
	 * file, merging the buffered chunks in capture order.
	 * @param target - Recording target to flush
	 */
	async flushPcmBuffer(target: RecordingTarget): Promise<void> {
		if (target.pcmBuffers.length === 0) {
			return;
		}
		// The index is committed only after a successful write so a
		// failed flush retries under the same segment number
		const segmentIndex = target.segmentIndex + 1;
		const segmentName = `${target.fileBaseName}-pcm-part${String(segmentIndex)}.tmp`;
		const segmentPath = await resolveUniquePath(
			segmentName,
			this.app,
			this.settings,
		);

		const merged = concatArrayBuffers(target.pcmBuffers);

		// Temporary segment: a plain adapter write skips createBinary's
		// synchronous vault-index update and event dispatch on the hot
		// recording path (the watcher reconciles the file later);
		// final files use createBinary
		await this.app.vault.adapter.writeBinary(segmentPath, merged.buffer);
		target.segmentIndex = segmentIndex;
		target.segmentPaths.push(segmentPath);
		this.journal.addSegment(target.fileBaseName, segmentPath);
		target.pcmBuffers = [];
		target.pcmBufferedBytes = 0;
		// A successful flush ends the failure streak: re-arm the Notice
		this.writeFailureNotified = false;
	}
}
