/**
 * Adds terms to a dictionary profile: to the note it is read from when it is
 * kept in one, else to the text typed for it.
 *
 * A dictionary kept in a note grows in the note, as a roster kept in a note
 * does: the profile's body is only the text last read from there, so a term
 * added to the body alone would be gone with the next read.
 * @module settings/dictionaryGrowth
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import { appendTermsToNote } from './ProfileNoteStore';
import { ProfileTextSource } from './ProfileTextSource';
import { addTermsToProfile, newDictionaryTerms } from './profileResolution';
import { findProfile, ProfileKindId } from './profiles';
import type { AudioRecorderSettings } from './settingsSchema';

/**
 * Where a dictionary profile is kept, and how a change to it is saved: the
 * plugin itself, whose settings are the live ones and not a run's copy.
 */
export interface DictionaryStore {
	readonly app: App;
	readonly settings: AudioRecorderSettings;
	saveSettings(): Promise<void>;
}

/**
 * The sentence counting the terms added.
 * @param count - How many were added
 * @param name - The profile's name
 */
function addedText(count: number, name: string): string {
	return count === 0
		? `Dictionary profile "${name}" already holds every term picked.`
		: `Added ${count} ${count === 1 ? 'term' : 'terms'} to dictionary profile "${name}".`;
}

/**
 * Adds the terms to the dictionary profile, skipping the ones it holds.
 * @param store - The settings and the vault
 * @param profileId - Id of the dictionary profile
 * @param terms - Terms to add
 * @returns What to tell the user
 */
export async function addTermsToDictionary(
	store: DictionaryStore,
	profileId: string,
	terms: readonly string[],
): Promise<string> {
	const { settings } = store;
	const target = findProfile(settings.profiles, profileId);
	if (target?.kind !== ProfileKindId.Dictionary) {
		return 'That dictionary profile no longer exists, so no term was added.';
	}
	try {
		if (target.sourcePath !== undefined) {
			const profileText = new ProfileTextSource(store.app.vault);
			const note = profileText.note(target);
			if (!note) {
				return `${profileText.missingNote(target.name, target.sourcePath)}, so no term was added.`;
			}
			const added = await appendTermsToNote(store.app.vault, note, terms);
			return addedText(added, target.name);
		}
		const grown = addTermsToProfile(settings.profiles, profileId, terms);
		if (grown) {
			settings.profiles = grown;
			await store.saveSettings();
		}
		return addedText(
			newDictionaryTerms(target.body, terms).length,
			target.name,
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to add terms to profile ${target.name}:`,
			error,
		);
		return `The terms were not added to dictionary profile "${target.name}": ${errorMessage(error)}`;
	}
}
