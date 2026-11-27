/**
 * Regression guard for the tables of the Template variables dialog on a
 * phone. Every name and example is a code span with no break opportunity,
 * such as {{durationSeconds}} or Recordings/recording-2026-09-22.webm, so the
 * three columns needed about 480 px and overflowed a dialog about 300 px wide,
 * clipping the example column. On a phone each row is laid out as a card
 * instead: the name and its example on one line, the description under them.
 * jsdom does no layout, so the test pins the declarations in the stylesheet.
 * @module tests/unit/templateVariablesStyles.test
 */

import { ruleBody } from '../helpers/stylesheet';

const PHONE_TABLE = '.is-phone .aar-template-variables';

/** The declaration body of a rule, asserting it exists. */
function rule(selector: string): string {
	const body = ruleBody(selector);
	expect(body).not.toBeNull();
	return body ?? '';
}

describe('template variables table on a phone', () => {
	it('lays each row out as a card instead of three columns', () => {
		expect(rule(`${PHONE_TABLE} tr`)).toMatch(/display:\s*grid/);
		expect(rule(`${PHONE_TABLE} thead`)).toMatch(/display:\s*none/);
	});

	it('puts the description on a line of its own under the name', () => {
		expect(rule(`${PHONE_TABLE} td:nth-child(2)`)).toMatch(
			/grid-column:\s*1\s*\/\s*-1/,
		);
	});

	it('lets a long example break, and keeps the name whole', () => {
		expect(rule(`${PHONE_TABLE} td:nth-child(3) code`)).toMatch(
			/overflow-wrap:\s*anywhere/,
		);
		expect(ruleBody(`${PHONE_TABLE} td:nth-child(1) code`)).toBeNull();
	});
});
