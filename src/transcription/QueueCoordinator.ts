/**
 * Ties the queue, its runner, and the dialog over them into the one thing the
 * rest of the plugin talks to: queue a folder, resume what a previous session
 * left, show what is in it.
 * @module transcription/QueueCoordinator
 */

import { Notice, TFile, TFolder } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import { isAudioFile } from '../utils/audioFile';
import { ConfirmModal } from '../ui/ConfirmModal';
import { TranscriptionQueueModal } from '../ui/TranscriptionQueueModal';
import { buildCostEstimate } from './costs';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { QueueRunner } from './QueueRunner';
import type { TranscriptionQueue } from './TranscriptionQueue';

/** What the coordinator needs. */
export interface QueueCoordinatorDeps {
	app: App;
	queue: TranscriptionQueue;
	runner: QueueRunner;
	getSettings: () => AudioRecorderSettings;
	/**
	 * How long one queued recording is expected to be, in seconds, when
	 * nothing better is known. The estimate is per recording and the queue
	 * does not probe every file: reading a folder of recordings to price them
	 * would cost more than the dialog it is shown in.
	 */
	assumedSecondsPerRecording: number;
}

/**
 * Owns the queue for the plugin.
 */
export class QueueCoordinator {
	/**
	 * @param deps - The queue, its runner, and the settings that price it
	 */
	constructor(private readonly deps: QueueCoordinatorDeps) {}

	/**
	 * Stops a drain in flight, for plugin unload. The coordinator is what the
	 * plugin holds, so the lifecycle reaches the runner through here.
	 */
	stop(): void {
		this.deps.runner.stop();
	}

	/**
	 * Queues every recording in a folder and shows what will run. Recordings
	 * already queued are skipped, so queueing a folder twice does not
	 * transcribe anything twice.
	 * @param folder - The folder to queue
	 */
	async queueFolder(folder: TFolder): Promise<void> {
		await this.deps.queue.load();
		const paths = recordingsIn(folder);
		if (paths.length === 0) {
			new Notice(`${folder.name} holds no recordings to transcribe.`);
			return;
		}
		const added = this.deps.queue.add(paths);
		if (added === 0) {
			new Notice(
				`Every recording in ${folder.name} is already in the queue.`,
			);
		}
		this.open();
	}

	/**
	 * Shows the queue as it stands, with what it will cost and the controls
	 * over it.
	 */
	open(): void {
		const settings = this.deps.getSettings();
		// Priced per recording and multiplied by the dialog, which reads how
		// many are still to run from the live queue: a queue reopened after it
		// drained has nothing left to bill for, and one edited while it is
		// open must not go on quoting the count it was opened with.
		const one = buildCostEstimate(
			settings,
			this.deps.assumedSecondsPerRecording,
		);
		new TranscriptionQueueModal(this.deps.app, {
			queue: this.deps.queue,
			usdPerRecording: one.totalUsd,
			hasUnpriced: one.hasUnpriced,
			onStart: () => {
				void this.deps.runner.drain();
			},
			isRunning: () => this.deps.runner.isRunning(),
		}).open();
	}

	/**
	 * Offers to carry on with a queue a previous session left unfinished.
	 * Asked rather than assumed: the queue calls paid APIs, and starting one
	 * because Obsidian was reopened is not a decision to make for the user.
	 */
	async resumeIfPending(): Promise<void> {
		await this.deps.queue.load();
		this.deps.queue.requeueInterrupted();
		if (!this.deps.queue.hasWork()) {
			return;
		}
		const waiting = this.deps.queue
			.entries()
			.filter((entry) => entry.state === 'waiting').length;
		new ConfirmModal(this.deps.app, {
			title: 'Continue the transcription queue',
			message:
				`${String(waiting)} recording${waiting === 1 ? '' : 's'} from a ` +
				'previous session are still queued. Transcribing them calls a ' +
				'paid API. Continue?',
			confirmText: 'Continue',
			onConfirm: () => {
				void this.deps.runner.drain();
			},
		}).open();
		// Declining leaves the queue where it is rather than discarding it:
		// "not now" is not "throw away the folder I queued last night", and
		// the offer comes back next session or from the queue itself.
	}
}

/**
 * The recordings a folder holds, including those in the folders under it.
 * @param folder - The folder to look in
 * @returns Vault-relative recording paths, in vault order
 */
function recordingsIn(folder: TFolder): string[] {
	const paths: string[] = [];
	const walk = (item: TAbstractFile): void => {
		if (item instanceof TFile) {
			if (isAudioFile(item)) {
				paths.push(item.path);
			}
			return;
		}
		if (item instanceof TFolder) {
			for (const child of item.children) {
				walk(child);
			}
		}
	};
	walk(folder);
	return paths;
}
