/**
 * Regression guard for the read-only (reading view) player CSS contract.
 * The marker label is a button, which reading-view styling would centre;
 * the fix scopes the rule under `.aar-player` and left-aligns it. These
 * tests parse the stylesheet so that fix cannot silently regress.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(join(__dirname, '../../styles/styles.css'), 'utf8');

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the declaration body of a CSS rule, or null when absent. */
function ruleBody(selector: string): string | null {
	const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`).exec(
		css,
	);
	return match ? match[1] : null;
}

describe('read-only player styles', () => {
	it('left-aligns the static marker label, scoped to outrank reading-view buttons', () => {
		const body = ruleBody('.aar-player .aar-player-marker-label-static');
		expect(body).not.toBeNull();
		expect(body).toMatch(/text-align:\s*left/);
		expect(body).toMatch(/justify-content:\s*flex-start/);
	});

	it('hides editing-only controls in read-only mode', () => {
		const body = ruleBody('.aar-player-readonly .aar-player-edit-only');
		expect(body).not.toBeNull();
		expect(body).toMatch(/display:\s*none/);
	});
});
