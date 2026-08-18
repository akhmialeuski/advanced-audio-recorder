/**
 * Tests the dialog that names a profile. The contract worth pinning is the one
 * the settings tree depends on: a profile's page is addressed by its name, so a
 * blank or already-taken name must never reach the caller.
 * @module tests/unit/ProfileNameModal.test
 */

import { ProfileNameModal } from 'src/ui/ProfileNameModal';
import type { App } from 'obsidian';
import { at } from '../helpers/assertions';
import { allEls, el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';

/** The taken names these tests reject a draft against. */
const TAKEN = ['Legal'];

/**
 * Opens a rename dialog and exposes what a test drives it through.
 * @param onSubmit - Receives the accepted name
 */
function open(onSubmit: (name: string) => void): {
	modal: ProfileNameModal;
	input: HTMLInputElement;
	buttons: HTMLButtonElement[];
	error: HTMLElement;
} {
	const modal = new ProfileNameModal({} as App, {
		title: 'Rename profile',
		confirmText: 'Rename',
		initial: 'Standup',
		rejection: (name) => {
			if (name === '') {
				return 'Give the profile a name.';
			}
			return TAKEN.includes(name)
				? 'Another profile already uses this name.'
				: undefined;
		},
		onSubmit,
	});
	modal.onOpen();
	return {
		modal,
		input: el<HTMLInputElement>(modal.contentEl, 'input'),
		buttons: allEls<HTMLButtonElement>(modal.contentEl, 'button'),
		error: el(modal.contentEl, MODAL.error),
	};
}

/**
 * Types a value into the dialog's field, the way the user does.
 * @param input - The dialog's name field
 * @param value - What is typed
 */
function type(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input'));
}

describe('ProfileNameModal', () => {
	it('opens on the current name, ready to be replaced', () => {
		const { input, buttons } = open(() => undefined);

		expect(input.value).toBe('Standup');
		expect(buttons.map((button) => button.textContent)).toEqual([
			'Rename',
			'Cancel',
		]);
	});

	it('accepts a free name, trimmed', () => {
		const onSubmit = jest.fn();
		const { input, buttons } = open(onSubmit);

		type(input, '  Robotics  ');
		at(buttons, 0).click();

		expect(onSubmit).toHaveBeenCalledWith('Robotics');
	});

	it('refuses a name another profile already uses', () => {
		const onSubmit = jest.fn();
		const { input, buttons, error } = open(onSubmit);

		type(input, 'Legal');

		// Two profiles under one name are two pages Obsidian cannot tell
		// apart, so the dialog says why instead of silently taking it.
		expect(error.textContent).toBe(
			'Another profile already uses this name.',
		);
		expect(at(buttons, 0).disabled).toBe(true);

		at(buttons, 0).click();

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('refuses a blank name and recovers when one is typed', () => {
		const onSubmit = jest.fn();
		const { input, buttons, error } = open(onSubmit);

		type(input, '   ');

		expect(error.textContent).toBe('Give the profile a name.');

		type(input, 'Robotics');

		// Empty is how the message leaves the layout again.
		expect(error.textContent).toBe('');
		expect(at(buttons, 0).disabled).toBe(false);

		at(buttons, 0).click();

		expect(onSubmit).toHaveBeenCalledWith('Robotics');
	});

	it('leaves the name alone on cancel', () => {
		const onSubmit = jest.fn();
		const { modal, buttons } = open(onSubmit);
		const close = jest.spyOn(modal, 'close');

		at(buttons, 1).click();

		expect(onSubmit).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});
});
