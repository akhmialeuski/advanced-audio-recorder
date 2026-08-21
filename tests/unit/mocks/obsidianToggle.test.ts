/**
 * Contract tests for the toggle in the obsidian mock.
 *
 * Obsidian's toggle is a div, not an input: its state lives in a class, and
 * nothing about it reads as `checked`. A double that stores the value without
 * showing it lets `expect(toggle.checked).toBe(false)` pass whatever the
 * toggle is doing - which is how an assertion that a row was switched off
 * stayed green next to a row that was on.
 * @module tests/unit/mocks/obsidianToggle.test
 */

// Imported from the mock by path: what is under test is the double's own
// behaviour, not the API surface the type definitions describe.
import { ToggleComponent } from '../../mocks/obsidian';

describe('ToggleComponent', () => {
	it('starts off, and shows it', () => {
		const toggle = new ToggleComponent();

		expect(toggle.value).toBe(false);
		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(false);
	});

	it('shows the value it was set to', () => {
		const toggle = new ToggleComponent();

		toggle.setValue(true);

		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(true);
	});

	it('stops showing it once it is set back off', () => {
		const toggle = new ToggleComponent();
		toggle.setValue(true);

		toggle.setValue(false);

		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(false);
	});

	it('flips both the value and what it shows when clicked', () => {
		const toggle = new ToggleComponent();
		const onChange = jest.fn();
		toggle.onChange(onChange);

		toggle.toggleEl.click();

		expect(toggle.value).toBe(true);
		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(true);
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('ignores a click while it is disabled', () => {
		const toggle = new ToggleComponent();
		const onChange = jest.fn();
		toggle.onChange(onChange);
		toggle.setValue(true);
		toggle.setDisabled(true);

		toggle.toggleEl.click();

		expect(toggle.value).toBe(true);
		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(true);
		expect(onChange).not.toHaveBeenCalled();
	});

	// Disabled and on are different things, and a row can be either or both.
	it('marks disabled separately from on', () => {
		const toggle = new ToggleComponent();

		toggle.setDisabled(true);

		expect(toggle.toggleEl.classList.contains('is-disabled')).toBe(true);
		expect(toggle.toggleEl.classList.contains('is-enabled')).toBe(false);
	});
});
