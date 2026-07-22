/**
 * A minimal confirmation dialog: a message and a confirm/cancel pair. Used to
 * gate a destructive-ish action (for example regenerating chapters that would
 * replace existing ones) behind an explicit click.
 * @module ui/ConfirmModal
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';

/** Text and callback for the confirmation dialog. */
export interface ConfirmModalOptions {
	/** Dialog title. */
	title: string;
	/** Explanatory message shown above the buttons. */
	message: string;
	/** Label of the confirm button (e.g. "Continue"). */
	confirmText: string;
	/** Called once when the user confirms. */
	onConfirm: () => void;
}

/**
 * Yes/no confirmation dialog.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: ConfirmModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl('p', { text: this.options.message });
		const actions = this.contentEl.createDiv({
			cls: 'modal-button-container',
		});
		const confirmButton = actions.createEl('button', {
			cls: 'mod-warning',
			text: this.options.confirmText,
		});
		confirmButton.addEventListener('click', () => {
			this.close();
			this.options.onConfirm();
		});
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
