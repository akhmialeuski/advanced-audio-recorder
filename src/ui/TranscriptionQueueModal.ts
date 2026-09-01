/**
 * The transcription queue, shown before it starts and while it runs.
 *
 * One dialog rather than two, because it answers one question at two moments:
 * what is in the queue. Before it starts that is a list to approve with what
 * it will cost; while it runs it is the same list with what each recording is
 * doing, and the controls to pause it or drop an entry.
 * @module ui/TranscriptionQueueModal
 */

import { setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { PluginModal } from './PluginModal';
import { formatUsd } from '../transcription/costs';
import type {
	QueueEntry,
	QueueEntryState,
} from '../transcription/TranscriptionQueue';
import type { TranscriptionQueue } from '../transcription/TranscriptionQueue';

/** Root class of the queue list. */
const QUEUE_LIST_CLASS = 'aar-queue-list';

/** Class of one row of the list. */
const QUEUE_ROW_CLASS = 'aar-queue-row';

/** Class of the state word on a row. */
const QUEUE_STATE_CLASS = 'aar-queue-state';

/** Class of the drop button on a row. */
const QUEUE_REMOVE_CLASS = 'aar-queue-remove';

/** Class of the line naming what the queue will cost. */
const QUEUE_COST_CLASS = 'aar-queue-cost';

/** What each state is called on screen. */
const STATE_LABELS: Record<QueueEntryState, string> = {
	waiting: 'Waiting',
	running: 'Transcribing',
	done: 'Done',
	failed: 'Failed',
};

/** What the dialog needs beyond the queue itself. */
export interface QueueModalOptions {
	/** The queue being shown. */
	queue: TranscriptionQueue;
	/**
	 * What one queued recording is expected to cost, or null when the run
	 * cannot be priced (an unknown model, a free local engine).
	 *
	 * Per recording rather than a total, because the dialog owns the count:
	 * it reads how many are still pending from the live queue, so a total
	 * priced elsewhere named a spend for a queue the user had since edited.
	 */
	usdPerRecording: number | null;
	/** Whether any queued recording could not be priced. */
	hasUnpriced: boolean;
	/** Starts draining the queue. */
	onStart: () => void;
	/** Whether the queue is being drained right now. */
	isRunning: () => boolean;
}

/**
 * Shows the queue and the controls over it.
 */
export class TranscriptionQueueModal extends PluginModal {
	/** The list element, rebuilt whenever the queue moves. */
	private listEl: HTMLElement | null = null;

	/** The cost line, rewritten whenever the queue moves. */
	private costEl: HTMLElement | null = null;

	/** Drops the queue subscription when the dialog closes. */
	private unsubscribe: (() => void) | null = null;

	/**
	 * @param app - Obsidian App instance
	 * @param options - The queue, its estimate, and how to start it
	 */
	constructor(
		app: App,
		private readonly options: QueueModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		const running = this.options.isRunning();
		this.setDialogTitle(
			running ? 'Transcription queue' : 'Queue these recordings',
		);
		this.costEl = this.contentEl.createDiv({ cls: QUEUE_COST_CLASS });
		this.renderCost();
		this.listEl = this.contentEl.createDiv({ cls: QUEUE_LIST_CLASS });
		this.renderList();
		// Both halves follow the same change, because they describe the same
		// queue: dropping an entry that the list stops showing must not leave
		// the line above it quoting a spend for work that is no longer there.
		this.unsubscribe = this.options.queue.subscribe(() => {
			this.renderCost();
			this.renderList();
		});
		this.renderControls(running);
	}

	override onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// Closing the dialog leaves the queue running: it is the work that
		// matters, not the window looking at it.
		super.onClose();
	}

	/** Says what the queued recordings still to run are expected to cost. */
	private renderCost(): void {
		if (!this.costEl) {
			return;
		}
		const { usdPerRecording, hasUnpriced } = this.options;
		// One count for both halves of the sentence, so the number of
		// recordings named and the money named describe the same work.
		const count = this.options.queue.pendingCount();
		const priced =
			usdPerRecording === null
				? 'no built-in rate for the selected model'
				: `about ${formatUsd(usdPerRecording * count)}`;
		this.costEl.setText(
			`${String(count)} recording${count === 1 ? '' : 's'}, ${priced}.` +
				(hasUnpriced
					? ' Some of it could not be priced and is left out of the total.'
					: ''),
		);
	}

	/** Draws one row per queued recording, replacing whatever was there. */
	private renderList(): void {
		const list = this.listEl;
		if (!list) {
			return;
		}
		list.empty();
		for (const entry of this.options.queue.entries()) {
			this.renderRow(list, entry);
		}
	}

	/**
	 * Draws one recording: its name, what it is doing, and a way to drop it.
	 * @param list - The list to draw into
	 * @param entry - The queued recording
	 */
	private renderRow(list: HTMLElement, entry: QueueEntry): void {
		const row = list.createDiv({ cls: QUEUE_ROW_CLASS });
		row.createSpan({
			text: entry.path.slice(entry.path.lastIndexOf('/') + 1),
		});
		row.createSpan({
			cls: QUEUE_STATE_CLASS,
			// The reason is what makes a failed row actionable; without it the
			// user is told only that something went wrong.
			text: entry.error
				? `${STATE_LABELS[entry.state]}: ${entry.error}`
				: STATE_LABELS[entry.state],
		});
		// Not offered for the recording in flight: stopping that one is the
		// run's own business, and the button would do nothing.
		if (entry.state === 'running') {
			return;
		}
		const remove = row.createEl('button', {
			cls: QUEUE_REMOVE_CLASS,
			attr: { type: 'button', 'aria-label': `Drop ${entry.path}` },
		});
		setIcon(remove, 'x');
		remove.addEventListener('click', () => {
			this.options.queue.remove(entry.path);
		});
	}

	/**
	 * Draws the buttons under the list: start it, or pause and resume it.
	 *
	 * Closing the dialog and emptying the queue are two buttons rather than
	 * one. They were a single "Cancel", which read as "I did not mean to open
	 * this" and answered by throwing the queue away: the dialog is reachable
	 * from the command palette at any time, so a user who opened it to look at
	 * a folder queued the night before lost the folder by dismissing it.
	 * @param running - Whether the queue is already being drained
	 */
	private renderControls(running: boolean): void {
		if (!running) {
			this.renderActions(
				{
					text: 'Start',
					cta: true,
					onClick: () => {
						this.options.onStart();
						this.close();
					},
				},
				{
					text: 'Close',
					onClick: () => {
						this.close();
					},
				},
				{
					text: 'Discard queue',
					destructive: true,
					onClick: () => {
						this.options.queue.clear();
						this.close();
					},
				},
			);
			return;
		}
		this.renderActions(
			{
				text: this.options.queue.isPaused() ? 'Resume' : 'Pause',
				onClick: () => {
					const paused = this.options.queue.isPaused();
					this.options.queue.setPaused(!paused);
					if (paused) {
						this.options.onStart();
					}
					this.close();
				},
			},
			{
				text: 'Close',
				onClick: () => {
					this.close();
				},
			},
		);
	}
}
