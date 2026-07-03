/**
 * Shared timestamp and random-token helpers for session and file naming.
 * The project's preferred idiom for identifiers is crypto.randomUUID()
 * (see markers/markerFactory.ts); use randomToken() only where a shorter
 * token is specifically required, such as multipart boundaries or
 * temp-file names.
 * @module utils/ids
 */

/**
 * A filename-safe ISO timestamp (colons and dots replaced with hyphens),
 * used to name recording sessions and their files.
 * @param date - The moment to stamp (defaults to now)
 * @returns Timestamp like 2026-07-03T12-34-56-789Z
 */
export function sessionTimestamp(date: Date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * A short random hex token. Not cryptographically strong - prefer
 * crypto.randomUUID() for identifiers; this is for cases where a shorter
 * disposable token is enough.
 * @returns Hex string of ~13 characters
 */
export function randomToken(): string {
	return Math.random().toString(16).slice(2);
}
