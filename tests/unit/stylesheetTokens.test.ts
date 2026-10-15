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
		// Inheriting is not a weight of its own: it keeps the one the state
		// around the element already took from a token.
		expect(
			declarations('font-weight').filter(
				(value) =>
					!value.startsWith('var(--font-') && value !== 'inherit',
			),
		).toEqual([]);
	});

	it('takes the recording red from the theme rather than a named colour', () => {
		expect(declarations('color')).not.toContain('red');
	});

	it('rings keyboard focus with a shadow instead of an outline', () => {
		// Obsidian draws its focus ring as a box-shadow in the theme's focus
		// colour; an outline of the plugin's own looked different from every
		// control around it and ignored a theme that restyles the ring.
		expect(declarations('outline')).toEqual([]);
	});

	it('sizes text through Obsidian tokens, never a bare em factor', () => {
		expect(
			declarations('font-size').filter((value) =>
				/^\d*\.?\d+em$/.test(value),
			),
		).toEqual([]);
	});
});
