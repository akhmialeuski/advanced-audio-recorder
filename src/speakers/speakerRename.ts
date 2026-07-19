/**
 * Pure model for a manual speaker rename. The rename dialog collects one
 * entry per detected speaker (the label currently shown in the transcript and
 * the name the user typed) and turns them into the display-level replacements
 * the rewriters apply. Everything here is side-effect free so the diffing and
 * validation can be unit tested directly.
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
 * Turns dialog entries into the renames to apply: the trimmed name becomes the
 * replacement for its label, and an entry is dropped when the name is empty or
 * equal to the label, so an untouched or cleared field is a no-op.
 * @param entries - One entry per detected speaker
 * @returns The display-level renames to apply
 */
export function buildSpeakerRenames(
	entries: readonly SpeakerNameEntry[],
): SpeakerRename[] {
	const renames: SpeakerRename[] = [];
	for (const entry of entries) {
		const to = entry.name.trim();
		if (to && to !== entry.label) {
			renames.push({ from: entry.label, to });
		}
	}
	return renames;
}

/**
 * Returns the display names that two or more distinct labels were assigned,
 * which would merge those speakers in every output. Merging is out of scope
 * for now, so the dialog blocks it; an empty result means the entries are
 * safe to apply.
 * @param entries - One entry per detected speaker
 * @returns The offending names, in first-seen order (empty when none)
 */
export function duplicateAssignedNames(
	entries: readonly SpeakerNameEntry[],
): string[] {
	const labelsByName = new Map<string, Set<string>>();
	for (const entry of entries) {
		const name = entry.name.trim();
		if (!name) {
			continue;
		}
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
