/**
 * The volume slider the player and the status bar share, built on Obsidian's
 * SliderComponent. The component reports a value set from code as if the user
 * had dragged to it, so what is tested here is mostly that the slider tells a
 * drag from a volume the playback pushed in.
 * @module tests/unit/volumeSlider.test
 */

import { createVolumeSlider } from 'src/ui/volumeSlider';
import { addObsidianDomExtensions } from '../mocks/domExtensions';

/** A slider mounted into a fresh container, with a spy for what it reports. */
function createSut(volume = 1): {
	container: HTMLElement;
	slider: ReturnType<typeof createVolumeSlider>;
	onInput: jest.Mock;
} {
	const container = addObsidianDomExtensions(document.createElement('div'));
	const onInput = jest.fn();
	const slider = createVolumeSlider(container, 'volume', volume, onInput);
	return { container, slider, onInput };
}

/** Moves the thumb the way a drag does, one input event per step. */
function drag(input: HTMLInputElement, value: number): void {
	input.value = String(value);
	input.dispatchEvent(new Event('input'));
}

describe('volume slider', () => {
	it('reports the volume while the thumb is dragged, not only on release', () => {
		const { slider, onInput } = createSut();

		drag(slider.el, 0.4);

		expect(onInput).toHaveBeenCalledWith(0.4);
	});

	it('starts at the volume it was given without reporting it', () => {
		const { slider, onInput } = createSut(0.3);

		expect(slider.el.value).toBe('0.3');
		expect(onInput).not.toHaveBeenCalled();
	});

	it('shows a volume from the playback without reporting it back', () => {
		// Reported back, a volume pushed in while the track is muted would
		// unmute it, since setting an audible volume does.
		const { slider, onInput } = createSut(0.5);

		slider.show(0.2);

		expect(slider.el.value).toBe('0.2');
		expect(onInput).not.toHaveBeenCalled();
	});

	it('reports a drag that follows a shown volume', () => {
		const { slider, onInput } = createSut(0.5);
		slider.show(0.2);

		drag(slider.el, 0.7);

		expect(onInput).toHaveBeenCalledWith(0.7);
	});

	it.each([
		{ name: 'it starts at', act: (): void => undefined, text: '50%' },
		{
			name: 'it is dragged to',
			act: (el: HTMLInputElement): void => drag(el, 0.85),
			text: '85%',
		},
	])('announces the volume $name as a percentage', ({ act, text }) => {
		const { slider } = createSut(0.5);

		act(slider.el);

		expect(slider.el.getAttribute('aria-valuetext')).toBe(text);
	});

	it('announces a shown volume as a percentage', () => {
		const { slider } = createSut(0.5);

		slider.show(0.05);

		expect(slider.el.getAttribute('aria-valuetext')).toBe('5%');
	});

	it('keeps the inline value text Obsidian adds empty, so the app hides it', () => {
		const { container, slider } = createSut(0.5);

		drag(slider.el, 0.6);

		expect(container.textContent).toBe('');
	});

	it('fills the track up to a shown volume', () => {
		const { slider } = createSut(0.5);

		slider.show(0.25);

		expect(slider.el.style.getPropertyValue('--slider-fill-ratio')).toBe(
			'0.25',
		);
	});

	it('is named for a screen reader', () => {
		const { container } = createSut();

		expect(container).toHaveControl('Volume');
	});
});
