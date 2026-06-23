/**
 * Pure helpers for the user-editable transcription model lists. Each engine
 * keeps a list of known model ids in settings, seeded with the built-in
 * suggestions; the user can add custom ids and pick one from the list. These
 * functions are side-effect free (they return new arrays) so the settings UI
 * never mutates the shared default arrays in place.
 * @module settings/modelList
 */

/** Trims surrounding whitespace from a model id. */
export function normalizeModelId(raw: string): string {
	return raw.trim();
}

/**
 * Appends a model id to the list, de-duplicated. Whitespace is trimmed; an
 * empty id, or one already in the list, leaves the list unchanged.
 * @param list - Current model ids
 * @param model - Model id to add
 * @returns A new list including the model (or an unchanged copy)
 */
export function addModelToList(list: string[], model: string): string[] {
	const id = normalizeModelId(model);
	if (id === '' || list.includes(id)) {
		return [...list];
	}
	return [...list, id];
}

/**
 * Removes a model id from the list. Returns a copy without the id (or an
 * unchanged copy when it is absent).
 * @param list - Current model ids
 * @param model - Model id to remove
 * @returns A new list without the model
 */
export function removeModelFromList(list: string[], model: string): string[] {
	return list.filter((entry) => entry !== model);
}

/**
 * Ensures the selected id appears in the list so the picker can always show
 * the current value. A non-empty selection missing from the list is prepended
 * (e.g. a custom id imported from synced settings, or a default that was
 * removed); an empty selection or one already present leaves the list as-is.
 * @param list - Current model ids
 * @param selected - The currently selected model id
 * @returns A list guaranteed to contain the selection
 */
export function ensureSelectedInList(
	list: string[],
	selected: string,
): string[] {
	const id = normalizeModelId(selected);
	if (id === '' || list.includes(id)) {
		return [...list];
	}
	return [id, ...list];
}
