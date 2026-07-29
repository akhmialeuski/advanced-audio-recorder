/**
 * Generic machinery for the plugin's named profile lists: dictionary
 * glossaries, chapter guidance prompts, and participant rosters. All three are
 * the same shape - a list of `{ id, name, ... }` stored in settings, one of
 * which is selected by id - and used to be three near-identical modules with
 * three different naming conventions and one missing an `add` helper.
 *
 * This module owns the shape-independent half: creating, adding, removing,
 * finding, and resolving a possibly-stale selection. A {@link ProfileList}
 * descriptor binds it to a concrete list, so each profile kind is a small
 * description of where it lives and what its body field is called rather than
 * its own copy of the same five functions.
 * @module settings/profiles
 */

import type { AudioRecorderSettings } from './settingsSchema';

/** The fields every profile kind shares. */
export interface Profile {
	/** Stable id (crypto.randomUUID); selection persists by id, not by name. */
	id: string;
	/** Display name shown in the pickers. */
	name: string;
}

/**
 * Where one kind of profile lives in settings and how a fresh one is built.
 * The single description each consumer reads, so a picker, an editor, and a
 * run-time resolver can never disagree about which field they address.
 */
export interface ProfileList<T extends Profile> {
	/** Reads the stored profiles. */
	get(settings: AudioRecorderSettings): T[];
	/** Writes the profiles back. */
	set(settings: AudioRecorderSettings, profiles: T[]): void;
	/** Reads the selected profile id ('' when none is selected). */
	selectedId(settings: AudioRecorderSettings): string;
	/** Writes the selected profile id. */
	setSelectedId(settings: AudioRecorderSettings, id: string): void;
	/** Builds a profile with a fresh id and an empty body. */
	create(name: string): T;
}

/**
 * Appends a profile. A blank or whitespace-only name leaves the list
 * unchanged. Duplicate names are allowed on purpose: identity is the id, so
 * two same-named profiles still resolve to distinct bodies.
 * @param profiles - Current profiles
 * @param profile - The profile to append
 * @returns A new list including the profile (or an unchanged copy)
 */
export function addProfile<T extends Profile>(
	profiles: readonly T[],
	profile: T,
): T[] {
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
export function removeProfile<T extends Profile>(
	profiles: readonly T[],
	id: string,
): T[] {
	return profiles.filter((profile) => profile.id !== id);
}

/**
 * Finds a profile by id.
 * @param profiles - Current profiles
 * @param id - Id to look up
 * @returns The matching profile, or undefined
 */
export function findProfile<T extends Profile>(
	profiles: readonly T[],
	id: string,
): T | undefined {
	return profiles.find((profile) => profile.id === id);
}

/**
 * The selection as it should be presented: the stored id when it still names a
 * real profile, otherwise ''. The single guard that makes both "None" and a
 * selection pointing at a removed profile safe, so every picker and every
 * run-time resolver treats a stale id the same way instead of each re-deriving
 * the check.
 * @param profiles - Current profiles
 * @param id - The stored selection
 * @returns The id when it resolves, otherwise ''
 */
export function effectiveProfileId<T extends Profile>(
	profiles: readonly T[],
	id: string,
): string {
	return findProfile(profiles, id) ? id : '';
}

/**
 * The profile a run should use: the selected one, or undefined when nothing is
 * selected or the stored id points at a removed profile.
 * @param list - The profile list descriptor
 * @param settings - The active settings
 * @returns The selected profile, or undefined
 */
export function selectedProfile<T extends Profile>(
	list: ProfileList<T>,
	settings: AudioRecorderSettings,
): T | undefined {
	return findProfile(list.get(settings), list.selectedId(settings));
}

/**
 * Adds a profile to the list and selects it, so a freshly created profile
 * opens for editing. Returns the created profile, or undefined when the name
 * was blank and nothing was added.
 * @param list - The profile list descriptor
 * @param settings - The settings to update in place
 * @param name - Name for the new profile
 * @returns The created profile, or undefined
 */
export function addAndSelectProfile<T extends Profile>(
	list: ProfileList<T>,
	settings: AudioRecorderSettings,
	name: string,
): T | undefined {
	const created = list.create(name);
	if (created.name === '') {
		return undefined;
	}
	list.set(settings, addProfile(list.get(settings), created));
	list.setSelectedId(settings, created.id);
	return created;
}

/**
 * Removes a profile and moves the selection to the first remaining one (or to
 * "none" when the list is now empty), so the editor never points at a profile
 * that is gone.
 * @param list - The profile list descriptor
 * @param settings - The settings to update in place
 * @param id - Id of the profile to remove
 */
export function removeAndReselectProfile<T extends Profile>(
	list: ProfileList<T>,
	settings: AudioRecorderSettings,
	id: string,
): void {
	const next = removeProfile(list.get(settings), id);
	list.set(settings, next);
	list.setSelectedId(settings, next[0]?.id ?? '');
}

/**
 * The profile the settings editor should open: the persisted run selection
 * when it is a real profile, otherwise the first profile. Falling back to the
 * first one shows something to edit without silently changing a stored "none"
 * default until the user actually picks from the selector.
 * @param profiles - Current profiles
 * @param selectedId - The stored run selection
 * @returns The id to edit, or '' when the list is empty
 */
export function editingProfileId<T extends Profile>(
	profiles: readonly T[],
	selectedId: string,
): string {
	return effectiveProfileId(profiles, selectedId) || (profiles[0]?.id ?? '');
}
