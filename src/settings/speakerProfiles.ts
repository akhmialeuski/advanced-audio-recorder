/**
 * Pure helpers for the participant-name profiles used by the speaker rename
 * dialog. Each profile is a named roster of people; the user creates profiles
 * and adds names from the dialog, then picks one to feed its names as
 * suggestions. These functions are side-effect free (they return new arrays)
 * so the dialog never mutates the stored settings array in place, mirroring
 * {@link module:settings/dictionaryProfiles}.
 * @module settings/speakerProfiles
 */

import type { SpeakerProfile } from './settingsSchema';

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
	const profile = createSpeakerProfile(name);
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
export function removeSpeakerProfile(
	profiles: readonly SpeakerProfile[],
	id: string,
): SpeakerProfile[] {
	return profiles.filter((profile) => profile.id !== id);
}

/**
 * Finds a profile by id.
 * @param profiles - Current profiles
 * @param id - Id to look up
 * @returns The matching profile, or undefined
 */
export function findSpeakerProfile(
	profiles: readonly SpeakerProfile[],
	id: string,
): SpeakerProfile | undefined {
	return profiles.find((profile) => profile.id === id);
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
	const target = findSpeakerProfile(profiles, id);
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
