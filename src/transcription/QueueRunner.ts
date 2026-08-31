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
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptionQueue } from './TranscriptionQueue';
import type { TranscribeFileOptions } from './runTranscription';
import type { TranscribeRunCost } from './TranscriptionService';

/** Transcribes one recording; the run entry point, narrowed to what is used. */
export type QueueTranscriber = (
	file: TFile,
	options: TranscribeFileOptions,
) => Promise<{ cost: TranscribeRunCost }>;

/** Where a queued run's cost is reported, so the session total covers it. */
export interface QueueCostSink {
	/**
	 * Records one completed run.
	 * @param engineId - Engine that ran
	 * @param usd - Cost in USD, or null when it could not be priced
	 * @param estimated - Whether the figure is an estimate
	 */
	add(engineId: string, usd: number | null, estimated?: boolean): void;
}

/** What the runner needs to drain a queue. */
export interface QueueRunnerDeps {
	app: App;
	queue: TranscriptionQueue;
	getSettings: () => AudioRecorderSettings;
	transcribe: QueueTranscriber;
	/** Absent when the user turned cost estimates off. */
	costSink?: QueueCostSink | undefined;
}

/**
 * Runs the queued recordings, one after another.
 */
export class QueueRunner {
	/** Whether a drain is already in flight, so two never overlap. */
	private draining = false;

	/**
	 * @param deps - The queue, the app, and how to transcribe one recording
	 */
	constructor(private readonly deps: QueueRunnerDeps) {}

	/** Whether the queue is being drained right now. */
	isRunning(): boolean {
		return this.draining;
	}

	/**
	 * Transcribes every queued recording that is still waiting, stopping when
	 * the queue is paused or empty. Calling it while it is already running is
	 * a no-op, so the folder action, the resume prompt, and a view button can
	 * all ask without racing each other.
	 */
	async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			let entry = this.deps.queue.next();
			while (entry) {
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
			});
			this.recordCost(cost);
			this.deps.queue.setState(path, 'done');
		} catch (error) {
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

	/**
	 * Adds a finished run to the session total, by the same rule a single run
	 * follows: what the provider reported, or the estimate when it reported
	 * nothing, marked as an estimate either way.
	 * @param cost - What the run reported
	 */
	private recordCost(cost: TranscribeRunCost): void {
		if (!this.deps.getSettings().transcriptionShowCostEstimates) {
			return;
		}
		this.deps.costSink?.add(cost.engineId, cost.usd, cost.usd === null);
	}
}
