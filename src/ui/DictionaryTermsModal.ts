/**
 * The dialog picking which terms a note template collected go into the
 * dictionary profile the run used, and the notice button that opens it.
 *
 * Terms are picked one by one rather than taken as a list: a model collects
 * common words and names along with the terms worth biasing the engine
 * toward, and a dictionary filled with those biases it toward noise.
 * @module ui/DictionaryTermsModal
 */

import { Notice, Setting } from 'obsidian';
import type { App, ButtonComponent } from 'obsidian';
import {
	addTermsToDictionary,
	type DictionaryStore,
} from '../settings/dictionaryGrowth';
import type { TermsAction, TermsOffer } from '../transcription/termsOffer';
import { PluginModal } from './PluginModal';

/** Picks terms of an offer and adds them to its dictionary profile. */
export class DictionaryTermsModal extends PluginModal {
	/** The terms picked so far. */
	private readonly picked = new Set<string>();
	private addButton: ButtonComponent | null = null;

	/**
	 * @param app - Obsidian App
	 * @param offer - The terms and the profile they go to
	 * @param add - Adds the picked terms, answering what to tell the user
	 */
	constructor(
		app: App,
		private readonly offer: TermsOffer,
		private readonly add: (terms: readonly string[]) => Promise<string>,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Add terms to the dictionary');
		this.contentEl.createEl('p', {
			text: `Pick the terms the next recording should be recognized with. They go into dictionary profile "${this.offer.profile.name}".`,
		});
		for (const term of this.offer.terms) {
			new Setting(this.contentEl).setName(term).addToggle((toggle) => {
				toggle.setValue(false).onChange((on) => {
					if (on) {
						this.picked.add(term);
					} else {
						this.picked.delete(term);
					}
					this.addButton?.setDisabled(this.picked.size === 0);
				});
			});
		}
		this.renderActions(
			{
				text: 'Add',
				cta: true,
				disabled: true,
				onClick: () => this.addPicked(),
				ref: (button) => {
					this.addButton = button;
				},
			},
			{ text: 'Cancel', onClick: () => this.close() },
		);
	}

	/** Adds the picked terms, in the order offered, and closes the dialog. */
	private async addPicked(): Promise<void> {
		await this.runExclusive(async () => {
			const terms = this.offer.terms.filter((term) =>
				this.picked.has(term),
			);
			new Notice(await this.add(terms));
			this.close();
		});
	}
}

/**
 * The notice button offering a run's new terms to its dictionary profile.
 * @param store - The plugin's settings and vault
 * @returns What builds the button for an offer
 */
export function dictionaryTermsAction(store: DictionaryStore): TermsAction {
	return (offer) => ({
		label: `Add new terms to the dictionary (${offer.terms.length})`,
		run: () => {
			new DictionaryTermsModal(store.app, offer, (terms) =>
				addTermsToDictionary(store, offer.profile.id, terms),
			).open();
		},
	});
}
