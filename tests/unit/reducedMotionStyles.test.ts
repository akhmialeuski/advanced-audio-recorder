/**
 * With reduced motion asked for, the recording indicators stop pulsing and
 * the bars stop sliding, while every state stays readable without the
 * movement. Read from the stylesheet, since the whole behaviour is CSS.
 * @module tests/unit/reducedMotionStyles.test
 */

import { BANNER } from '../helpers/selectors';
import { atRuleBody, ruleBody, stylesheet } from '../helpers/stylesheet';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** The reduced-motion block, asserting the sheet has one. */
function reducedMotion(): string {
	const body = atRuleBody(REDUCED_MOTION);
	expect(body).not.toBeNull();
	return body ?? '';
}

/**
 * The selectors of every rule outside the reduced-motion block whose
 * declarations match a pattern, one entry per comma-separated selector.
 */
function selectorsDeclaring(pattern: RegExp): string[] {
	const outside = stylesheet
		.replace(reducedMotion(), '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
	return [...outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((match) => pattern.test(match[2] ?? ''))
		.flatMap((match) => (match[1] ?? '').split(','))
		.map((selector) => selector.trim());
}

/** The selectors a block lists in front of a declaration. */
function selectorsSetting(block: string, declaration: RegExp): string[] {
	return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter((match) => declaration.test(match[2] ?? ''))
		.flatMap((match) => (match[1] ?? '').split(','))
		.map((selector) => selector.trim());
}

describe('reduced motion styles', () => {
	it('stops every animation that repeats forever', () => {
		const stopped = selectorsSetting(reducedMotion(), /animation:\s*none/);

		const pulsing = selectorsDeclaring(/animation:[^;]*infinite/);

		expect(pulsing.length).toBeGreaterThan(0);
		expect(stopped).toEqual(expect.arrayContaining(pulsing));
	});

	it('stops every transition the plugin declares', () => {
		const stopped = selectorsSetting(reducedMotion(), /transition:\s*none/);

		const moving = selectorsDeclaring(/transition:(?!\s*none)/);

		expect(moving.length).toBeGreaterThan(0);
		expect(stopped).toEqual(expect.arrayContaining(moving));
	});

	it('keeps the recording dot red while it stands still', () => {
		// Without the pulse the colour is the whole signal, so the block may
		// only take the movement away.
		expect(reducedMotion()).not.toMatch(/background-color|color:/);
		expect(ruleBody(BANNER.dot)).toMatch(
			/background-color:\s*var\(--color-red\)/,
		);
	});
});
