/**
 * The participant-profile list: named rosters of people, created and filled
 * from the speaker rename dialog rather than the settings tab. The list
 * mechanics come from the shared profile module; this file adds only what is
 * specific to a roster - normalizing names and merging applied ones back in.
 *
 * A roster has no persisted "selected id": the dialog holds the pick for the
 * duration of one rename, so the descriptor's selection accessors are backed by
 * a module-local slot rather than a settings field.
 * @module settings/speakerProfiles
 */

import type { AudioRecorderSettings, SpeakerProfile } from './settingsSchema';
import { addProfile, findProfile, type ProfileList } from './profiles';

/**
 * Trims, deduplicates (first occurrence wins), and drops blank entries from a
 * list of participant names, preserving order.
 * @param names - Raw participant names
 * @returns A clean, order-preserving list
 */
export function normalizeParticipants(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		const trimmed = name.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

/**
 * Builds a profile with a fresh id, a trimmed name, and no participants. The
 * name is trimmed so a stray-space name cannot masquerade as distinct.
 * @param name - Display name for the profile
 * @returns A new profile with a unique id
 */
export function createSpeakerProfile(name: string): SpeakerProfile {
	return { id: crypto.randomUUID(), name: name.trim(), participants: [] };
}

/**
 * Where the participant profiles live in settings. Unlike the dictionary and
 * chapter lists there is no persisted selection - the rename dialog owns the
 * pick for one run - so the selection accessors are inert.
 */
export const SPEAKER_PROFILES: ProfileList<SpeakerProfile> = {
	get: (s) => s.transcriptionSpeakerProfiles,
	set: (s, profiles) => (s.transcriptionSpeakerProfiles = profiles),
	selectedId: () => '',
	setSelectedId: () => {
		/* the rename dialog holds the selection for one run */
	},
	create: createSpeakerProfile,
};

/**
 * Appends a new empty profile with the given name. A blank name leaves the list
 * unchanged. Duplicate names are allowed on purpose: identity is the id.
 * @param profiles - Current profiles
 * @param name - Name for the new profile
 * @returns A new list including the profile (or an unchanged copy)
 */
export function addSpeakerProfile(
	profiles: readonly SpeakerProfile[],
	name: string,
): SpeakerProfile[] {
	return addProfile(profiles, createSpeakerProfile(name));
}

/**
 * The participants a profile offers as suggestions, or an empty list when the
 * id names no profile.
 * @param settings - The active settings
 * @param id - Id of the profile feeding the suggestions ('' means none)
 * @returns The profile's participant names
 */
export function participantsOf(
	settings: AudioRecorderSettings,
	id: string,
): string[] {
	return findProfile(SPEAKER_PROFILES.get(settings), id)?.participants ?? [];
}

/**
 * Adds names to a profile's participant roster, skipping ones already present,
 * so names applied in the rename dialog become suggestions next time. Returns
 * the profiles unchanged (a copy) when the id is absent or nothing new was
 * added, so callers can compare references to decide whether to persist.
 * @param profiles - Current profiles
 * @param id - Id of the profile to extend
 * @param names - Names to add
 * @returns A new list with the profile's participants extended
 */
export function addParticipantsToProfile(
	profiles: readonly SpeakerProfile[],
	id: string,
	names: readonly string[],
): SpeakerProfile[] {
	const target = findProfile(profiles, id);
	if (!target) {
		return [...profiles];
	}
	const merged = normalizeParticipants([...target.participants, ...names]);
	if (merged.length === target.participants.length) {
		return [...profiles];
	}
	return profiles.map((profile) =>
		profile.id === id ? { ...profile, participants: merged } : profile,
	);
}
