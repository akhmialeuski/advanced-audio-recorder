/**
 * Regression guard for the Convert to mono action of the silent-channel
 * notice. The action is a native button styled as a link, and Obsidian's
 * button:not(.clickable-icon) rule (specificity 0,1,1) outranked the bare
 * class (0,1,0), so the notice showed a grey shadowed button with
 * underlined text. jsdom resolves the cascade by source order alone, so
 * these tests pin the selectors and declarations in the stylesheet.
 * @module tests/unit/silentChannelNoticeStyles.test
 */

import { MODAL } from '../helpers/selectors';
import { ruleBody } from '../helpers/stylesheet';

// Specificity 0,2,1: one class and one :not() argument above the app's
// button:not(.clickable-icon) and button:hover, both 0,1,1.
const LINK = `button${MODAL.silentChannelConvert}:not(.clickable-icon)`;
// Specificity 0,3,1, so the ring outranks the reset of the rule above.
const LINK_FOCUS = `${LINK}:focus-visible`;

/** The declaration body of a rule, asserting it exists. */
function rule(selector: string): string {
	const body = ruleBody(selector);
	expect(body).not.toBeNull();
	return body ?? '';
}

describe('silent-channel notice action styles', () => {
	it('clears the chrome the app gives every button', () => {
		const body = rule(LINK);

		expect(body).toMatch(/background:\s*none/);
		expect(body).toMatch(/box-shadow:\s*none/);
		expect(body).toMatch(/color:\s*var\(--text-accent\)/);
	});

	// The app's bare button rule gives every button the height of a text
	// field and centres it as a flex box, which pushed the link off the
	// line of text it belongs to.
	it('sits on the line of text instead of standing as a field-high box', () => {
		const body = rule(LINK);

		expect(body).toMatch(/display:\s*inline\b/);
		expect(body).toMatch(/height:\s*auto/);
	});

	it('keeps the app focus ring over its own box-shadow reset', () => {
		expect(rule(LINK_FOCUS)).toMatch(
			/box-shadow:\s*0 0 0 3px var\(--background-modifier-border-focus\)/,
		);
	});

	// A rule left on the bare class would lose the same way and read as if
	// it still applied.
	it('leaves no rule on the bare class', () => {
		expect(ruleBody(MODAL.silentChannelConvert)).toBeNull();
		expect(
			ruleBody(`${MODAL.silentChannelConvert}:focus-visible`),
		).toBeNull();
	});
});
