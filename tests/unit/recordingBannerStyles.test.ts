/**
 * Regression guard for where the mobile recording banner sits (issue
 * #118). Pinned under the status bar, it covered Obsidian's floating view
 * header and its stop control was a 16px icon a phone could not reliably
 * hit. The fix is CSS only, so these tests parse the stylesheet.
 * @module tests/unit/recordingBannerStyles.test
 */

import { BANNER } from '../helpers/selectors';
import { ruleBody } from '../helpers/stylesheet';

/** The declaration body of a banner rule, asserting it exists. */
function bannerRule(selector: string): string {
	const body = ruleBody(selector);
	expect(body).not.toBeNull();
	return body ?? '';
}

describe('mobile recording banner styles', () => {
	it('sits below the view header Obsidian floats at the top of a phone', () => {
		const top = /--aar-banner-top:\s*calc\(([^;]*)\);/.exec(
			bannerRule(BANNER.root),
		);

		expect(top?.[1]).toMatch(/var\(--view-header-top-offset\b/);
		expect(top?.[1]).toMatch(/var\(--view-header-height\b/);
	});

	it('sits below the tab header strip a tablet keeps above the view header', () => {
		// A tablet has no header offset and keeps the tab strip a phone hides,
		// so the phone placement would land the banner on the view header.
		const top = /--aar-banner-top:\s*calc\(([^;]*)\);/.exec(
			bannerRule(`.is-tablet ${BANNER.root}`),
		);

		expect(top?.[1]).toMatch(/var\(--safe-area-inset-top\)/);
		expect(top?.[1]).toMatch(/var\(--header-height\)/);
		expect(top?.[1]).toMatch(/var\(--view-header-height\)/);
	});

	it('sits right below the tab strip when a tablet hides the view header', () => {
		// Obsidian hides the view header off a phone unless "Show tab title
		// bar" adds .show-view-header, so the banner drops the header height.
		const top = /--aar-banner-top:\s*calc\(([^;]*)\);/.exec(
			bannerRule(`.is-tablet:not(.show-view-header) ${BANNER.root}`),
		);

		expect(top?.[1]).toMatch(/var\(--header-height\)/);
		expect(top?.[1]).not.toMatch(/var\(--view-header-height\)/);
	});

	it("takes the safe area from Obsidian's variable, not from env() directly", () => {
		expect(bannerRule(BANNER.root)).not.toMatch(/env\(safe-area-inset-top/);
	});

	it('takes the whole touch so a drag never scrolls the note under it', () => {
		expect(bannerRule(BANNER.root)).toMatch(/touch-action:\s*none/);
	});

	it('follows the drag offset on top of the anchor it rests at', () => {
		const transform = /transform:\s*translate\(([^;]*)\);/.exec(
			bannerRule(BANNER.root),
		);

		expect(transform?.[1]).toMatch(/var\(--aar-banner-drag-x, 0px\)/);
		expect(transform?.[1]).toMatch(/var\(--aar-banner-drag-y, 0px\)/);
	});

	it('lets a bottom anchor drop the top offset every platform rule sets', () => {
		// The platform rules set only --aar-banner-top, so a bottom anchor
		// wins over them whatever their specificity.
		for (const selector of [
			`.is-tablet ${BANNER.root}`,
			`.is-tablet:not(.show-view-header) ${BANNER.root}`,
		]) {
			expect(bannerRule(selector)).not.toMatch(/(^|[\s;])top:/);
		}
		expect(bannerRule(`${BANNER.root}[data-anchor^='bottom-']`)).toMatch(
			/top:\s*auto/,
		);
	});

	it('keeps a bottom anchor clear of the navbar and of the toolbar over the keyboard', () => {
		const bottom = bannerRule(`${BANNER.root}[data-anchor^='bottom-']`);

		expect(bottom).toMatch(/var\(--aar-banner-navbar-clearance\)/);
		expect(bottom).toMatch(/var\(--keyboard-height\)/);
		expect(bottom).toMatch(/var\(--mobile-toolbar-height\)/);
	});

	it('clears the docked and the floating phone navbar', () => {
		expect(bannerRule(`.is-phone ${BANNER.root}`)).toMatch(
			/--aar-banner-navbar-clearance:\s*var\(--navbar-height\)/,
		);
		expect(bannerRule(`.is-phone.is-floating-nav ${BANNER.root}`)).toMatch(
			/var\(--navbar-bottom-offset\)/,
		);
	});

	it.each([
		['left', /left:\s*calc\(var\(--safe-area-inset-left\)/],
		['right', /right:\s*calc\(var\(--safe-area-inset-right\)/],
	])(
		'pins a %s anchor inside the safe area without centring it',
		(side, inset) => {
			const rule = bannerRule(`${BANNER.root}[data-anchor$='-${side}']`);

			expect(rule).toMatch(inset);
			expect(rule).toMatch(/--aar-banner-shift-x:\s*0px/);
		},
	);

	it('gives the stop control a full touch target', () => {
		const stop = bannerRule(BANNER.stop);

		expect(stop).toMatch(/min-width:\s*var\(--touch-size-m\)/);
		expect(stop).toMatch(/min-height:\s*var\(--touch-size-m\)/);
		expect(stop).toMatch(/justify-content:\s*center/);
	});
});
