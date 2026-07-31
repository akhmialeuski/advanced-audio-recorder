/**
 * Asks for the name of a profile, which is what creating or renaming one opens.
 *
 * A profile is edited on a page of its own, and from Obsidian 1.13 the settings
 * framework addresses an open page by its name: a name field on that page would
 * rename the page under itself and leave it unresolvable. The name is therefore
 * taken here, before the page exists or while the user is on it, and the caller
 * applies it and returns to the list where the new name is shown.
 *
 * Names have to be unique within their catalogue for the same reason, so the
 * dialog rejects a taken name (and a blank one) instead of letting the tab
 * declare two pages Obsidian cannot tell apart.
 * @module ui/ProfileNameModal
 */

import { Setting } from 'obsidian';
import type { App, ButtonComponent } from 'obsidian';
import { PluginModal } from './PluginModal';

/** What the dialog asks for and what it does with the answer. */
export interface ProfileNamePrompt {
	/** Dialog title, e.g. "Rename profile". */
	readonly title: string;
	/** Label of the confirming button, e.g. "Rename". */
	readonly confirmText: string;
	/** Name the field opens with, empty when creating. */
	readonly initial: string;
	/**
	 * Why a name cannot be used, or undefined when it can. Keeps the rule with
	 * the catalogue that owns the names rather than in the dialog.
	 */
	rejection(name: string): string | undefined;
	/** Receives the accepted name. */
	onSubmit(name: string): void;
}

export class ProfileNameModal extends PluginModal {
	private draft: string;
	private confirmButton: ButtonComponent | null = null;
	private errorEl: HTMLElement | null = null;

	/**
	 * Creates the dialog.
	 * @param app - The Obsidian App instance
	 * @param prompt - The copy, the rule, and the handler
	 */
	constructor(
		app: App,
		private readonly prompt: ProfileNamePrompt,
	) {
		super(app);
		this.draft = prompt.initial;
	}

	override onOpen(): void {
		this.setDialogTitle(this.prompt.title);
		new Setting(this.contentEl)
			.setName('Profile name')
			.setDesc('Shown wherever this profile is picked.')
			.addText((text) => {
				text.setValue(this.draft).onChange((value) => {
					this.draft = value;
					this.showRejection(text.inputEl);
				});
				text.inputEl.focus();
				text.inputEl.select();
			});
		// Empty until something is wrong, which is also how it stays out of the
		// layout: the stylesheet hides it while it holds no message.
		this.errorEl = this.contentEl.createDiv({ cls: 'aar-modal-error' });
		this.renderActions(
			{
				text: this.prompt.confirmText,
				cta: true,
				disabled: this.rejection() !== undefined,
				ref: (button): void => {
					this.confirmButton = button;
				},
				onClick: (): void => {
					if (this.rejection() !== undefined) {
						return;
					}
					const name = this.draft.trim();
					this.close();
					this.prompt.onSubmit(name);
				},
			},
			{
				text: 'Cancel',
				onClick: (): void => {
					this.close();
				},
			},
		);
	}

	/** Why the drafted name cannot be used, or undefined when it can. */
	private rejection(): string | undefined {
		return this.prompt.rejection(this.draft.trim());
	}

	/**
	 * Reports the current draft's rejection, if any, and blocks confirming
	 * while it stands.
	 * @param inputEl - The name field, marked while its value is rejected
	 */
	private showRejection(inputEl: HTMLInputElement): void {
		const rejection = this.rejection();
		this.confirmButton?.setDisabled(rejection !== undefined);
		inputEl.toggleClass('aar-input-invalid', rejection !== undefined);
		this.errorEl?.setText(rejection ?? '');
	}
}
