/**
 * Native Obsidian popover suggestions for participant-name text inputs in
 * the speaker rename dialog, fed by the per-vault participant registry so
 * a name entered once is offered for every later recording. Mirrors
 * FolderSuggest.
 * @module ui/ParticipantSuggest
 */

import { AbstractInputSuggest } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Suggests known participant names for a text input.
 */
export class ParticipantSuggest extends AbstractInputSuggest<string> {
	/**
	 * @param app - Obsidian App instance
	 * @param textInputEl - The input element to attach suggestions to
	 * @param participants - Supplier of the current participant names (read
	 *   per query so a name applied in the same dialog still appears)
	 */
	constructor(
		app: App,
		private readonly textInputEl: HTMLInputElement,
		private readonly participants: () => string[],
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		return this.participants().filter((name) =>
			name.toLowerCase().includes(lower),
		);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	override selectSuggestion(value: string): void {
		this.setValue(value);
		// Fire the input event so the wrapping input's listeners (which
		// track the edited value) see the picked name.
		this.textInputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}
