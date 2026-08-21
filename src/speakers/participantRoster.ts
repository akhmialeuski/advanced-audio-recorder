/**
 * The participant-name list, normalized in one place. Three features hold one:
 * a participant profile in settings, the roster a recording carries in its
 * sidecar, and the names a rename dialog applies - and all three want the same
 * thing from a list of names (trim, drop blanks, keep the first of a duplicate,
 * preserve order). Keeping that rule here means a name typed in the dialog, a
 * name read back from a hand-edited sidecar, and a name stored in a profile can
 * never normalize differently and so can never fail to match each other.
 *
 * Pure and I/O-free: the sidecar model, the profile module, and the dialog all
 * read from here, and this module reads from none of them.
 * @module speakers/participantRoster
 */

/**
 * Trims, drops blanks, and de-duplicates (first occurrence wins) a list of
 * participant names, preserving order. Non-string entries are dropped, so a
 * hand-edited sidecar or data.json holding a number where a name belongs
 * degrades to a shorter list instead of poisoning the roster.
 * @param values - Raw names, possibly untyped data from disk
 * @returns A clean, order-preserving list of names
 */
export function normalizeParticipantNames(
	values: readonly unknown[],
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') {
			continue;
		}
		const trimmed = value.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

/**
 * Merges names into an existing roster: the current names keep their order and
 * anything new is appended, normalized as one list. Used wherever a roster
 * grows - a transcription carrying a profile's names into the recording, a
 * rename adding the names it applied - so growing a roster never reorders the
 * names already in it.
 * @param current - The roster to grow
 * @param added - Names to merge in
 * @returns The merged roster
 */
export function mergeParticipantNames(
	current: readonly unknown[],
	added: readonly unknown[],
): string[] {
	return normalizeParticipantNames([...current, ...added]);
}

/**
 * Reads a roster written as text, one name per line, into names a run can use.
 * A participant profile stores its roster the way every profile stores its
 * body - as the text the user edits - so this is the single place that turns
 * that text into names, and the normalization it applies is the same one a
 * sidecar and a rename dialog get.
 * @param body - The roster as edited, one name per line
 * @returns A clean, order-preserving list of names
 */
export function parseParticipantBody(body: string): string[] {
	return normalizeParticipantNames(body.split(/\r?\n/));
}

/**
 * Writes names back as the text a profile body holds. The inverse of
 * {@link parseParticipantBody}, so a roster grown by the rename dialog is
 * stored in the form the editor shows.
 * @param names - The roster to write
 * @returns One name per line
 */
export function formatParticipantBody(names: readonly string[]): string {
	return names.join('\n');
}
