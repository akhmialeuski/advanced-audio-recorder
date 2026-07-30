/**
 * The participant-profile list: named rosters of people, picked for a
 * transcription run and in the speaker rename dialog. The list mechanics come
 * from the shared profile module and the name normalization from the shared
 * participant roster, so this file only describes where the list lives and how
 * a run resolves its names.
 * @module settings/speakerProfiles
 */

import {
	addsParticipants,
	mergeParticipantNames,
	normalizeParticipantNames,
} from '../speakers/participantRoster';
import type { AudioRecorderSettings, SpeakerProfile } from './settingsSchema';
import {
	addProfile,
	findProfile,
	selectedProfile,
	type ProfileList,
} from './profiles';

/**
 * Trims, deduplicates (first occurrence wins), and drops blank entries from a
 * list of participant names, preserving order.
 * @param names - Raw participant names
 * @returns A clean, order-preserving list
 */
export function normalizeParticipants(names: readonly string[]): string[] {
	return normalizeParticipantNames(names);
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
 * Where the participant profiles and their selection live in settings. The
 * selection is what a transcription run carries into the recording's sidecar,
 * and it is remembered like the dictionary and chapter picks so the next run
 * (and the next rename dialog) defaults to the same roster.
 */
export const SPEAKER_PROFILES: ProfileList<SpeakerProfile> = {
	get: (s) => s.transcriptionSpeakerProfiles,
	set: (s, profiles) => (s.transcriptionSpeakerProfiles = profiles),
	selectedId: (s) => s.transcriptionSpeakerProfileId,
	setSelectedId: (s, id) => (s.transcriptionSpeakerProfileId = id),
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
 * The participant names a transcription run carries into the recording's
 * sidecar: those of the selected profile, or an empty list when none is
 * selected or the stored id points at a removed profile. Returning an empty
 * list is the single guard that makes both "None" and a stale selection safe,
 * since the run then records no participants at all.
 * @param settings - The active settings (profiles plus the selected id)
 * @returns The selected profile's participants, or an empty list
 */
export function resolveRunParticipants(
	settings: AudioRecorderSettings,
): string[] {
	return selectedProfile(SPEAKER_PROFILES, settings)?.participants ?? [];
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
	if (!target || !addsParticipants(target.participants, names)) {
		return [...profiles];
	}
	const merged = mergeParticipantNames(target.participants, names);
	return profiles.map((profile) =>
		profile.id === id ? { ...profile, participants: merged } : profile,
	);
}
