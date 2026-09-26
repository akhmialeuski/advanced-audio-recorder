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
	/**
	 * Called once when the dialog closes without a confirmation, whether the
	 * user pressed Cancel, Escape, or the window's close button. Optional: a
	 * caller that only acts on a yes has nothing to do here, while one that
	 * awaits an answer needs the no as much as the yes.
	 */
	onCancel?: () => void;
}

/**
 * Yes/no confirmation dialog.
 */
export class ConfirmModal extends PluginModal {
	/**
	 * Whether the confirm button was pressed, so closing the dialog any other
	 * way - Cancel, Escape, the window chrome - reports the no exactly once.
	 */
	private confirmed = false;

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
					this.confirmed = true;
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

	override onClose(): void {
		super.onClose();
		if (!this.confirmed) {
			this.options.onCancel?.();
		}
	}
}

/**
 * Asks for a confirmation and answers it: true when the user confirmed, false
 * when the dialog was closed any other way. For a caller that awaits the
 * answer in the middle of its work rather than continuing in a callback.
 * @param app - Obsidian App
 * @param options - Title, message and the confirm button's label
 * @returns Whether the user confirmed
 */
export function confirmAction(
	app: App,
	options: Omit<ConfirmModalOptions, 'onConfirm' | 'onCancel'>,
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, {
			...options,
			onConfirm: () => {
				resolve(true);
			},
			onCancel: () => {
				resolve(false);
			},
		}).open();
	});
}
