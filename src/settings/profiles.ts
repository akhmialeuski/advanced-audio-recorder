/**
 * The plugin's named profiles, as one model.
 *
 * A glossary, a chapter-guidance prompt, a participant roster, and a
 * post-processing prompt are the same thing four times over: a named entry the
 * user keeps a list of, one of which is in use, holding a body edited as text.
 * They were four stored lists of four different shapes, each with its own
 * module of the same five functions and its own body field name, so every
 * consumer had to know which shape it was addressing and a fifth kind meant a
 * fifth copy of all of it.
 *
 * One shape now: {@link Profile} is `{ id, kind, name, body }`, every profile
 * of every kind lives in a single stored list, and the profile a kind applies
 * is one entry in a map of selections. This module owns the kind-independent
 * half - creating, adding, removing, reordering, finding, and resolving a
 * possibly-stale selection - so a kind is a description
 * ({@link module:settings/profileKinds}) rather than a storage layout of its
 * own.
 * @module settings/profiles
 */

import type { AudioRecorderSettings } from './settingsSchema';

/**
 * Every kind of profile the plugin stores, as a stored entry names itself.
 * The ids are persisted in data.json, so they are renamed only with a
 * migration.
 */
export const PROFILE_KIND_IDS = [
	'participants',
	'dictionary',
	'chapterPrompt',
	'llmCleanup',
	'llmSummary',
	'llmCustom',
] as const;

/** Which kind of thing a profile holds. */
export type ProfileKindId = (typeof PROFILE_KIND_IDS)[number];

/** One named profile, whatever kind it is. */
export interface Profile {
	/** Stable id (crypto.randomUUID, or a seeded default's fixed id). */
	id: string;
	/** What the profile holds, and so which catalogue shows it. */
	kind: ProfileKindId;
	/** Display name shown in the pickers and on the profile's page. */
	name: string;
	/**
	 * The body as the user edits it: free text for a prompt, one entry per
	 * line for a glossary or a roster. Kept as text whatever a run makes of
	 * it, so the editor, the store, and the migration all address one field.
	 */
	body: string;
}

/**
 * The profile each kind applies, by kind. An id that names no stored profile
 * reads as none, so a removed profile needs no cleanup pass over this map.
 */
export type SelectedProfileIds = Record<ProfileKindId, string>;

/** Name a freshly created profile starts out under, numbered when taken. */
export const NEW_PROFILE_NAME = 'New profile';

/** A selection map with every kind set to none. */
export function noSelectedProfiles(): SelectedProfileIds {
	return {
		participants: '',
		dictionary: '',
		chapterPrompt: '',
		llmCleanup: '',
		llmSummary: '',
		llmCustom: '',
	};
}

/**
 * Builds a profile with a fresh id. The name is trimmed so a stray-space name
 * cannot masquerade as distinct from a trimmed one.
 * @param kind - Kind the profile belongs to
 * @param name - Display name for the profile
 * @param body - Starting body; empty unless a default is being seeded
 * @returns A new profile with a unique id
 */
export function createProfile(
	kind: ProfileKindId,
	name: string,
	body = '',
): Profile {
	return { id: crypto.randomUUID(), kind, name: name.trim(), body };
}

/**
 * The profiles of one kind, in stored order. The single reader of the `kind`
 * field, so every catalogue, picker, and resolver sees the same list.
 * @param profiles - All stored profiles
 * @param kind - Kind to filter to
 * @returns That kind's profiles
 */
export function profilesOfKind(
	profiles: readonly Profile[],
	kind: ProfileKindId,
): Profile[] {
	return profiles.filter((profile) => profile.kind === kind);
}

/**
 * A name no profile in the list holds yet: the base name, or the first
 * numbered variant of it that is free. The settings tree gives every profile a
 * page of its own and the framework addresses a page by its name, so a
 * duplicate would be a page Obsidian cannot tell from another.
 * @param profiles - Profiles the name must be free among
 * @param base - Name to start from
 * @returns A name free within this list
 */
