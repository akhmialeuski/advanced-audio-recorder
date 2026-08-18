/**
 * Tests the add-a-model dialog.
 *
 * The dialog's whole job is to refuse to hand back an id that is not usable:
 * the Add button starts disabled, follows what is typed, and the click handler
 * checks again before closing. None of that was covered - the file was at 18%
 * statements and 0% functions - so an id of pure whitespace could have reached
 * the settings list unnoticed.
 * @module tests/unit/ModelIdModal.test
 */

import type { App } from 'obsidian';
import { ModelIdModal } from 'src/ui/ModelIdModal';
import { at } from '../helpers/assertions';
import { capturedSettings } from '../helpers/captureSettings';
import type { CapturedSetting } from '../helpers/captureSettings';

// The recording Setting, so the field's onChange and the Add button's disabled
// state are both reachable.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

/** The dialog, opened, with the pieces a test drives. */
function openModal(): {
	modal: ModelIdModal;
	onAdd: jest.Mock;
	row: CapturedSetting;
	type: (value: string) => void;
	add: CapturedSetting['buttons'][number];
	cancel: CapturedSetting['buttons'][number];
} {
	const onAdd = jest.fn();
	const modal = new ModelIdModal({} as App, onAdd);
	jest.spyOn(modal, 'close');
	modal.onOpen();
	const row = at(capturedSettings, 0);
	const buttons = capturedSettings.flatMap((entry) => entry.buttons);
	return {
		modal,
		onAdd,
		row,
		type: (value: string): void => {
			row.changes.text?.(value);
		},
		add: at(
			buttons.filter((button) => button.label === 'Add'),
			0,
		),
		cancel: at(
			buttons.filter((button) => button.label === 'Cancel'),
			0,
		),
	};
}

beforeEach(() => {
	capturedSettings.length = 0;
});

describe('ModelIdModal rendering', () => {
	it('titles itself and labels the one field it has', () => {
		const { modal, row } = openModal();

		expect(modal.titleEl.textContent).toBe('Add model');
		expect(row.name).toBe('Model ID');
		expect(row.desc).toContain('whisper-1');
	});

	it('starts with the Add button disabled, since nothing has been typed', () => {
		const { add } = openModal();

		expect(add.disabled).toBe(true);
	});

	it('offers exactly Add and Cancel', () => {
		openModal();

		expect(
			capturedSettings
				.flatMap((entry) => entry.buttons)
				.map((button) => button.label),
		).toEqual(['Add', 'Cancel']);
	});
});

describe('ModelIdModal input validation', () => {
	it.each([
		{ name: 'a plain id', typed: 'whisper-1', usable: true },
		{
			name: 'an id with surrounding spaces',
			typed: '  whisper-1  ',
			usable: true,
		},
		{ name: 'a single character', typed: 'x', usable: true },
		{ name: 'nothing at all', typed: '', usable: false },
		{ name: 'only spaces', typed: '   ', usable: false },
		{ name: 'only a tab', typed: '\t', usable: false },
	])('enables Add for $name: $usable', ({ typed, usable }) => {
		const { type, add } = openModal();

		type(typed);

		expect(add.setDisabled).toHaveBeenLastCalledWith(!usable);
	});

	it('disables Add again when a usable id is cleared', () => {
		const { type, add } = openModal();

		type('whisper-1');
		type('');

		expect(add.setDisabled).toHaveBeenLastCalledWith(true);
	});
});

describe('ModelIdModal confirming', () => {
	it('hands back the trimmed id and closes', () => {
		const { modal, onAdd, type, add } = openModal();

		type('  whisper-1  ');
		add.click();

		expect(onAdd).toHaveBeenCalledWith('whisper-1');
		expect(modal.close).toHaveBeenCalled();
	});

	it('closes before handing the id over, so the caller can open another dialog', () => {
		const order: string[] = [];
		const onAdd = jest.fn(() => order.push('onAdd'));
		const modal = new ModelIdModal({} as App, onAdd);
		jest.spyOn(modal, 'close').mockImplementation(() => {
			order.push('close');
		});
		modal.onOpen();
		at(capturedSettings, 0).changes.text?.('whisper-1');

		at(
			capturedSettings.flatMap((entry) => entry.buttons),
			0,
		).click();

		expect(order).toEqual(['close', 'onAdd']);
	});

	it.each([
		{ name: 'nothing typed', typed: null },
		{ name: 'only whitespace typed', typed: '   ' },
	])('refuses to confirm with $name', ({ typed }) => {
		const { modal, onAdd, type, add } = openModal();
		if (typed !== null) {
			type(typed);
		}

		// The button is disabled in this state, but the handler checks again:
		// a disabled button is a rendering detail, not a guarantee.
		add.click();

		expect(onAdd).not.toHaveBeenCalled();
		expect(modal.close).not.toHaveBeenCalled();
	});
});

describe('ModelIdModal cancelling', () => {
	it('closes without handing anything back', () => {
		const { modal, onAdd, cancel } = openModal();

		cancel.click();

		expect(modal.close).toHaveBeenCalled();
		expect(onAdd).not.toHaveBeenCalled();
	});

	it('closes without handing anything back even after a usable id was typed', () => {
		const { modal, onAdd, type, cancel } = openModal();

		type('whisper-1');
		cancel.click();

		expect(modal.close).toHaveBeenCalled();
		expect(onAdd).not.toHaveBeenCalled();
	});
});
