/**
 * Unit tests for the release notes dialog.
 * @module tests/unit/ReleaseNotesModal.test
 */

import { App, MarkdownRenderer } from 'obsidian';
import type { Component } from 'obsidian';
import { ReleaseNotesModal } from 'src/ui/ReleaseNotesModal';
import { el, maybeEl, textOf } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';

/** The notes a dialog under test is handed. */
const NOTES = '# 2.3.2\nWhat changed.';

/**
 * Opens the dialog over the notes given.
 * @param notes - The Markdown the dialog is handed
 * @returns The opened dialog
 */
function openModal(notes: string): ReleaseNotesModal {
	const modal = new ReleaseNotesModal(new App(), notes);
	modal.onOpen();
	return modal;
}

/**
 * The component the dialog handed to the renderer, whose lifetime the rendered
 * children follow.
 * @returns The component, or undefined when nothing was rendered
 */
function renderedInto(): Component | undefined {
	return jest.mocked(MarkdownRenderer.render).mock.calls[0]?.[4];
}

describe('ReleaseNotesModal with notes to show', () => {
	it('titles itself so the dialog says what it is', () => {
		const modal = openModal(NOTES);

		expect(modal.titleEl.textContent).toBe("What's new");
	});

	it('hands the notes to Obsidian rather than parsing Markdown itself', () => {
		const modal = openModal(NOTES);

		expect(MarkdownRenderer.render).toHaveBeenCalledWith(
			modal.app,
			NOTES,
			el(modal.contentEl, MODAL.releaseNotes),
			'',
			expect.anything(),
		);
	});

	it('renders the notes into a body of their own, so they can scroll', () => {
		const modal = openModal(NOTES);

		expect(el(modal.contentEl, MODAL.releaseNotes).textContent).toBe(NOTES);
	});

	it('says where the dialog is turned off', () => {
		const modal = openModal(NOTES);

		expect(el(modal.contentEl, MODAL.config).textContent).toBe(
			'This dialog can be turned off in the plugin settings.',
		);
	});

	it('closes from its own button', () => {
		const modal = openModal(NOTES);
		const close = jest.spyOn(modal, 'close');

		el<HTMLButtonElement>(modal.modalEl, 'button').click();

		expect(close).toHaveBeenCalledTimes(1);
	});

	it('scrolls the notes under a title and a Close that stay put', () => {
		// Three releases of notes are longer than any window. Scrolling the
		// dialog as one whole would carry its own title, its close button and
		// its Close action off the top with the text.
		const modal = openModal(NOTES);

		expect(modal.modalEl.matches(MODAL.scrollableBody)).toBe(true);
		expect(maybeEl(modal.contentEl, 'button')).toBeNull();
		expect(textOf(el(modal.modalEl, MODAL.actions), 'button')).toBe(
			'Close',
		);
	});

	it('unloads the renderer while the DOM it built over is still there', () => {
		// Obsidian's render children tear down against the elements they were
		// built over, so the unload has to run before the body is emptied.
		const modal = openModal(NOTES);
		const body = el(modal.contentEl, MODAL.releaseNotes);
		const stillAttached = jest.fn();
		renderedInto()?.register(() => {
			stillAttached(modal.contentEl.contains(body));
		});

		modal.onClose();

		expect(stillAttached).toHaveBeenCalledWith(true);
	});

	it('unloads the component the renderer attached its children to', () => {
		// Obsidian's renderer builds child components inside the dialog - a
		// callout's fold, a code block's copy button - and they are torn down
		// with the component they were attached to. Modal is not one, so the
		// dialog carries its own, and a close that forgets it leaves them
		// running over DOM that no longer exists.
		const modal = openModal(NOTES);
		const released = jest.fn();
		renderedInto()?.register(released);

		modal.onClose();

		expect(released).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.children).toHaveLength(0);
	});
});

describe('ReleaseNotesModal with nothing to show', () => {
	it('says so instead of opening an empty body', () => {
		const modal = openModal('');

		expect(maybeEl(modal.contentEl, MODAL.releaseNotes)).toBeNull();
		expect(textOf(modal.contentEl, 'p')).toBe(
			'This version ships no release notes. The full history is on the releases page of the plugin repository.',
		);
	});

	it('leaves Obsidian nothing to render', () => {
		openModal('');

		expect(MarkdownRenderer.render).toHaveBeenCalledTimes(0);
	});

	it('still offers a way out', () => {
		const modal = openModal('');
		const close = jest.spyOn(modal, 'close');

		el<HTMLButtonElement>(modal.contentEl, 'button').click();

		expect(close).toHaveBeenCalledTimes(1);
	});
});
