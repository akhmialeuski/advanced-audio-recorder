/**
 * Parses the free-text transcription dictionary setting into discrete terms.
 * The dictionary is one term per line so a term may contain spaces (a full
 * name, a multi-word product); whitespace splitting would break those, which
 * is why this is a dedicated helper rather than the whitespace-based
 * {@link parseArgs} used for CLI flags.
 * @module transcription/dictionary
 */

import { listEntries } from '../utils/listLines';

/**
 * Splits the raw dictionary text into trimmed, de-duplicated terms. The text is
 * read as a list, so a glossary kept in a note as `- Kubernetes` under a
 * heading yields the term `Kubernetes` and no term for the heading.
 * @param raw - The multi-line dictionary body
 * @returns Terms in first-seen order, without blanks or case-insensitive
 * duplicates
 */
export function parseDictionary(raw: string): string[] {
	return dedupeTerms(listEntries(raw));
}

/**
 * Trims terms and drops blanks and case-insensitive duplicates, keeping the
 * first spelling seen. Shared by the dictionary parser and every place two
 * term lists are combined (e.g. generated keyterms ahead of the dictionary),
 * so "kubernetes" and "Kubernetes" never both reach a provider.
 * @param terms - Raw terms, possibly overlapping
 * @returns Terms in first-seen order, without blanks or duplicates
 */
export function dedupeTerms(terms: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of terms) {
		const term = raw.trim();
		if (!term) {
			continue;
		}
		const key = term.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(term);
	}
	return result;
}
