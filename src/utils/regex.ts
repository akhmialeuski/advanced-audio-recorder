/**
 * Regular-expression helpers shared across modules that build patterns from
 * user- or vault-derived text.
 * @module utils/regex
 */

/** Escapes a literal string for embedding in a RegExp. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
