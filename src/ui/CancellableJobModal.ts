/**
 * The frame of a dialog that runs one cancellable job on a file, which the
 * conversion and the split dialogs used to write out line for line: a run
 * button with a Cancel beside it that shows only while the job runs, progress
 * mirrored into a notice that keeps the Cancel once the dialog is closed, and
 * the dialog closed when the job is done.
 * @module ui/CancellableJobModal
 */

import type { ButtonComponent } from 'obsidian';
import { PluginModal } from './PluginModal';
import { JobProgressNotice } from './JobProgressNotice';
import {
	CancellationSource,
	type CancellationToken,
} from '../utils/cancellation';

/**
 * A dialog whose one job can be cancelled from the dialog and, once the
 * dialog is closed, from the notice that takes its place.
 */
export abstract class CancellableJobModal extends PluginModal {
	/**
	 * The cancellation of the latest run, replaced at every run. Whether one
	 * is running is the frame's busy flag; this is only what Cancel pulls.
	 */
	private cancellation = new CancellationSource();
	/** The run button, disabled while the job runs. */
	private runButton: ButtonComponent | null = null;
	/** The Cancel button, shown only while the job runs. */
	private cancelButton: ButtonComponent | null = null;
	/** Progress notice shown when the dialog is closed mid-run. */
	private progressNotice: JobProgressNotice | null = null;

	/**
	 * What the job is doing, such as `Converting "take.webm"`, which titles
	 * the notice a dialog closed mid-run leaves behind.
	 */
	protected abstract jobTitle(): string;

	/**
	 * Renders the run button and the Cancel that stops the run.
	 * @param runText - Label of the run button
	 * @param progressEl - Progress element inside the dialog
	 * @param run - Starts the job, through {@link runJob}
	 */
	protected renderJobActions(
		runText: string,
		progressEl: HTMLElement,
		run: () => Promise<void>,
	): void {
		this.renderActions(
			{
				text: runText,
				cta: true,
				ref: (button) => {
					this.runButton = button;
				},
				onClick: run,
			},
			{
				text: 'Cancel',
				ref: (button) => {
					this.cancelButton = button;
					button.buttonEl.toggle(false);
				},
				onClick: () => {
					this.cancelButton?.setDisabled(true);
					this.setProgress(progressEl, 'Cancelling...');
					this.cancellation.cancel();
				},
			},
		);
	}

	/**
	 * Shows the job's progress in the dialog and mirrors it to the notice
	 * when the dialog was closed mid-run.
	 * @param progressEl - Progress element inside the dialog
	 * @param text - Progress text; an empty string clears the element
	 */
	protected setProgress(progressEl: HTMLElement, text: string): void {
		progressEl.setText(text);
		this.progressNotice?.setProgress(text);
	}

	/**
	 * Runs the job, at most one at a time, with the Cancel offered for as
	 * long as it runs, and closes the dialog once the job says it is done.
	 * @param job - The work, handed the run's cancellation; resolves true
	 *   when the dialog has nothing left to show
	 */
	protected async runJob(
		job: (token: CancellationToken) => Promise<boolean>,
	): Promise<void> {
		let done = false;
		await this.runExclusive(async () => {
			this.cancellation = new CancellationSource();
			this.runButton?.setDisabled(true);
			this.cancelButton?.setDisabled(false);
			this.cancelButton?.buttonEl.toggle(true);
			try {
				done = await job(this.cancellation.token);
			} finally {
				this.runButton?.setDisabled(false);
				this.cancelButton?.buttonEl.toggle(false);
				this.progressNotice?.hide();
				this.progressNotice = null;
			}
		});
		// Closed once the run is over, so onClose finds nothing running and
		// leaves no notice for a job that has finished.
		if (done) {
			this.close();
		}
	}

	override onClose(): void {
		if (this.busy && !this.progressNotice) {
			// The notice is where the job can still be cancelled from;
			// setProgress mirrors further progress into it
			const title = this.jobTitle();
			this.progressNotice = new JobProgressNotice(
				title,
				this.cancellation,
				`${title} continues in the background...`,
			);
		}
		super.onClose();
	}
}
