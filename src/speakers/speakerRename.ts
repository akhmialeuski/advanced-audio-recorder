/**
 * Pure model for a manual speaker rename: the display-level replacement pair
 * the rewriters apply, the dialog's per-speaker entry, and the validation
 * that no two speakers resolve to the same name (merging is unsupported).
 * Everything here is side-effect free so it can be unit tested directly.
 * @module speakers/speakerRename
 */

/** One display-level rename: the text currently shown and its replacement. */
export interface SpeakerRename {
	/** Display text currently rendered in the existing outputs. */
	from: string;
	/** Display text that should replace it. */
	to: string;
}

/** One dialog row: the speaker label currently shown and the entered name. */
export interface SpeakerNameEntry {
	/** Speaker text as it currently appears in the transcript. */
	label: string;
	/** Name the user entered (empty keeps the original label). */
	name: string;
}

/**
 * The effective display name an entry resolves to once applied: the trimmed
 * typed name, or the original label when the field is left blank (blank keeps
 * the label rather than clearing it).
 */
function effectiveName(entry: SpeakerNameEntry): string {
	return entry.name.trim() || entry.label;
}

/**
 * Returns the display names that two or more distinct labels would resolve to,
 * which would merge those speakers in every output. Merging is out of scope
 * for now, so the dialog blocks it; an empty result means the entries are
 * safe to apply. A blank field counts as its original label, so assigning one
 * speaker's label as another speaker's name (while leaving the first blank) is
 * still detected as a merge.
 * @param entries - One entry per detected speaker
 * @returns The offending names, in first-seen order (empty when none)
 */
export function duplicateAssignedNames(
	entries: readonly SpeakerNameEntry[],
): string[] {
	const labelsByName = new Map<string, Set<string>>();
	for (const entry of entries) {
		const name = effectiveName(entry);
		const labels = labelsByName.get(name) ?? new Set<string>();
		labels.add(entry.label);
		labelsByName.set(name, labels);
	}
	const duplicates: string[] = [];
	for (const [name, labels] of labelsByName) {
		if (labels.size > 1) {
			duplicates.push(name);
		}
	}
	return duplicates;
}
