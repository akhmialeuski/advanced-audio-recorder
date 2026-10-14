/**
 * Tests for the picker a palette command opens when it could run on more
 * than one target: it offers every target by the name its family gives it,
 * narrows them as the user types, and runs the command on the one chosen.
 * @jest-environment jsdom
 */

import { App } from 'obsidian';
import { ActionTargetModal } from 'src/ui/ActionTargetModal';

/** Two recordings of a note, as a family names them. */
const TARGETS = [
	{ path: 'Recordings/standup.webm' },
	{ path: 'Recordings/retro.mp3' },
];

/** A picker over the two recordings, the command a spy. */
function createSut(): {
	modal: ActionTargetModal<{ path: string }>;
	run: jest.Mock;
} {
	const run = jest.fn();
	return {
		modal: new ActionTargetModal(
			new App(),
			TARGETS,
			(target) => target.path,
			run,
		),
		run,
	};
}

describe('choosing the target of a command', () => {
	it('offers every target in the order given', () => {
		const { modal } = createSut();

		expect(modal.getItems()).toEqual(TARGETS);
		expect(modal.getItems()).not.toBe(TARGETS);
	});

	it('names each target as its family does, and matches the query on it', () => {
		const { modal } = createSut();

		expect(modal.getItemText({ path: 'Recordings/retro.mp3' })).toBe(
			'Recordings/retro.mp3',
		);
		expect(
			modal.getSuggestions('retro').map((match) => match.item),
		).toEqual([{ path: 'Recordings/retro.mp3' }]);
	});

	it('asks what to run the command on', () => {
		expect(createSut().modal.inputEl.placeholder).toBe(
			'Choose what to run the command on',
		);
	});

	it('runs the command on the target chosen', () => {
		const { modal, run } = createSut();

		modal.onChooseItem({ path: 'Recordings/retro.mp3' });

		expect(run).toHaveBeenCalledWith({ path: 'Recordings/retro.mp3' });
	});
});
