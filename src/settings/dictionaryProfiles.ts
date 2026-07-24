/**
 * Pure helpers for the user-editable transcription dictionary profiles. Each
 * profile is a named glossary; the user adds, edits, and removes profiles in
 * the settings tab and picks one per run. These functions are side-effect free
 * (they return new arrays) so the settings UI never mutates the stored array in
 * place, and the run resolver tolerates a selection that no longer exists.
 * @module settings/dictionaryProfiles
 */

import type {
	AudioRecorderSettings,
	DictionaryProfile,
} from './settingsSchema';
import { parseDictionary } from '../transcription/dictionary';

/**
 * Builds a profile with a fresh id and empty terms. The name is trimmed so a
 * stray-space name cannot masquerade as distinct from a trimmed one.
 * @param name - Display name for the profile
 * @returns A new profile with a unique id
 */
export function createDictionaryProfile(name: string): DictionaryProfile {
	return { id: crypto.randomUUID(), name: name.trim(), terms: '' };
}

/**
 * Appends a new profile with the given name. A blank or whitespace-only name
 * leaves the list unchanged. Duplicate names are allowed on purpose: identity
 * is the id, so two same-named profiles still resolve to distinct terms.
 * @param profiles - Current profiles
 * @param name - Name for the new profile
 * @returns A new list including the profile (or an unchanged copy)
 */
export function addProfile(
	profiles: DictionaryProfile[],
	name: string,
): DictionaryProfile[] {
	const profile = createDictionaryProfile(name);
	if (profile.name === '') {
		return [...profiles];
	}
	return [...profiles, profile];
}

/**
 * Removes the profile with the given id. Returns a copy without it (or an
 * unchanged copy when the id is absent).
 * @param profiles - Current profiles
 * @param id - Id of the profile to remove
 * @returns A new list without the profile
 */
export function removeProfile(
	profiles: DictionaryProfile[],
	id: string,
): DictionaryProfile[] {
	return profiles.filter((profile) => profile.id !== id);
}

/**
 * Finds a profile by id.
 * @param profiles - Current profiles
 * @param id - Id to look up
 * @returns The matching profile, or undefined
 */
export function findProfile(
	profiles: DictionaryProfile[],
	id: string,
): DictionaryProfile | undefined {
	return profiles.find((profile) => profile.id === id);
}

/**
 * Resolves the raw dictionary text to bias with for a run: the selected
 * profile's terms, or an empty string when nothing is selected or the stored id
 * points to a removed profile. Returning '' is the single guard that makes both
 * "None" and a stale selection safe, since the downstream pipeline
 * ({@link parseDictionary} then planDictionaryBias) treats '' as no terms.
 * @param settings - The active settings (profiles plus the selected id)
 * @returns The selected profile's terms, or '' when none applies
 */
export function resolveDictionaryTerms(
	settings: Pick<
		AudioRecorderSettings,
		'transcriptionDictionaryProfiles' | 'transcriptionDictionaryProfileId'
	>,
): string {
	return (
		findProfile(
			settings.transcriptionDictionaryProfiles,
			settings.transcriptionDictionaryProfileId,
		)?.terms ?? ''
	);
}

/**
 * Resolves the run's effective dictionary terms as a clean, de-duplicated list.
 * The single source of the terms a run biases toward: the single-pass
 * dictionary plan, the advanced two-pass context candidates, and the LLM
 * cleanup hint all read from here, so the same profile drives every term-aware
 * stage and there is no second, parallel glossary to keep in sync. The
 * dictionary lives under the advanced settings, so this returns an empty list
 * whenever that master switch is off - a plain run applies no term biasing.
 * @param settings - The active settings (the advanced switch, profiles, and id)
 * @returns The selected profile's terms, de-duplicated; empty when the advanced
 *   settings are off, none is selected, or the selected profile is gone
 */
export function resolveDictionaryTermList(
	settings: Pick<
		AudioRecorderSettings,
		| 'transcriptionAdvancedSettingsEnabled'
		| 'transcriptionDictionaryProfiles'
		| 'transcriptionDictionaryProfileId'
	>,
): string[] {
	if (!settings.transcriptionAdvancedSettingsEnabled) {
		return [];
	}
	return parseDictionary(resolveDictionaryTerms(settings));
}
