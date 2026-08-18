/**
 * Tests click, drag, and keyboard seeking on the player's seek area.
 *
 * The controller was covered only incidentally, through the player, which left
 * 64% of its branches unrun - and its branches are all the cases where a seek
 * must NOT happen: a duration that is not yet known, a seek area with no width,
 * a keystroke that belongs to something else. Getting any of those wrong moves
 * playback when the user did not ask.
 * @module tests/unit/SeekController.test
 */

import { SeekController } from 'src/player/SeekController';
import type { SeekCallbacks, SeekHost } from 'src/player/SeekController';
import { PLAYER_SEEK_KEYBOARD_STEP_SECONDS } from 'src/constants';

/** The controller with the seek area it is attached to and its callbacks. */
function createSut(options: { duration?: number; width?: number } = {}): {
	controller: SeekController;
	seekEl: HTMLElement;
	onSeekToTime: jest.Mock;
	onSkip: jest.Mock;
	onEngageTimeline: jest.Mock;
} {
	const seekEl = document.createElement('div');
	const width = options.width ?? 200;
	seekEl.getBoundingClientRect = jest.fn(
		() => ({ left: 50, width, right: 50 + width, top: 0 }) as DOMRect,
	);
	const host: SeekHost = {
		registerDomEvent: (el, type, handler) => {
			el.addEventListener(type, handler as EventListener);
		},
	};
	const callbacks: SeekCallbacks = {
		onSeekToTime: jest.fn(),
		onSkip: jest.fn(),
		onEngageTimeline: jest.fn(),
		duration: () => options.duration ?? 100,
	};
	const controller = new SeekController(host, callbacks);
	controller.attach(seekEl);
	return {
		controller,
		seekEl,
		onSeekToTime: callbacks.onSeekToTime as jest.Mock,
		onSkip: callbacks.onSkip as jest.Mock,
		onEngageTimeline: callbacks.onEngageTimeline as jest.Mock,
	};
}

/** Dispatches a keydown the seek area will see. */
function press(seekEl: HTMLElement, key: string): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, cancelable: true });
	seekEl.dispatchEvent(event);
	return event;
}

describe('timeAtClientX', () => {
	it.each([
		{ name: 'the left edge', clientX: 50, expected: 0 },
		{ name: 'the middle', clientX: 150, expected: 50 },
		{ name: 'the right edge', clientX: 250, expected: 100 },
	])('maps $name to $expected seconds', ({ clientX, expected }) => {
		const { controller } = createSut();

		expect(controller.timeAtClientX(clientX)).toBe(expected);
	});

	it.each([
		{ name: 'left of the area', clientX: -500, expected: 0 },
		{ name: 'right of the area', clientX: 5000, expected: 100 },
	])(
		'clamps a pointer $name to $expected seconds',
		({ clientX, expected }) => {
			// A drag that leaves the seek area keeps seeking, so the coordinate
			// can be well outside it.
			const { controller } = createSut();

			expect(controller.timeAtClientX(clientX)).toBe(expected);
		},
	);

	it.each([
		{ name: 'the duration is not yet known', duration: Number.NaN },
		{ name: 'the stream is live', duration: Number.POSITIVE_INFINITY },
		{ name: 'the duration is zero', duration: 0 },
		{ name: 'the duration is negative', duration: -1 },
	])('answers nothing when $name', ({ duration }) => {
		const { controller } = createSut({ duration });

		expect(controller.timeAtClientX(150)).toBeNull();
	});

	it('answers nothing while the seek area has no width', () => {
		// Before layout the area measures zero, and every coordinate would
		// map to the same place.
		const { controller } = createSut({ width: 0 });

		expect(controller.timeAtClientX(150)).toBeNull();
	});

	it('answers nothing before it is attached to anything', () => {
		const host: SeekHost = { registerDomEvent: jest.fn() };
		const controller = new SeekController(host, {
			onSeekToTime: jest.fn(),
			onSkip: jest.fn(),
			onEngageTimeline: jest.fn(),
			duration: () => 100,
		});

		expect(controller.timeAtClientX(150)).toBeNull();
	});
});

