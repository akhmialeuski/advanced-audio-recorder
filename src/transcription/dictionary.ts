/**
 * Parses the free-text transcription dictionary setting into discrete terms.
 * The dictionary is one term per line so a term may contain spaces (a full
 * name, a multi-word product); whitespace splitting would break those, which
 * is why this is a dedicated helper rather than the whitespace-based
 * {@link parseArgs} used for CLI flags.
 * @module transcription/dictionary
 */

/**
 * Splits the raw dictionary text into trimmed, de-duplicated terms.
 * @param raw - The multi-line dictionary setting value
 * @returns Terms in first-seen order, without blanks or case-insensitive
 * duplicates
 */
export function parseDictionary(raw: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const term = line.trim();
		if (!term) {
			continue;
		}
		const key = term.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		terms.push(term);
	}
	return terms;
}
