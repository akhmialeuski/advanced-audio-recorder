/**
 * A minimal confirmation dialog: a message and a confirm/cancel pair. Used to
 * gate a destructive-ish action (for example regenerating chapters that would
 * replace existing ones) behind an explicit click.
 * @module ui/ConfirmModal
 */

import type { App } from 'obsidian';
import { PluginModal } from './PluginModal';

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
export class ConfirmModal extends PluginModal {
	constructor(
		app: App,
		private readonly options: ConfirmModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle(this.options.title);
		this.contentEl.createEl('p', { text: this.options.message });
		this.renderActions(
			{
				text: this.options.confirmText,
				destructive: true,
				onClick: () => {
					this.close();
					this.options.onConfirm();
				},
			},
			{
				text: 'Cancel',
				onClick: () => {
					this.close();
				},
			},
		);
	}
}
