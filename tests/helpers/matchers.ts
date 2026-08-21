/**
 * Matchers for the things this plugin's UI is made of.
 *
 * Without them a test says
 * `expect(root.querySelector('[aria-label="Pause playback"]')).not.toBeNull()`,
 * and on failure Jest reports "expected null not to be null" - true, unhelpful,
 * and silent about which controls the status bar *did* render. These matchers
 * assert the same thing in the vocabulary of the UI and fail with the list.
 *
 * Registered globally from tests/setupAfterEnv.ts, so no test imports them.
 * @module tests/helpers/matchers
 */

import { allEls, controlLabels, maybeEl } from './dom';
import { BANNER, PLAYBACK, PLAYER } from './selectors';

/** Every element that reads out a time, in the order the UI stacks them. */
const TIME_READOUTS = [PLAYER.time, PLAYBACK.time, BANNER.time];

/** How a control says it is not available: the DOM has three spellings. */
function isDisabled(node: HTMLElement): boolean {
	return (
		(node as HTMLButtonElement).disabled === true ||
		node.getAttribute('aria-disabled') === 'true' ||
		node.classList.contains('is-disabled') ||
		node.classList.contains('mod-disabled')
	);
}

/** The time this element shows, from its own text or its time readout. */
function shownTime(root: HTMLElement): string | null {
	for (const selector of TIME_READOUTS) {
		if (root.matches(selector)) {
			return root.textContent ?? '';
		}
		const readout = maybeEl(root, selector);
		if (readout) {
			return readout.textContent ?? '';
		}
	}
	return null;
}

/** Obsidian's class for a control showing its engaged state. */
const ACTIVE_CLASS = 'is-active';

expect.extend({
	/**
	 * The element offers a control with the given accessible name.
	 * @param root - Element the UI rendered into
	 * @param label - The control's aria-label
	 * @returns Jest matcher result
	 */
	toHaveControl(root: HTMLElement, label: string) {
		const labels = controlLabels(root);
		const pass = labels.includes(label);
		return {
			pass,
			message: (): string =>
				pass
					? `Expected no control labelled "${label}", but one is there`
					: `Expected a control labelled "${label}". Rendered controls: ` +
						(labels.length > 0
							? labels.map((one) => `"${one}"`).join(', ')
							: '(none)'),
		};
	},

	/**
	 * The control is showing its engaged state - loop on, mute on, the
	 * marker row the playhead is inside.
	 *
	 * Obsidian's own `is-active` is the class every one of these uses, and
	 * three suites were spelling it out with `classList.contains`. Naming it
	 * once keeps the class string out of test bodies and makes the failure
	 * say which control was not engaged.
	 * @param node - The control
	 * @returns Jest matcher result
	 */
	toBeActiveControl(node: HTMLElement) {
		const pass = node.classList.contains(ACTIVE_CLASS);
		const name = node.getAttribute('aria-label') ?? node.className;
		return {
			pass,
			message: (): string =>
				pass
					? `Expected "${name}" not to be active, but it is`
					: `Expected "${name}" to be active, but it is not`,
		};
	},

	/**
	 * The control is rendered but not operable.
	 * @param node - The control
	 * @returns Jest matcher result
	 */
	toBeDisabledControl(node: HTMLElement) {
		const pass = isDisabled(node);
		return {
			pass,
			message: (): string =>
				pass
					? `Expected the control to be operable, but it is disabled`
					: `Expected the control to be disabled. It has ` +
						`disabled=${String((node as HTMLButtonElement).disabled)}, ` +
						`aria-disabled=${String(node.getAttribute('aria-disabled'))}, ` +
						`class="${node.className}"`,
		};
	},

	/**
	 * The element's time readout shows exactly this timecode.
	 * @param root - Element holding a time readout, or the readout itself
	 * @param expected - The timecode the user should see
	 * @returns Jest matcher result
	 */
	toShowTime(root: HTMLElement, expected: string) {
		const actual = shownTime(root);
		if (actual === null) {
			return {
				pass: false,
				message: (): string =>
					`Expected a time readout showing "${expected}", but the ` +
					`element renders none`,
			};
		}
		const pass = actual === expected;
		return {
			pass,
			message: (): string =>
				pass
					? `Expected the time readout not to show "${expected}"`
					: `Expected the time readout to show "${expected}", it shows "${actual}"`,
		};
	},

	/**
	 * A marker tick sits at the given time on the seek area.
	 * @param root - Element the player rendered into
	 * @param seconds - Marker position in seconds
	 * @param label - The marker's label, when the test cares which one it is
	 * @returns Jest matcher result
	 */
	toHaveMarkerAt(root: HTMLElement, seconds: number, label?: string) {
		const ticks = allEls(root, PLAYER.tick);
		const at = ticks.filter(
			(tick) => tick.dataset['time'] === String(seconds),
		);
		const named =
			label === undefined
				? at
				: at.filter((tick) =>
						(tick.getAttribute('aria-label') ?? '').startsWith(
							label,
						),
					);
		const pass = named.length > 0;
		const wanted =
			label === undefined
				? `at ${String(seconds)}s`
				: `"${label}" at ${String(seconds)}s`;
		return {
			pass,
			message: (): string =>
				pass
					? `Expected no marker ${wanted}, but one is there`
					: `Expected a marker ${wanted}. Rendered markers: ` +
						(ticks.length > 0
							? ticks
									.map(
										(tick) =>
											`${String(tick.getAttribute('aria-label'))} @${String(tick.dataset['time'])}s`,
									)
									.join(', ')
							: '(none)'),
		};
	},
});

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace -- the shape Jest augments
	namespace jest {
		interface Matchers<R> {
			/** The element offers a control with this accessible name. */
			toHaveControl(label: string): R;
			/** The control shows its engaged state (loop on, mute on). */
			toBeActiveControl(): R;
			/** The control is rendered but not operable. */
			toBeDisabledControl(): R;
			/** The element's time readout shows exactly this timecode. */
			toShowTime(expected: string): R;
			/** A marker tick sits at this time, optionally with this label. */
			toHaveMarkerAt(seconds: number, label?: string): R;
		}
	}
}
