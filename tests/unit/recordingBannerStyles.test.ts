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
		const top = /top:\s*calc\(([^;]*)\);/.exec(bannerRule(BANNER.root));

		expect(top?.[1]).toMatch(/var\(--view-header-top-offset\b/);
		expect(top?.[1]).toMatch(/var\(--view-header-height\b/);
	});

	it('sits below the tab header strip a tablet keeps above the view header', () => {
		// A tablet has no header offset and keeps the tab strip a phone hides,
		// so the phone placement would land the banner on the view header.
		const top = /top:\s*calc\(([^;]*)\);/.exec(
			bannerRule(`.is-tablet ${BANNER.root}`),
		);

		expect(top?.[1]).toMatch(/var\(--safe-area-inset-top\)/);
		expect(top?.[1]).toMatch(/var\(--header-height\)/);
		expect(top?.[1]).toMatch(/var\(--view-header-height\)/);
	});

	it('sits right below the tab strip when a tablet hides the view header', () => {
		// Obsidian hides the view header off a phone unless "Show tab title
		// bar" adds .show-view-header, so the banner drops the header height.
		const top = /top:\s*calc\(([^;]*)\);/.exec(
			bannerRule(`.is-tablet:not(.show-view-header) ${BANNER.root}`),
		);

		expect(top?.[1]).toMatch(/var\(--header-height\)/);
		expect(top?.[1]).not.toMatch(/var\(--view-header-height\)/);
	});

	it("takes the safe area from Obsidian's variable, not from env() directly", () => {
		expect(bannerRule(BANNER.root)).not.toMatch(/env\(safe-area-inset-top/);
	});

	it('gives the stop control a full touch target', () => {
		const stop = bannerRule(BANNER.stop);

		expect(stop).toMatch(/min-width:\s*var\(--touch-size-m\)/);
		expect(stop).toMatch(/min-height:\s*var\(--touch-size-m\)/);
		expect(stop).toMatch(/justify-content:\s*center/);
	});
});
