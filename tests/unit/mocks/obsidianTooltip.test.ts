/**
 * Contract tests for setTooltip in the obsidian mock.
 *
 * Obsidian's setTooltip names the element as well as giving it a tooltip:
 * the text lands in `aria-label`, which the app's tooltip shows on hover and a
 * screen reader announces. A double that only stored the text somewhere else
 * would let an icon button with no accessible name pass its tests.
 * @module tests/unit/mocks/obsidianTooltip.test
 */

// Imported from the mock by path: what is under test is the double's own
// behaviour, not the API surface the type definitions describe.
import { setTooltip } from '../../mocks/obsidian';

describe('setTooltip', () => {
	it('names the element with the tooltip text', () => {
		const button = document.createElement('button');

		setTooltip(button, 'Stop recording');

		expect(button.getAttribute('aria-label')).toBe('Stop recording');
	});

	it('replaces the name it gave before', () => {
		const button = document.createElement('button');
		setTooltip(button, 'Pause recording');

		setTooltip(button, 'Resume recording');

		expect(button.getAttribute('aria-label')).toBe('Resume recording');
	});

	it('records a placement other than the default', () => {
		const button = document.createElement('button');

		setTooltip(button, 'Stop recording', { placement: 'top' });

		expect(button.getAttribute('data-tooltip-position')).toBe('top');
	});

	it('writes nothing for the default bottom placement', () => {
		const button = document.createElement('button');

		setTooltip(button, 'Stop recording', { placement: 'bottom' });

		expect(button.hasAttribute('data-tooltip-position')).toBe(false);
	});

	it('records the delay, the gap and the classes it was given', () => {
		const button = document.createElement('button');

		setTooltip(button, 'Stop recording', {
			delay: 300,
			gap: 4,
			classes: ['one', 'two'],
		});

		expect(button.getAttribute('data-tooltip-delay')).toBe('300');
		expect(button.getAttribute('data-tooltip-gap')).toBe('4');
		expect(button.getAttribute('data-tooltip-classes')).toBe('one two');
	});
});
