/**
 * The obsidian module with `Setting` swapped for the recording double.
 *
 * A settings section is worth asserting on twice: that it rendered the rows,
 * and that editing a row calls back into the plugin. `CapturingSetting` records
 * both, which the shared `Setting` does not.
 *
 * The point of routing that swap through here is what surrounds it. A test file
 * that wrote `jest.mock('obsidian', () => ({ Setting: CapturingSetting }))`
 * replaced the entire module, so `Notice`, `Platform`, and everything else
 * became undefined in that file alone - a quietly different Obsidian from the
 * one every other test runs against. Spreading the real mock first keeps the
 * module whole and narrows the substitution to the one class the test is
 * actually interested in.
 *
 * Usage, at the top of a test file:
 * ```ts
 * jest.mock('obsidian', () =>
 *     require('../mocks/modules/obsidianWithCapturingSetting'),
 * );
 * ```
 * @module tests/mocks/modules/obsidianWithCapturingSetting
 */

import { CapturingSetting } from '../../helpers/captureSettings';

// requireActual resolves through moduleNameMapper, so this is the shared mock,
// not the types-only package.
const actual = jest.requireActual<typeof import('../obsidian')>(
	'../../mocks/obsidian',
);

module.exports = {
	...actual,
	Setting: CapturingSetting,
};