export function freeProfileName(
	profiles: readonly Profile[],
	base: string,
): string {
	const taken = new Set(profiles.map((profile) => profile.name));
	if (!taken.has(base)) {
		return base;
	}
	let suffix = 2;
	while (taken.has(`${base} ${String(suffix)}`)) {
		suffix += 1;
	}
	return `${base} ${String(suffix)}`;
}

/**
 * Appends a profile. A blank or whitespace-only name leaves the list
 * unchanged. Duplicate names are allowed on purpose: identity is the id, so
 * two same-named profiles still resolve to distinct bodies.
 * @param profiles - Current profiles
 * @param profile - The profile to append
 * @returns A new list including the profile (or an unchanged copy)
 */
export function addProfile(
	profiles: readonly Profile[],
	profile: Profile,
): Profile[] {
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
	profiles: readonly Profile[],
	id: string,
): Profile[] {
	return profiles.filter((profile) => profile.id !== id);
}

/**
 * Moves a profile to another position within its own kind. The order is the
 * order that kind's catalogue shows and its picker offers, so it is the user's
 * to arrange; a drop that names a position outside the kind's list, or the
 * position the profile already holds, leaves the order alone rather than
 * inventing one. Only the kind's own slots in the stored list are rewritten,
 * so reordering one catalogue cannot disturb another.
 * @param profiles - All stored profiles
 * @param kind - Kind whose catalogue was reordered
 * @param from - Index within that kind of the profile being moved
 * @param to - Index within that kind it is dropped on
 * @returns A new list in the new order (or an unchanged copy)
 */
export function moveProfile(
	profiles: readonly Profile[],
	kind: ProfileKindId,
	from: number,
	to: number,
): Profile[] {
	// The positions this kind occupies in the stored list. Addressing the move
	// through them is what lets a catalogue be rearranged by its own indices
	// while the entries of every other kind keep their order.
	const slots = profiles.flatMap((profile, index) =>
		profile.kind === kind ? [index] : [],
	);
	const source = slots[from];
	const target = slots[to];
	const reordered = [...profiles];
	if (from === to || source === undefined || target === undefined) {
		return reordered;
	}
	// Spread rather than indexed: the removal is one element by construction,
	// and passing it back as a list needs no check for an element that a
	// resolved slot cannot fail to hold.
	reordered.splice(target, 0, ...reordered.splice(source, 1));
	return reordered;
}

/**
 * Finds a profile by id.
 * @param profiles - Current profiles
 * @param id - Id to look up
 * @returns The matching profile, or undefined
 */
export function findProfile(
	profiles: readonly Profile[],
	id: string,
): Profile | undefined {
	return profiles.find((profile) => profile.id === id);
}

/**
 * The selection as it should be presented: the stored id when it still names a
 * real profile, otherwise ''. The single guard that makes both "None" and a
 * selection pointing at a removed profile safe, so every picker and every
 * run-time resolver treats a stale id the same way instead of each re-deriving
 * the check.
 * @param profiles - Profiles the id must name one of
 * @param id - The stored selection
 * @returns The id when it resolves, otherwise ''
 */
export function effectiveProfileId(
	profiles: readonly Profile[],
	id: string,
): string {
	return findProfile(profiles, id) ? id : '';
}

/**
 * The profile a kind applies, or undefined when none is selected or the stored
 * id points at a removed profile.
 * @param settings - The active settings
 * @param kind - Kind being resolved
 * @returns The selected profile, or undefined
 */
export function selectedProfile(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
): Profile | undefined {
	const selected = findProfile(
		settings.profiles,
		settings.selectedProfileIds[kind],
	);
	// A selection pointing at a profile of another kind is a config no editor
	// can produce; reading it as none keeps a hand-edited data.json from
	// feeding a roster to the chapter prompt.
	return selected?.kind === kind ? selected : undefined;
}