describe('keyboard seeking', () => {
	it.each([
		{ key: 'ArrowRight', delta: PLAYER_SEEK_KEYBOARD_STEP_SECONDS },
		{ key: 'ArrowUp', delta: PLAYER_SEEK_KEYBOARD_STEP_SECONDS },
		{ key: 'ArrowLeft', delta: -PLAYER_SEEK_KEYBOARD_STEP_SECONDS },
		{ key: 'ArrowDown', delta: -PLAYER_SEEK_KEYBOARD_STEP_SECONDS },
	])('$key skips by $delta seconds', ({ key, delta }) => {
		const { seekEl, onSkip } = createSut();

		press(seekEl, key);

		expect(onSkip).toHaveBeenCalledWith(delta);
	});

	it('Home jumps to the start', () => {
		const { seekEl, onSeekToTime } = createSut();

		press(seekEl, 'Home');

		expect(onSeekToTime).toHaveBeenCalledWith(0);
	});

	it('End jumps to the end when the length is known', () => {
		const { seekEl, onSeekToTime } = createSut({ duration: 240 });

		press(seekEl, 'End');

		expect(onSeekToTime).toHaveBeenCalledWith(240);
	});

	it.each([
		{ name: 'a live stream', duration: Number.POSITIVE_INFINITY },
		{ name: 'a length that has not loaded', duration: Number.NaN },
	])(
		'End engages the timeline instead of seeking on $name',
		({ duration }) => {
			// Seeking to infinity lands nowhere; engaging the timeline at least
			// consumes the #t= hint so playback starts where it was asked to.
			const { seekEl, onSeekToTime, onEngageTimeline } = createSut({
				duration,
			});

			press(seekEl, 'End');

			expect(onSeekToTime).not.toHaveBeenCalled();
			expect(onEngageTimeline).toHaveBeenCalled();
		},
	);

	it.each(['ArrowRight', 'ArrowLeft', 'Home', 'End'])(
		'claims the %s key so the note does not scroll',
		(key) => {
			const { seekEl } = createSut();

			expect(press(seekEl, key).defaultPrevented).toBe(true);
		},
	);

	it.each(['a', 'Enter', 'Tab', 'PageDown'])(
		'leaves the %s key to whatever else wants it',
		(key) => {
			const { seekEl, onSkip, onSeekToTime } = createSut();

			const event = press(seekEl, key);

			expect(event.defaultPrevented).toBe(false);
			expect(onSkip).not.toHaveBeenCalled();
			expect(onSeekToTime).not.toHaveBeenCalled();
		},
	);
});

describe('pointer seeking', () => {
	/** Dispatches a pointer event with the capture API jsdom lacks. */
	function pointer(
		seekEl: HTMLElement,
		type: string,
		clientX: number,
		captured = { value: false },
	): void {
		seekEl.setPointerCapture = jest.fn(() => {
			captured.value = true;
		});
		seekEl.releasePointerCapture = jest.fn(() => {
			captured.value = false;
		});
		seekEl.hasPointerCapture = jest.fn(() => captured.value);
		const event = new MouseEvent(type, { clientX, bubbles: true });
		Object.defineProperty(event, 'pointerId', { value: 1 });
		seekEl.dispatchEvent(event);
	}

	it('seeks to where the pointer went down', () => {
		const { seekEl, onSeekToTime } = createSut();

		pointer(seekEl, 'pointerdown', 150);

		expect(onSeekToTime).toHaveBeenCalledWith(50);
	});

	it('captures the pointer so a drag off the area keeps seeking', () => {
		const captured = { value: false };
		const { seekEl } = createSut();

		pointer(seekEl, 'pointerdown', 150, captured);

		expect(seekEl.setPointerCapture).toHaveBeenCalled();
	});

	it('follows a drag', () => {
		const captured = { value: false };
		const { seekEl, onSeekToTime } = createSut();
		pointer(seekEl, 'pointerdown', 100, captured);

		pointer(seekEl, 'pointermove', 200, captured);

		expect(onSeekToTime).toHaveBeenLastCalledWith(75);
	});

	it('ignores a move that was not preceded by a press', () => {
		const { seekEl, onSeekToTime } = createSut();

		pointer(seekEl, 'pointermove', 200);

		expect(onSeekToTime).not.toHaveBeenCalled();
	});

	it('stops following after the pointer is released', () => {
		const captured = { value: false };
		const { seekEl, onSeekToTime } = createSut();
		pointer(seekEl, 'pointerdown', 100, captured);
		pointer(seekEl, 'pointerup', 100, captured);
		onSeekToTime.mockClear();

		pointer(seekEl, 'pointermove', 200, captured);

		expect(onSeekToTime).not.toHaveBeenCalled();
	});

	it('stops following when the gesture is cancelled', () => {
		const captured = { value: false };
		const { seekEl, onSeekToTime } = createSut();
		pointer(seekEl, 'pointerdown', 100, captured);
		pointer(seekEl, 'pointercancel', 100, captured);
		onSeekToTime.mockClear();

		pointer(seekEl, 'pointermove', 200, captured);

		expect(onSeekToTime).not.toHaveBeenCalled();
	});

	it('does not seek while the duration is unknown', () => {
		const { seekEl, onSeekToTime } = createSut({ duration: Number.NaN });

		pointer(seekEl, 'pointerdown', 150);

		expect(onSeekToTime).not.toHaveBeenCalled();
	});
});
