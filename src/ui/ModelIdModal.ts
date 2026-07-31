/**
 * Asks for one model id, which is what a settings list's add affordance opens.
 *
 * The settings guide keeps a tab out of the form business: a collection there
 * lists what exists and hands construction to a dialog. This is that dialog for
 * the per-engine model lists - one field, validated the way the stored ids are,
 * with the add button disabled until the field holds something usable.
 * @module ui/ModelIdModal
 */

import { Setting } from 'obsidian';
import type { App, ButtonComponent } from 'obsidian';
import { PluginModal } from './PluginModal';
import { normalizeModelId } from '../settings/modelList';

export class ModelIdModal extends PluginModal {
	private draft = '';
	private addButton: ButtonComponent | null = null;

	/**
	 * Creates the dialog.
	 * @param app - The Obsidian App instance
	 * @param onAdd - Receives the entered id once the user confirms
	 */
	constructor(
		app: App,
		private readonly onAdd: (id: string) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Add model');
		new Setting(this.contentEl)
			.setName('Model ID')
			.setDesc('The ID your endpoint serves, for example whisper-1.')
			.addText((text) => {
				text.setPlaceholder('Model ID').onChange((value) => {
					this.draft = value;
					this.addButton?.setDisabled(normalizeModelId(value) === '');
				});
				text.inputEl.focus();
			});
		this.renderActions(
			{
				text: 'Add',
				cta: true,
				disabled: true,
				ref: (button): void => {
					this.addButton = button;
				},
				onClick: (): void => {
					const id = normalizeModelId(this.draft);
					if (id === '') {
						return;
					}
					this.close();
					this.onAdd(id);
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
}
