/**
 * The dictionary-profile list: named glossaries the user manages in the
 * settings tab and picks one of per run. The list mechanics (add, remove,
 * find, resolve a stale selection) come from the shared profile module; this
 * file only describes where the list lives and how a run resolves its terms.
 * @module settings/dictionaryProfiles
 */

import type {
	AudioRecorderSettings,
	DictionaryProfile,
} from './settingsSchema';
import { selectedProfile, type ProfileList } from './profiles';
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

/** Where the dictionary profiles and their selection live in settings. */
export const DICTIONARY_PROFILES: ProfileList<DictionaryProfile> = {
	get: (s) => s.transcriptionDictionaryProfiles,
	set: (s, profiles) => (s.transcriptionDictionaryProfiles = profiles),
	selectedId: (s) => s.transcriptionDictionaryProfileId,
	setSelectedId: (s, id) => (s.transcriptionDictionaryProfileId = id),
	create: createDictionaryProfile,
};

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
	settings: AudioRecorderSettings,
): string {
	return selectedProfile(DICTIONARY_PROFILES, settings)?.terms ?? '';
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
	settings: AudioRecorderSettings,
): string[] {
	if (!settings.transcriptionAdvancedSettingsEnabled) {
		return [];
	}
	return parseDictionary(resolveDictionaryTerms(settings));
}
