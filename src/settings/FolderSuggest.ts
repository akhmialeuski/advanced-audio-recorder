/**
 * Native Obsidian popover suggestions for folder-path text inputs,
 * replacing the plain <datalist> the save-folder fields used before -
 * the popover matches Obsidian's styling and filters as the user types.
 * @module settings/FolderSuggest
 */

import { AbstractInputSuggest } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Suggests existing vault folder paths for a text input.
 */
export class FolderSuggest extends AbstractInputSuggest<string> {
	/**
	 * @param app - Obsidian App instance
	 * @param textInputEl - The input element to attach suggestions to
	 * @param folders - Supplier of the current folder paths (read per
	 *   query so a folder created while the dialog is open still appears)
	 */
	constructor(
		app: App,
		private readonly textInputEl: HTMLInputElement,
		private readonly folders: () => string[],
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		return this.folders().filter((folder) =>
			folder.toLowerCase().includes(lower),
		);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	override selectSuggestion(value: string): void {
		this.setValue(value);
		// Fire the input event so the wrapping TextComponent's onChange
		// (which persists the setting) sees the picked value.
		this.textInputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}
