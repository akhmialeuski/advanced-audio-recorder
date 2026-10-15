/**
 * The stylesheet takes its colours, weights and focus rings from Obsidian's
 * own tokens, so a theme that redefines one reaches the plugin as well. These
 * tests read the whole sheet, because a hardcoded value can come back in any
 * rule, not only the ones that were converted.
 * @module tests/unit/stylesheetTokens.test
 */

import { stylesheet } from '../helpers/stylesheet';

/** Every declaration of one property in the sheet, as written. */
function declarations(property: string): string[] {
	const pattern = new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]*);`, 'gm');
	return [...stylesheet.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('stylesheet tokens', () => {
	it('names every font weight through a theme token', () => {
		expect(
			declarations('font-weight').filter(
				(value) => !value.startsWith('var(--font-'),
			),
		).toEqual([]);
	});

	it('takes the recording red from the theme rather than a named colour', () => {
		expect(declarations('color')).not.toContain('red');
	});

	it('sizes text through Obsidian tokens, never a bare em factor', () => {
		expect(
			declarations('font-size').filter((value) =>
				/^\d*\.?\d+em$/.test(value),
			),
		).toEqual([]);
	});
});
