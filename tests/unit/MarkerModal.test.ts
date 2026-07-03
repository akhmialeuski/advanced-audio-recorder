/**
 * Unit tests for RecordingMarkerModal: commit-on-confirm and
 * discard-on-close semantics over the draft editing handle, and the
 * kind toggle's default-label behavior.
 * @module tests/unit/MarkerModal.test
 */

import { App } from 'obsidian';
import { RecordingMarkerModal } from 'src/ui/MarkerModal';
import { MARKER_KIND } from 'src/markers/markerModel';
import type { MarkerKind } from 'src/markers/markerModel';
import type { RecordingMarkerHandle } from 'src/recording/recordingMarkers';

/** Builds a draft handle double with call-recording commit/cancel. */
function makeHandle(initialKind: MarkerKind = MARKER_KIND.bookmark): {
	handle: RecordingMarkerHandle;
	commit: jest.Mock;
	cancel: jest.Mock;
} {
	const commit = jest.fn();
	const cancel = jest.fn();
	const handle: RecordingMarkerHandle = {
		initialKind,
		defaultLabelFor: (kind: MarkerKind) =>
			kind === MARKER_KIND.bookmark ? 'Marker 1' : 'Chapter 1',
		commit,
		cancel,
	};
	return { handle, commit, cancel };
}

function openModal(handle: RecordingMarkerHandle): RecordingMarkerModal {
	const modal = new RecordingMarkerModal(new App(), handle);
	modal.onOpen();
	return modal;
}

function inputOf(modal: RecordingMarkerModal): HTMLInputElement {
	const input = modal.contentEl.querySelector('input');
	if (!input) {
		throw new Error('name input not rendered');
	}
	return input;
}

function buttonByText(
	modal: RecordingMarkerModal,
	text: string,
): HTMLButtonElement {
	const buttons = Array.from(modal.contentEl.querySelectorAll('button'));
	const button = buttons.find((el) => el.textContent?.includes(text));
	if (!button) {
		throw new Error(`button "${text}" not rendered`);
	}
	return button;
}

describe('RecordingMarkerModal', () => {
	it('seeds the input with the default label for the initial kind', () => {
		const { handle } = makeHandle();
		const modal = openModal(handle);

		expect(inputOf(modal).value).toBe('Marker 1');
	});

	it('commits the typed label and selected kind on Add', () => {
		const { handle, commit, cancel } = makeHandle();
		const modal = openModal(handle);

		inputOf(modal).value = 'Key point';
		// Add confirms and closes; the mock Modal.close() runs onClose
		buttonByText(modal, 'Add').click();

		expect(commit).toHaveBeenCalledWith('Key point', MARKER_KIND.bookmark);
		// A committed draft must not be discarded by the closing modal
		expect(cancel).not.toHaveBeenCalled();
	});

	it('commits on Enter in the name field', () => {
		const { handle, commit } = makeHandle();
		const modal = openModal(handle);

		inputOf(modal).dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter' }),
		);

		expect(commit).toHaveBeenCalledWith('Marker 1', MARKER_KIND.bookmark);
	});

	it('discards the draft when closed without confirming', () => {
		const { handle, commit, cancel } = makeHandle();
		const modal = openModal(handle);

		modal.close();

		expect(commit).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('discards the draft on Cancel', () => {
		const { handle, commit, cancel } = makeHandle();
		const modal = openModal(handle);

		// Cancel closes the modal; the mock Modal.close() runs onClose
		buttonByText(modal, 'Cancel').click();

		expect(commit).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('switching kind refreshes an untouched default label', () => {
		const { handle, commit } = makeHandle();
		const modal = openModal(handle);

		buttonByText(modal, 'Chapter').click();

		expect(inputOf(modal).value).toBe('Chapter 1');

		buttonByText(modal, 'Add').click();
		expect(commit).toHaveBeenCalledWith('Chapter 1', MARKER_KIND.chapter);
	});

	it('switching kind preserves a custom label', () => {
		const { handle, commit } = makeHandle();
		const modal = openModal(handle);

		inputOf(modal).value = 'My own name';
		buttonByText(modal, 'Chapter').click();

		expect(inputOf(modal).value).toBe('My own name');

		buttonByText(modal, 'Add').click();
		expect(commit).toHaveBeenCalledWith('My own name', MARKER_KIND.chapter);
	});

	it('starts on the chapter kind when the draft was captured as one', () => {
		const { handle, commit } = makeHandle(MARKER_KIND.chapter);
		const modal = openModal(handle);

		expect(inputOf(modal).value).toBe('Chapter 1');

		buttonByText(modal, 'Add').click();
		expect(commit).toHaveBeenCalledWith('Chapter 1', MARKER_KIND.chapter);
	});
});
