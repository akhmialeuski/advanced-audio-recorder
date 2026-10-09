/**
 * Reads the plugin stylesheet for tests that pin a CSS contract, so a
 * fix that lives only in styles.css cannot silently regress.
 * @module tests/helpers/stylesheet
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/** The plugin stylesheet as shipped. */
export const stylesheet = readFileSync(
	join(__dirname, '../../styles/styles.css'),
	'utf8',
);

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the declaration bodies of every CSS rule a selector ends. */
export function ruleBodies(selector: string): string[] {
	const pattern = new RegExp(
		`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`,
		'g',
	);
	return [...stylesheet.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Returns the declaration body of a CSS rule, or null when absent. */
export function ruleBody(selector: string): string | null {
	return ruleBodies(selector)[0] ?? null;
}