/**
 * The id a kind's pickers should show: the stored selection when it resolves,
 * otherwise '' for None.
 * @param settings - The active settings
 * @param kind - Kind being resolved
 * @returns The effective selection
 */
export function selectedProfileId(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
): string {
	return selectedProfile(settings, kind)?.id ?? '';
}

/**
 * Points a kind at a profile. Writing the map rather than a key per kind is
 * what lets a new kind arrive without a new settings field.
 * @param settings - The settings to update in place
 * @param kind - Kind whose selection changes
 * @param id - Id to select ('' for none)
 */
export function setSelectedProfileId(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
	id: string,
): void {
	settings.selectedProfileIds = {
		...settings.selectedProfileIds,
		[kind]: id,
	};
}

/**
 * Adds a profile to a kind's list and selects it, so a freshly created profile
 * opens for editing. Returns the created profile, or undefined when the name
 * was blank and nothing was added.
 * @param settings - The settings to update in place
 * @param kind - Kind the profile belongs to
 * @param name - Name for the new profile
 * @returns The created profile, or undefined
 */
export function addAndSelectProfile(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
	name: string,
): Profile | undefined {
	const created = createProfile(kind, name);
	if (created.name === '') {
		return undefined;
	}
	settings.profiles = addProfile(settings.profiles, created);
	setSelectedProfileId(settings, kind, created.id);
	return created;
}

/**
 * Removes a profile, and moves the kind's selection to the first remaining
 * profile (or to none when the kind is now empty) only when the profile
 * removed was the one in use.
 *
 * Deleting a profile a run does not apply is not a decision about which
 * profile it does apply: moving the selection then would silently change what
 * the next run transcribes, summarizes, or divides with, from a catalogue the
 * user was only tidying up. When the profile in use is the one deleted, some
 * other answer has to be found, and the first of what is left is the one the
 * editor already opens on.
 * @param settings - The settings to update in place
 * @param kind - Kind the profile belongs to
 * @param id - Id of the profile to remove
 */
export function removeAndReselectProfile(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
	id: string,
): void {
	const wasInUse = selectedProfileId(settings, kind) === id;
	settings.profiles = removeProfile(settings.profiles, id);
	if (wasInUse) {
		setSelectedProfileId(
			settings,
			kind,
			profilesOfKind(settings.profiles, kind)[0]?.id ?? '',
		);
	}
}

/**
 * Why a profile of this kind cannot be called this, or undefined when it can.
 *
 * A profile is a page of the settings tree and the framework addresses a page
 * by its name, so two profiles of one kind sharing a name are two pages
 * Obsidian cannot tell apart. The rule lives here rather than in the editor
 * that happens to ask, because a profile can be created from the settings
 * catalogue and from the speaker rename dialog alike, and a name one of them
 * refuses cannot be a name the other accepts.
 * @param profiles - All stored profiles
 * @param kind - Kind the name would belong to
 * @param id - Id of the profile being named ('' when it is being created)
 * @param name - The name as typed
 * @returns The reason to refuse, or undefined
 */
export function profileNameRejection(
	profiles: readonly Profile[],
	kind: ProfileKindId,
	id: string,
	name: string,
): string | undefined {
	const wanted = name.trim();
	if (wanted === '') {
		return 'Give the profile a name.';
	}
	return profilesOfKind(profiles, kind).some(
		(profile) => profile.id !== id && profile.name === wanted,
	)
		? 'Another profile already uses this name.'
		: undefined;
}

/**
 * The profile the settings editor should open: the persisted run selection
 * when it is a real profile, otherwise the first profile of the kind. Falling
 * back to the first one shows something to edit without silently changing a
 * stored "none" default until the user actually picks from the selector.
 * @param profiles - The kind's profiles
 * @param selectedId - The stored run selection
 * @returns The id to edit, or '' when the kind has no profiles
 */
export function editingProfileId(
	profiles: readonly Profile[],
	selectedId: string,
): string {
	return effectiveProfileId(profiles, selectedId) || (profiles[0]?.id ?? '');
}
