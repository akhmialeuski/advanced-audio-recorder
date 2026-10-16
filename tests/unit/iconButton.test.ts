/**
 * The icon-only button the status bar, the mobile banner, the transcription
 * queue and the player's marker rows all build. Each of them depends on the
 * same three things: a native button the keyboard can press, Obsidian's
 * icon-button class for its states, and a name a screen reader announces.
 * @module tests/unit/iconButton.test
 */

import { createIconButton } from 'src/ui/iconButton';
import { control } from '../helpers/dom';
import { addObsidianDomExtensions } from '../mocks/domExtensions';

/** A button built into a fresh container. */
function createSut(
	tooltip?: Parameters<typeof createIconButton>[1]['tooltip'],
): { container: HTMLElement; button: HTMLButtonElement } {
	const container = addObsidianDomExtensions(document.createElement('div'));
	const button = createIconButton(container, {
		icon: 'square',
		label: 'Stop recording',
		cls: 'aar-recording-banner-stop',
		tooltip,
	});
	return { container, button };
}

describe('icon button', () => {
	it('is a native button that does not submit anything', () => {
		// Enter and Space come from the platform only for a real button, and
		// a button without a type submits a form it happens to sit in.
		const { button } = createSut();

		expect(button).toBeInstanceOf(HTMLButtonElement);
		expect(button.type).toBe('button');
	});

	it("takes Obsidian's icon-button class beside the caller's own", () => {
		const { button } = createSut();

		expect([...button.classList]).toEqual([
			'clickable-icon',
			'aar-recording-banner-stop',
		]);
	});

	it('shows its icon and is found by the name a screen reader hears', () => {
		const { container, button } = createSut();

		expect(button.getAttribute('data-icon')).toBe('square');
		expect(control(container, 'Stop recording')).toBe(button);
	});

	it('opens its tooltip where the caller asks', () => {
		const { button } = createSut({ placement: 'top' });

		expect(button.getAttribute('data-tooltip-position')).toBe('top');
	});
});
