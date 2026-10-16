/**
 * Contract tests for the progress bar in the obsidian mock.
 *
 * Obsidian's ProgressBarComponent paints its value as the width of an inner
 * element and clamps it into 0..100 on the way. A double that stored the
 * value without painting it would let a bar that never fills pass.
 * @module tests/unit/mocks/obsidianProgressBar.test
 */

// Imported from the mock by path: what is under test is the double's own
// behaviour, not the API surface the type definitions describe.
import { ProgressBarComponent } from '../../mocks/obsidian';

/** A bar mounted into a fresh container. */
function createSut(): { container: HTMLElement; bar: ProgressBarComponent } {
	const container = document.createElement('div');
	return { container, bar: new ProgressBarComponent(container) };
}

describe('ProgressBarComponent', () => {
	it('builds the bar and its fill into the container it is given', () => {
		const { container, bar } = createSut();

		expect(bar.progressBar.parentElement).toBe(container);
		expect(bar.lineEl.parentElement).toBe(bar.progressBar);
	});

	it('paints the value as the width of the fill', () => {
		const { bar } = createSut();

		bar.setValue(40);

		expect(bar.lineEl.style.width).toBe('40%');
		expect(bar.getValue()).toBe(40);
	});

	it.each([
		{ name: 'above 100', value: 140, shown: 100 },
		{ name: 'below 0', value: -20, shown: 0 },
	])('clamps a value $name', ({ value, shown }) => {
		const { bar } = createSut();

		bar.setValue(value);

		expect(bar.getValue()).toBe(shown);
	});

	it('hides the bar without removing it', () => {
		const { bar } = createSut();

		bar.setVisibility(false);

		expect(bar.progressBar.hidden).toBe(true);
	});
});
