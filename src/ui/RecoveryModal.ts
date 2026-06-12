/**
 * Modal offering recovery of recording sessions that were interrupted
 * by a crash, power loss, or plugin unload. Pure form: the actual
 * recovery and discard work is injected as callbacks, and closing the
 * modal without a decision leaves the journal untouched so the prompt
 * returns on the next launch.
 * @module ui/RecoveryModal
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { JournalSession } from '../recording/SessionJournal';

/**
 * Actions the user can take on the interrupted sessions.
 */
export interface RecoveryModalCallbacks {
	/** Recovers all offered sessions into playable audio files. */
	onRecover: () => Promise<void>;
	/** Discards the temporary files of all offered sessions. */
	onDiscard: () => Promise<void>;
}

/**
 * Modal listing interrupted recording sessions with recover/discard
 * actions.
 */
export class RecoveryModal extends Modal {
	/** Guards against double-clicking an action button. */
	private isRunning = false;

	/**
	 * Creates a new RecoveryModal.
	 * @param app - The Obsidian App instance
	 * @param sessions - Interrupted sessions with recoverable files
	 * @param callbacks - Recover and discard actions
	 */
	constructor(
		app: App,
		private readonly sessions: JournalSession[],
		private readonly callbacks: RecoveryModalCallbacks,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl)
			.setName('Interrupted recording found')
			.setHeading();
		contentEl.createEl('p', {
			text: 'A previous recording session did not finish. Its temporary audio data is still on disk and can be recovered into playable files.',
			cls: 'aar-recovery-intro',
		});

		for (const session of this.sessions) {
			const startedAt = new Date(session.startedAt).toLocaleString();
			const trackCount = session.tracks.length;
			const segmentCount = session.tracks.reduce(
				(sum, track) => sum + track.segmentPaths.length,
				0,
			);
			const partCount = session.tracks.reduce(
				(sum, track) => sum + track.partPaths.length,
				0,
			);
			const parts =
				partCount > 0
					? ` ${String(partCount)} already saved part file(s) are safe and stay untouched.`
					: '';
			contentEl.createEl('p', {
				text: `${startedAt} — ${String(trackCount)} track(s), ${String(segmentCount)} temporary segment(s).${parts}`,
				cls: 'aar-recovery-session',
			});
		}

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Recover audio')
					.setCta()
					.onClick(() => {
						void this.runAction(this.callbacks.onRecover);
					}),
			)
			.addButton((button) =>
				button.setButtonText('Discard').onClick(() => {
					void this.runAction(this.callbacks.onDiscard);
				}),
			)
			.addButton((button) =>
				button.setButtonText('Decide later').onClick(() => {
					this.close();
				}),
			);
	}

	onClose(): void {
		// Closing without a decision keeps the journal untouched: the
		// prompt returns on the next launch
		this.contentEl.empty();
	}

	/**
	 * Runs an action exactly once and closes the modal afterwards. A
	 * failing action is contained here: the call sites are
	 * fire-and-forget click handlers, where a rejection would surface
	 * as an unhandled rejection while the modal closes silently.
	 * @param action - Recover or discard callback
	 */
	private async runAction(action: () => Promise<void>): Promise<void> {
		if (this.isRunning) {
			return;
		}
		this.isRunning = true;
		try {
			await action();
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Recovery action failed:`,
				error,
			);
			new Notice(
				'The recovery action failed. Check the console for details.',
			);
		} finally {
			this.isRunning = false;
			this.close();
		}
	}
}
