/**
 * Native Obsidian popover suggestions for a text input, filtered from a
 * supplied list. One implementation serves every suggesting field - folder
 * paths in settings, participant names in the speaker rename dialog - because
 * the behavior they need is identical: read the current candidates, keep the
 * ones containing the typed text, and write the picked value back through an
 * `input` event so the field's own listener persists it.
 *
 * The candidates are read per query rather than captured once, so a folder
 * created or a participant named while the dialog is open shows up on the next
 * keystroke.
 * @module ui/TextInputSuggest
 */

import { AbstractInputSuggest } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Suggests values from a live list for a text input.
 */
export class TextInputSuggest extends AbstractInputSuggest<string> {
	/**
	 * @param app - Obsidian App instance
	 * @param textInputEl - The input element to attach suggestions to
	 * @param candidates - Supplier of the current candidate values, read per
	 *   query so a value added while the dialog is open still appears
	 */
	constructor(
		app: App,
		private readonly textInputEl: HTMLInputElement,
		private readonly candidates: () => string[],
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		return this.candidates().filter((candidate) =>
			candidate.toLowerCase().includes(lower),
		);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	override selectSuggestion(value: string): void {
		this.setValue(value);
		// Fire the input event so the wrapping field's own listener - the
		// TextComponent onChange that persists a setting, or the rename
		// dialog's edited-value tracking - sees the picked value.
		this.textInputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}
