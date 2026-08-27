/**
 * Modal offering recovery of recording sessions that were interrupted
 * by a crash, power loss, or plugin unload. Pure form: the actual
 * recovery and discard work is injected as callbacks, and closing the
 * modal without a decision leaves the journal untouched so the prompt
 * returns on the next launch.
 * @module ui/RecoveryModal
 */

import { App, Notice, Setting } from 'obsidian';
import { PluginModal } from './PluginModal';
import { MS_PER_SECOND, PLUGIN_LOG_PREFIX } from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import type { JournalSession } from '../recording/api';

/**
 * Actions the user can take on the interrupted sessions.
 */
export interface RecoveryModalCallbacks {
	/** Recovers all offered sessions into playable audio files. */
	onRecover: () => Promise<void>;
	/** Discards the files of all offered sessions. */
	onDiscard: () => Promise<void>;
}

/**
 * One line describing what an interrupted session left on disk. The
 * two capture modes leave different things behind, and the choice the
 * user is about to make differs with them: rotation parts are the
 * recording, so a discard deletes them, while auto-split parts are
 * output the user already has and are only mentioned. A rotation
 * session that never finished a part is neither: it is described by
 * the unfinished stream it did leave.
 * @param session - Interrupted session as returned by the collect step
 * @returns Text of the session line
 */
function describeSession(session: JournalSession): string {
	const startedAt = new Date(session.startedAt).toLocaleString();
	const segmentCount = session.tracks.reduce(
		(sum, track) => sum + track.segmentPaths.length,
		0,
	);
	const partCount = session.tracks.reduce(
		(sum, track) => sum + track.partPaths.length,
		0,
	);
	const recorded =
		session.recordedMs === undefined
			? ''
			: `, ${formatTimecode(session.recordedMs / MS_PER_SECOND)} recorded`;
	if (session.captureMode === 'rotation' && partCount > 0) {
		const residue =
			segmentCount > 0
				? ` The unfinished part left ${String(segmentCount)} temporary segment(s), which are recovered too.`
				: '';
		return `${startedAt}${recorded} - ${String(partCount)} part file(s) hold this recording. Recovering keeps them, discarding deletes them.${residue}`;
	}
	if (session.captureMode === 'rotation') {
		// Interrupted before its first rotation, or left with the parts
		// deleted: the unfinished stream is the whole of what survived,
		// and it is reassembled the way any other stream is
		return `${startedAt} - an unfinished recording of ${String(segmentCount)} temporary segment(s), reassembled into one file.`;
	}
	const parts =
		partCount > 0
			? ` ${String(partCount)} already saved part file(s) are safe and stay untouched.`
			: '';
	return `${startedAt}${recorded} - ${String(session.tracks.length)} track(s), ${String(segmentCount)} temporary segment(s).${parts}`;
}

/**
 * Modal listing interrupted recording sessions with recover/discard
 * actions.
 */
export class RecoveryModal extends PluginModal {
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

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl)
			.setName('Interrupted recording found')
			.setHeading();
		contentEl.createEl('p', {
			text: 'A previous recording session did not finish. What it wrote to disk is listed below, and you can keep it or discard it.',
			cls: 'aar-recovery-intro',
		});

		for (const session of this.sessions) {
			contentEl.createEl('p', {
				text: describeSession(session),
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

	override onClose(): void {
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
