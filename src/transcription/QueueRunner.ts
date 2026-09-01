/**
 * Drains the transcription queue, one recording at a time.
 *
 * One at a time on purpose: the engines this queue calls are paid, rate
 * limited, and answer slowly for a long recording, and firing a folder's worth
 * of requests at once is the way to be refused by all of them at once. The
 * runner also stops at every boundary it can, so a Cancel or a Pause takes
 * effect after the recording in flight rather than at the end of the folder.
 * @module transcription/QueueRunner
 */

import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { CancellationSource } from '../utils/cancellation';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { RunCostSink } from './SessionCostTracker';
import type { TranscriptionQueue } from './TranscriptionQueue';
import type { TranscribeFileOptions } from './runTranscription';
import type { TranscribeRunCost } from './TranscriptionService';

/** Transcribes one recording; the run entry point, narrowed to what is used. */
export type QueueTranscriber = (
	file: TFile,
	options: TranscribeFileOptions,
) => Promise<{ cost: TranscribeRunCost }>;

/** What the runner needs to drain a queue. */
export interface QueueRunnerDeps {
	app: App;
	queue: TranscriptionQueue;
	getSettings: () => AudioRecorderSettings;
	transcribe: QueueTranscriber;
	/** Absent when the user turned cost estimates off. */
	costSink?: RunCostSink | undefined;
	/**
	 * How long one queued recording is assumed to be, in seconds, for the
	 * estimate a run falls back to when its provider reported no usage. The
	 * same figure the dialog priced the queue with, so what a run is recorded
	 * at cannot contradict what the user was quoted.
	 */
	assumedSecondsPerRecording: number;
}

/**
 * Runs the queued recordings, one after another.
 */
export class QueueRunner {
	/** Whether a drain is already in flight, so two never overlap. */
	private draining = false;

	/**
	 * Cancellation for the drain in flight. Rebuilt at the start of each one,
	 * because a cancelled source stays cancelled and the next Start has to be
	 * able to run.
	 */
	private cancellation = new CancellationSource();

	/**
	 * @param deps - The queue, the app, and how to transcribe one recording
	 */
	constructor(private readonly deps: QueueRunnerDeps) {}

	/** Whether the queue is being drained right now. */
	isRunning(): boolean {
		return this.draining;
	}

	/**
	 * Stops the drain: the request in flight is aborted and nothing after it
	 * is started.
	 *
	 * Called when the plugin unloads. The loop holds the app and the settings
	 * reader, so without this a disabled or reloading plugin went on calling a
	 * paid engine and writing transcripts into the vault, with nothing left on
	 * screen to say it was still working.
	 */
	stop(): void {
		this.cancellation.cancel();
	}

	/**
	 * Transcribes every queued recording that is still waiting, stopping when
	 * the queue is emptied, paused, or stopped. Calling it while it is already
	 * running is a no-op, so the folder action, the resume prompt, and a view
	 * button can all ask without racing each other.
	 *
	 * Starting lifts a pause the queue is still carrying, because every caller
	 * is a user asking for the queue to run. Left in place, that flag outlived
	 * the drain that honoured it: once the recording in flight had finished
	 * the loop exited, the dialog stopped offering Resume, and the queue could
	 * not be started again at all.
	 */
	async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.deps.queue.setPaused(false);
		this.cancellation = new CancellationSource();
		this.draining = true;
		try {
			let entry = this.deps.queue.next();
			while (entry && !this.cancellation.token.isCancelled()) {
				await this.runOne(entry.path);
				entry = this.deps.queue.next();
			}
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Transcribes one queued recording and records what happened to it. A
	 * failure marks that entry and the queue carries on: one recording the
	 * engine refused must not strand the rest of the folder.
	 * @param path - Vault-relative recording path
	 */
	private async runOne(path: string): Promise<void> {
		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.deps.queue.setState(
				path,
				'failed',
				'The recording is no longer in the vault.',
			);
			return;
		}
		this.deps.queue.setState(path, 'running');
		try {
			const { cost } = await this.deps.transcribe(file, {
				// A queued run has no note to write links against, so the
				// recording stands in for one: the transcript is written to
				// its own file, which is what a batch is for.
				notePathForLinks: file.path,
				// So the request in flight ends with the drain rather than
				// outliving the plugin that started it.
				token: this.cancellation.token,
			});
			// The queue does not measure a recording before sending it, so
			// the fallback estimate is sized by the same assumed length the
			// dialog priced the queue with.
			this.deps.costSink?.recordRun(
				cost,
				this.deps.getSettings(),
				this.deps.assumedSecondsPerRecording,
			);
			this.deps.queue.setState(path, 'done');
		} catch (error) {
			if (this.cancellation.token.isCancelled()) {
				// Stopped rather than refused, so the recording goes back in
				// the queue: it never had its chance, and recording it as a
				// failure would leave the user clearing by hand something the
				// engine never even answered about.
				this.deps.queue.setState(path, 'waiting');
				return;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			console.warn(
				`${PLUGIN_LOG_PREFIX} Queued transcription of ${path} failed:`,
				error,
			);
			new Notice(`Could not transcribe ${file.name}: ${message}`);
			this.deps.queue.setState(path, 'failed', message);
		}
	}
}
