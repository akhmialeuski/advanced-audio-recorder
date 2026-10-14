/**
 * Tests the confirmation dialog that gates destructive actions (regenerating
 * chapters over existing ones, merging two diarized speakers). The contract
 * worth pinning is that each callback fires once and only for its own answer:
 * a cancel that still ran the action, or a confirm that ran it twice, destroys
 * the user's content, and a caller awaiting the answer hangs forever on a no
 * that is never reported.
 * @module tests/unit/ConfirmModal.test
 */

import { confirmAction, ConfirmModal } from 'src/ui/ConfirmModal';
import type { App } from 'obsidian';
import { at } from '../helpers/assertions';
import { modalInstances } from '../mocks/obsidian';
import { tick } from '../helpers/async';

/** Opens a confirm dialog and exposes its rendered buttons. */
function open(
	onConfirm: () => void,
	onCancel?: () => void,
): {
	modal: ConfirmModal;
	buttons: HTMLButtonElement[];
} {
	const modal = new ConfirmModal({} as App, {
		title: 'Replace chapters?',
		message: 'The note already has chapters.',
		confirmText: 'Replace',
		onConfirm,
		...(onCancel ? { onCancel } : {}),
	});
	modal.open();
	return {
		modal,
		buttons: Array.from(modal.buttonContainerEl.querySelectorAll('button')),
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

	it('runs the action exactly once on confirm, then closes', async () => {
		const onConfirm = jest.fn();
		const { modal, buttons } = open(onConfirm);
		const close = jest.spyOn(modal, 'close');

		at(buttons, 0).click();
		await tick();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('runs nothing on cancel', async () => {
		const onConfirm = jest.fn();
		const { modal, buttons } = open(onConfirm);
		const close = jest.spyOn(modal, 'close');

		at(buttons, 1).click();
		await tick();

		expect(onConfirm).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('reports the no exactly once on cancel', async () => {
		const onCancel = jest.fn();
		const { buttons } = open(() => undefined, onCancel);

		at(buttons, 1).click();
		await tick();

		// A caller that awaits the answer hangs forever without it.
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('reports the no when the dialog is dismissed without an answer', () => {
		// Escape and the window chrome close the dialog without touching a
		// button, and they mean the same thing as Cancel.
		const onCancel = jest.fn();
		const { modal } = open(() => undefined, onCancel);

		modal.close();

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('reports no cancel once the action was confirmed', async () => {
		const onCancel = jest.fn();
		const { buttons } = open(() => undefined, onCancel);

		at(buttons, 0).click();
		await tick();

		expect(onCancel).not.toHaveBeenCalled();
	});
});

describe('confirmAction', () => {
	/** Asks, then presses the given button of the dialog it opened. */
	function answer(button: 0 | 1): Promise<boolean> {
		const answered = confirmAction({} as App, {
			title: 'Merge 3 lines?',
			message: '3 transcript lines become one.',
			confirmText: 'Merge',
		});
		const dialog = at(modalInstances, modalInstances.length - 1);
		at(
			Array.from(dialog.modalEl.querySelectorAll('button')),
			button,
		).click();
		return answered;
	}

	it('answers yes when confirmed', async () => {
		await expect(answer(0)).resolves.toBe(true);
	});

	it('answers no when cancelled', async () => {
		await expect(answer(1)).resolves.toBe(false);
	});
});
