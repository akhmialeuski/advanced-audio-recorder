/**
 * The notice a long audio job keeps on screen while nothing else shows it:
 * a conversion or a split whose dialog was closed, or one started from the
 * command line. It carries the job's progress and the Cancel that stops it.
 *
 * Without it a job with no dialog had nowhere to be stopped from. The
 * dialogs' own background notice only said the job went on, and the command
 * line, whose host hands its handler no signal to interrupt it, said nothing
 * until the job was over.
 * @module ui/JobProgressNotice
 */

import { Notice } from 'obsidian';
import {
	CancellationSource,
	type CancellationToken,
} from '../utils/cancellation';

/**
 * A notice with a job's progress and a Cancel button, shown until the job's
 * owner hides it.
 */
export class JobProgressNotice {
	/**
	 * Runs a job that has no dialog of its own with the notice on screen for
	 * as long as it runs, so it reports its progress and can be cancelled,
	 * and removes the notice however the job ends.
	 * @param title - What the job is doing, the notice's prefix
	 * @param job - The job, handed its progress callback and cancellation
	 * @returns What the job returned
	 */
	static async around<T>(
		title: string,
		job: (
			onProgress: (text: string) => void,
			token: CancellationToken,
		) => Promise<T>,
	): Promise<T> {
		const cancellation = new CancellationSource();
		const notice = new JobProgressNotice(title, cancellation);
		try {
			return await job((text) => {
				notice.setProgress(text);
			}, cancellation.token);
		} finally {
			notice.hide();
		}
	}

	private readonly notice: Notice;
	/** The text part of the notice, rewritten as the job progresses. */
	private readonly textEl: HTMLElement;
	/** Set once Cancel was pressed, so later progress does not hide it. */
	private cancelling = false;

	/**
	 * Shows the notice.
	 * @param title - What the job is doing, such as `Converting "take.webm"`,
	 *   which every later progress line is prefixed with
	 * @param cancellation - The job's cancellation, which Cancel pulls
	 * @param initialText - What the notice reads before any progress arrives
	 */
	constructor(
		private readonly title: string,
		cancellation: CancellationSource,
		initialText = `${title}...`,
	) {
		this.textEl = createSpan({ text: initialText });
		const button = createEl('button', {
			cls: 'aar-notice-action',
			text: 'Cancel',
			attr: { type: 'button' },
		});
		button.addEventListener('click', (event) => {
			// A click on a notice also dismisses it, which would leave the
			// job running with nothing on screen to say so.
			event.stopPropagation();
			button.disabled = true;
			this.cancelling = true;
			this.textEl.setText(`${this.title}: cancelling...`);
			cancellation.cancel();
		});
		const fragment = createFragment();
		fragment.append(this.textEl, ' ', button);
		// Timeout 0 keeps the notice until the job's owner hides it.
		this.notice = new Notice(fragment, 0);
	}

	/**
	 * Shows the job's latest progress.
	 * @param text - Progress text; an empty string leaves the notice as it is
	 */
	setProgress(text: string): void {
		if (text !== '' && !this.cancelling) {
			this.textEl.setText(`${this.title}: ${text}`);
		}
	}

	/** Removes the notice, once the job is over however it ended. */
	hide(): void {
		this.notice.hide();
	}
}
