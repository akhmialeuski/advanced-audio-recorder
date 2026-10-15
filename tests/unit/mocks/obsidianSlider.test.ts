/**
 * Contract tests for the slider in the obsidian mock.
 *
 * Obsidian's SliderComponent decides when its change callback runs, and the
 * plugin's volume sliders depend on exactly that: on every drag step once
 * setInstant(true) is set, on release otherwise, and on setValue whenever the
 * value changes. A double that called back at other moments would pass tests
 * the app would fail.
 * @module tests/unit/mocks/obsidianSlider.test
 */

// Imported from the mock by path: what is under test is the double's own
// behaviour, not the API surface the type definitions describe.
import { SliderComponent } from '../../mocks/obsidian';

/** A slider over 0..1 in a fresh container, with a spy as its callback. */
function createSut(): {
	container: HTMLElement;
	slider: SliderComponent;
	onChange: jest.Mock;
} {
	const container = document.createElement('div');
	const onChange = jest.fn();
	const slider = new SliderComponent(container)
		.setLimits(0, 1, 0.05)
		.onChange(onChange);
	return { container, slider, onChange };
}

/** Fires the event a drag step or a release fires, at a value. */
function move(
	slider: SliderComponent,
	type: 'input' | 'change',
	value: number,
) {
	slider.sliderEl.value = String(value);
	slider.sliderEl.dispatchEvent(new Event(type));
}

describe('SliderComponent', () => {
	it('builds the inline value and the range input into its container', () => {
		const { container, slider } = createSut();

		expect([...container.children]).toEqual([
			slider.valueEl,
			slider.sliderEl,
		]);
		expect(slider.sliderEl.type).toBe('range');
	});

	it('takes the limits as the input attributes', () => {
		const { slider } = createSut();

		expect(slider.sliderEl.min).toBe('0');
		expect(slider.sliderEl.max).toBe('1');
		expect(slider.sliderEl.step).toBe('0.05');
	});

	it('does not report a drag step by default', () => {
		const { slider, onChange } = createSut();

		move(slider, 'input', 0.4);

		expect(onChange).not.toHaveBeenCalled();
	});

	it('reports the release by default', () => {
		const { slider, onChange } = createSut();

		move(slider, 'change', 0.4);

		expect(onChange).toHaveBeenCalledWith(0.4);
	});

	it('reports every drag step and not the release once instant', () => {
		const { slider, onChange } = createSut();
		slider.setInstant(true);

		move(slider, 'input', 0.4);
		move(slider, 'change', 0.4);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(0.4);
	});

	it('reports a value set from code when it differs from the shown one', () => {
		const { slider, onChange } = createSut();

		slider.setValue(0.3);

		expect(onChange).toHaveBeenCalledWith(0.3);
	});

	it('stays silent when set to the value it already shows', () => {
		const { slider, onChange } = createSut();
		slider.setValue(0.3);
		onChange.mockClear();

		slider.setValue(0.3);

		expect(onChange).not.toHaveBeenCalled();
	});

	it('fills the track up to the value over the limits', () => {
		const container = document.createElement('div');
		const slider = new SliderComponent(container).setLimits(10, 20, 1);

		slider.setValue(15);

		expect(
			slider.sliderEl.style.getPropertyValue('--slider-fill-ratio'),
		).toBe('0.5');
	});

	it.each([
		{ name: 'a fractional step', step: 0.05, value: 0.5, text: '0.50' },
		{ name: 'a whole step', step: 1, value: 7, text: '7' },
	])('shows the value inline for $name', ({ step, value, text }) => {
		const slider = new SliderComponent(document.createElement('div'))
			.setLimits(0, 10, step)
			.setValue(value);

		expect(slider.valueEl.textContent).toBe(text);
	});

	it('shows the value through a display format it was given', () => {
		const slider = new SliderComponent(document.createElement('div'))
			.setLimits(0, 1, 0.05)
			.setDisplayFormat((value) => `${String(value * 100)}%`)
			.setValue(0.5);

		expect(slider.valueEl.textContent).toBe('50%');
	});

	it('disables the input', () => {
		const { slider } = createSut();

		slider.setDisabled(true);

		expect(slider.sliderEl.disabled).toBe(true);
	});
});
