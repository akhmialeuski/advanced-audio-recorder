/**
 * Tests the confirmation dialog that gates destructive actions (regenerating
 * chapters over existing ones). The contract worth pinning is that the callback
 * fires once and only on confirm: a cancel that still ran the action, or a
 * confirm that ran it twice, destroys the user's content.
 * @module tests/unit/ConfirmModal.test
 */

import { ConfirmModal } from 'src/ui/ConfirmModal';
import type { App } from 'obsidian';
import { at } from '../helpers/assertions';

/** Opens a confirm dialog and exposes its rendered buttons. */
function open(onConfirm: () => void): {
	modal: ConfirmModal;
	buttons: HTMLButtonElement[];
} {
	const modal = new ConfirmModal({} as App, {
		title: 'Replace chapters?',
		message: 'The note already has chapters.',
		confirmText: 'Replace',
		onConfirm,
	});
	modal.onOpen();
	return {
		modal,
		buttons: Array.from(modal.contentEl.querySelectorAll('button')),
	};
}

describe('ConfirmModal', () => {
	it('renders the title, message, and the confirm/cancel pair', () => {
		const { modal, buttons } = open(() => undefined);

		expect(modal.contentEl.textContent).toContain(
			'The note already has chapters.',
		);
		expect(buttons.map((b) => b.textContent)).toEqual([
			'Replace',
			'Cancel',
		]);
	});

	it('marks the confirm button as destructive', () => {
		const { buttons } = open(() => undefined);

		// The dialog exists to slow the user down; a confirm styled like an
		// ordinary action defeats the point.
		expect(at(buttons, 0).classList.contains('mod-warning')).toBe(true);
	});

	it('runs the action exactly once on confirm', () => {
		const onConfirm = jest.fn();
		const { modal, buttons } = open(onConfirm);
		const close = jest.spyOn(modal, 'close');

		at(buttons, 0).click();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		// Closed before the action runs, so a slow action does not leave the
		// dialog on screen looking unresponsive.
		expect(close).toHaveBeenCalled();
	});

	it('runs nothing on cancel', () => {
		const onConfirm = jest.fn();
		const { modal, buttons } = open(onConfirm);
		const close = jest.spyOn(modal, 'close');

		at(buttons, 1).click();

		expect(onConfirm).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});

	it('empties its body on close', () => {
		const { modal } = open(() => undefined);

		modal.onClose();

		expect(modal.contentEl.children).toHaveLength(0);
	});
});
