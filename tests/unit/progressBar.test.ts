/**
 * The progress bar the status bar and the transcription dialog share, built
 * on Obsidian's ProgressBarComponent. It owns the one rule for what a reported
 * percentage may become, because the same number is both the bar's width and
 * what a screen reader reads out.
 * @module tests/unit/progressBar.test
 */

import { createProgressBar } from 'src/ui/progressBar';
import { el } from '../helpers/dom';
import { OBSIDIAN } from '../helpers/selectors';
import { addObsidianDomExtensions } from '../mocks/domExtensions';

/** A bar mounted into a fresh container, with the element that carries its value. */
function createSut(): {
	bar: ReturnType<typeof createProgressBar>;
	host: HTMLElement;
} {
	const container = addObsidianDomExtensions(document.createElement('div'));
	const bar = createProgressBar(container, 'progress', 'Saving');
	return { bar, host: el(container, '.progress') };
}

describe('progress bar', () => {
	it.each([
		// Progress is read off work in flight: a division that has not
		// started yet is NaN, and a final flush that writes more than it
		// announced overshoots. Neither may reach the width or the reader.
		{ name: 'has not started counting', percent: Number.NaN, shown: '0' },
		{ name: 'has reported nothing yet', percent: undefined, shown: '0' },
		{ name: 'overshot its own estimate', percent: 140, shown: '100' },
		{ name: 'went backwards', percent: -20, shown: '0' },
		{ name: 'reports a fraction of a percent', percent: 41.6, shown: '42' },
		{ name: 'is exactly done', percent: 100, shown: '100' },
	])('shows $shown percent when the work $name', ({ percent, shown }) => {
		const { bar, host } = createSut();

		bar.setValue(percent);

		expect(host.getAttribute('aria-valuenow')).toBe(shown);
		expect(el(host, OBSIDIAN.progressFill).style.width).toBe(`${shown}%`);
	});

	it('is renamed for a screen reader when the work moves to another stage', () => {
		const { bar, host } = createSut();

		bar.setLabel('Writing file...');

		expect(host.getAttribute('aria-label')).toBe('Writing file...');
	});
});
