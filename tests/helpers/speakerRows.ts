/**
 * Driving the Rename speakers dialog: its name fields, and the merge
 * confirmation an apply that gives two speakers one name has to get past.
 *
 * Every suite that exercises the dialog fills the same rows the same way -
 * look the input up by its engine label, fail loudly when the row is not
 * there, assign the name - and three of them had written that loop out by
 * hand. One helper keeps the "row is missing" failure naming the label instead
 * of surfacing as an undefined two assertions later.
 * @module tests/helpers/speakerRows
 */

import { modalInstances } from '../mocks/obsidian';
import { tick } from './async';

/**
 * Types one name per speaker row, leaving the rest of the dialog alone.
 * @param inputs - The dialog's name input per engine label
 * @param names - Name to type, keyed by engine label
 */
export function typeSpeakerNames(
	inputs: Map<string, HTMLInputElement>,
	names: Record<string, string>,
): void {
	for (const [label, name] of Object.entries(names)) {
		const input = inputs.get(label);
		if (!input) {
			throw new Error(`missing input for ${label}`);
		}
		input.value = name;
	}
}

/**
 * Runs an apply that opens the merge confirmation and answers it. The apply is
 * awaited only after the answer, since that is what it is blocked on, and the
 * confirmation's text is read before the press, since closing it empties its
 * body.
 * @param apply - Starts the dialog's apply (do not await it first)
 * @param button - Text of the confirmation button to press
 * @returns What the confirmation said
 */
export async function applyAnsweringMerge(
	apply: () => Promise<void>,
	button: 'Merge' | 'Cancel',
): Promise<string> {
	const applied = apply();
	await tick();
	const confirm = modalInstances.at(-1);
	if (!confirm) {
		throw new Error('no confirmation was opened');
	}
	const asked = confirm.contentEl.textContent ?? '';
	const pressed = [...confirm.contentEl.querySelectorAll('button')].find(
		(candidate) => candidate.textContent === button,
	);
	if (!pressed) {
		throw new Error(`the confirmation has no "${button}" button`);
	}
	pressed.click();
	await applied;
	return asked;
}
