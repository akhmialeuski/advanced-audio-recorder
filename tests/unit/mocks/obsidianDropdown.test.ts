/**
 * Contract tests for the dropdown in the obsidian mock.
 *
 * Obsidian's DropdownComponent is constructed with the element it renders
 * into and appends its select there, carrying the app's dropdown class. Code
 * that builds one outside a Setting depends on that, so the double does it
 * too, and still works for a Setting that appends the select itself.
 * @module tests/unit/mocks/obsidianDropdown.test
 */

// Imported from the mock by path: what is under test is the double's own
// behaviour, not the API surface the type definitions describe.
import { DropdownComponent } from '../../mocks/obsidian';

describe('DropdownComponent', () => {
	it('appends its select to the container it is given', () => {
		const container = document.createElement('div');

		const dropdown = new DropdownComponent(container);

		expect(dropdown.selectEl.parentElement).toBe(container);
	});

	it('carries the app dropdown class', () => {
		const dropdown = new DropdownComponent();

		expect(dropdown.selectEl.classList.contains('dropdown')).toBe(true);
	});

	it('stays detached when built without a container', () => {
		const dropdown = new DropdownComponent();

		expect(dropdown.selectEl.parentElement).toBeNull();
	});

	it('reads the value the user picked through the DOM', () => {
		const dropdown = new DropdownComponent(document.createElement('div'))
			.addOption('a', 'First')
			.addOption('b', 'Second');

		dropdown.selectEl.value = 'b';

		expect(dropdown.getValue()).toBe('b');
	});
});
