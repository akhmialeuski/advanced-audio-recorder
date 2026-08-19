/**
 * Tests the domain matchers the rest of the suite asserts through.
 *
 * A matcher that passes when it should fail hides every bug the tests using it
 * were written to catch, and its failure message is the only thing a developer
 * sees when something breaks - so both halves are worth testing.
 * @module tests/unit/helpers/matchers.test
 */

import { PLAYBACK, PLAYER } from '../../helpers/selectors';

/** An element tree built from HTML, as the components render it. */
function render(html: string): HTMLElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	return root;
}

/** Runs a matcher and returns what it reported, pass or fail. */
function outcome(run: () => void): { failed: boolean; message: string } {
	try {
		run();
		return { failed: false, message: '' };
	} catch (error) {
		return { failed: true, message: (error as Error).message };
	}
}

/** The first child of a rendered tree, as the element under test. */
function only(html: string): HTMLElement {
	return render(html).firstElementChild as HTMLElement;
}

describe('toHaveControl', () => {
	it('finds a control by the name a screen reader announces', () => {
		const root = render('<button aria-label="Stop playback"></button>');

		expect(root).toHaveControl('Stop playback');
	});

	it('does not match a control that is merely similar', () => {
		const root = render('<button aria-label="Stop"></button>');

		expect(root).not.toHaveControl('Stop playback');
	});

	it('lists the controls that are there when the wanted one is not', () => {
		const root = render(
			'<button aria-label="Play"></button><button aria-label="Mute"></button>',
		);

		const { message } = outcome(() => {
			expect(root).toHaveControl('Stop');
		});

		expect(message).toContain('"Play", "Mute"');
	});

	it('says so plainly when nothing at all was rendered', () => {
		const { message } = outcome(() => {
			expect(render('')).toHaveControl('Stop');
		});

		expect(message).toContain('(none)');
	});
});

describe('toBeDisabledControl', () => {
	it.each([
		{ name: 'the disabled property', html: '<button disabled></button>' },
		{ name: 'aria-disabled', html: '<span aria-disabled="true"></span>' },
		{
			name: 'the is-disabled class',
			html: '<span class="is-disabled"></span>',
		},
		{
			name: 'the mod-disabled class',
			html: '<span class="mod-disabled"></span>',
		},
	])('recognises $name', ({ html }) => {
		// The spellings all mean the control is inert; a matcher that knew
		// only one would pass on a control the user cannot press.
		expect(only(html)).toBeDisabledControl();
	});

	it('does not call an operable control disabled', () => {
		expect(only('<button></button>')).not.toBeDisabledControl();
	});

	it('reports every spelling it checked when the control is operable', () => {
		const { message } = outcome(() => {
			expect(
				only('<button class="mod-cta"></button>'),
			).toBeDisabledControl();
		});

		expect(message).toContain('disabled=false');
		expect(message).toContain('class="mod-cta"');
	});
});

describe('toShowTime', () => {
	it.each([
		{ name: 'the player', selector: PLAYER.time },
		{ name: 'the status bar', selector: PLAYBACK.time },
	])('reads the time out of $name', ({ selector }) => {
		const root = render(`<span class="${selector.slice(1)}">01:05</span>`);

		expect(root).toShowTime('01:05');
	});

	it('reads the time off the readout itself', () => {
		const readout = only(
			`<span class="${PLAYER.time.slice(1)}">01:05</span>`,
		);

		expect(readout).toShowTime('01:05');
	});

	it('fails when the readout shows a different time', () => {
		const root = render(
			`<span class="${PLAYER.time.slice(1)}">01:05</span>`,
		);

		const { message } = outcome(() => {
			expect(root).toShowTime('02:00');
		});

		expect(message).toContain('it shows "01:05"');
	});

	it('fails when there is no readout rather than passing vacuously', () => {
		const { message } = outcome(() => {
			expect(render('<span>01:05</span>')).toShowTime('01:05');
		});

		expect(message).toContain('renders none');
	});
});

describe('toHaveMarkerAt', () => {
	/** A seek area with the given marker ticks on it. */
	function withTicks(ticks: { time: number; label: string }[]): HTMLElement {
		return render(
			ticks
				.map(
					(tick) =>
						`<div class="${PLAYER.tick.slice(1)}" data-time="${String(tick.time)}" ` +
						`aria-label="${tick.label} (00:0${String(tick.time)})"></div>`,
				)
				.join(''),
		);
	}

	it('finds a marker by its position', () => {
		const root = withTicks([{ time: 5, label: 'Intro' }]);

		expect(root).toHaveMarkerAt(5);
	});

	it('finds a marker by position and label together', () => {
		const root = withTicks([
			{ time: 5, label: 'Intro' },
			{ time: 9, label: 'Outro' },
		]);

		expect(root).toHaveMarkerAt(9, 'Outro');
	});

	it('does not match the right time with the wrong label', () => {
		const root = withTicks([{ time: 5, label: 'Intro' }]);

		expect(root).not.toHaveMarkerAt(5, 'Outro');
	});

	it('does not match the right label at the wrong time', () => {
		const root = withTicks([{ time: 5, label: 'Intro' }]);

		expect(root).not.toHaveMarkerAt(7, 'Intro');
	});

	it('lists the markers that are there when the wanted one is not', () => {
		const root = withTicks([{ time: 5, label: 'Intro' }]);

		const { message } = outcome(() => {
			expect(root).toHaveMarkerAt(7);
		});

		expect(message).toContain('@5s');
	});
});
