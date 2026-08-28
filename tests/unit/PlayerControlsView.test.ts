/**
 * Unit tests for the enhanced player's control row.
 *
 * The row is pure DOM: it owns no audio and decides nothing, so what it
 * has to get right is which control reports which intention, what each
 * one is called (the accessible name is how a keyboard user reaches it),
 * and that a re-render reflects the audio that is already playing rather
 * than the defaults.
 * @module tests/unit/PlayerControlsView.test
 */

import { App, Modal } from 'obsidian';
import {
	allEls,
	control,
	controlLabels,
	el,
	maybeControl,
} from '../helpers/dom';
import { PLAYER } from '../helpers/selectors';
import {
	PlayerControlsView,
	type PlayerControlsCallbacks,
	type PlayerControlsHost,
	type PlayerControlsState,
} from 'src/player/views/PlayerControlsView';
import { MARKER_KIND } from 'src/markers/markerModel';
import { PLAYER_ICONS, PLAYER_SKIP_SECONDS } from 'src/constants';

/** Builds an Obsidian-extended container element. */
function extendedEl(): HTMLElement {
	return new Modal(new App()).contentEl.createDiv();
}

/** A host that attaches listeners directly, mirroring registerDomEvent. */
const host: PlayerControlsHost = {
	registerDomEvent: (element, type, handler) => {
		element.addEventListener(type, handler as EventListener);
	},
};

function makeCallbacks(): jest.Mocked<PlayerControlsCallbacks> {
	return {
		onTogglePlay: jest.fn(),
		onSkip: jest.fn(),
		onSpeedMenu: jest.fn(),
		onToggleMute: jest.fn(),
		onVolumeInput: jest.fn(),
		onToggleLoop: jest.fn(() => true),
		onAddMarker: jest.fn(),
		onPreviousChapter: jest.fn(),
		onNextChapter: jest.fn(),
		onToggleChapterLoop: jest.fn(),
		onCopyTimestampLink: jest.fn(),
	};
}

interface Sut {
	view: PlayerControlsView;
	container: HTMLElement;
	callbacks: jest.Mocked<PlayerControlsCallbacks>;
}

/**
 * Mounts a control row over the given audio state.
 * @param state - What the shared audio is doing at mount time
 * @returns The view, its container, and the recorded callbacks
 */
function createSut(state: Partial<PlayerControlsState> = {}): Sut {
	const container = extendedEl();
	const callbacks = makeCallbacks();
	const view = new PlayerControlsView(host, callbacks);
	view.mount(container, {
		paused: true,
		playbackRate: 1,
		volume: 1,
		muted: false,
		loop: false,
		markersEnabled: true,
		skipSeconds: 10,
		chapterLoop: false,
		...state,
	});
	return { view, container, callbacks };
}

/** The controls every render offers, in the order they are laid out. */
const FIXED_CONTROLS = [
	'Play / pause',
	`Back ${String(PLAYER_SKIP_SECONDS)}s`,
	`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
	'Playback speed',
	'Mute / unmute',
	'Volume',
	'Loop',
];

/** The five a markerless render leaves out, in their place in the row. */
const MARKER_CONTROLS = [
	'Add marker at current position',
	'Add chapter at current position',
	'Previous chapter',
	'Next chapter',
	'Repeat current chapter',
];

describe('the controls the row offers', () => {
	it('names every control, so each is reachable without the mouse', () => {
		const { container } = createSut();

		expect(controlLabels(container)).toEqual([
			...FIXED_CONTROLS,
			...MARKER_CONTROLS,
			'Copy timestamp link',
		]);
	});

	// Adding markers edits the note, which reading view does not allow; the
	// four marker controls are the ones a markerless render leaves out.
	it('leaves the marker controls out when markers are off', () => {
		const { container } = createSut({ markersEnabled: false });

		expect(controlLabels(container)).toEqual([
			...FIXED_CONTROLS,
			'Copy timestamp link',
		]);
	});

	// Adding a marker writes to the note, so reading view hides exactly
	// these two and leaves the rest of the row operable.
	it('marks the two add buttons as edit-only, and nothing else', () => {
		const { container } = createSut();

		expect(
			allEls(container, PLAYER.editOnly).map((node) =>
				node.getAttribute('aria-label'),
			),
		).toEqual([
			'Add marker at current position',
			'Add chapter at current position',
		]);
	});
});

describe('what each control reports', () => {
	it('reports a play/pause press without deciding anything itself', () => {
		const { container, callbacks } = createSut();

		control(container, 'Play / pause').click();

		expect(callbacks.onTogglePlay).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: 'back',
			label: `Back ${String(PLAYER_SKIP_SECONDS)}s`,
			delta: -PLAYER_SKIP_SECONDS,
		},
		{
			name: 'forward',
			label: `Forward ${String(PLAYER_SKIP_SECONDS)}s`,
			delta: PLAYER_SKIP_SECONDS,
		},
	])('reports a skip $name by its signed distance', ({ label, delta }) => {
		const { container, callbacks } = createSut();

		control(container, label).click();

		expect(callbacks.onSkip).toHaveBeenCalledWith(delta);
	});

	// The speed menu opens at the pointer, so the handler needs the event
	// itself rather than a bare notification that the button was pressed.
	it('hands the speed menu the event it must position itself against', () => {
		const { container, callbacks } = createSut();
		const event = new MouseEvent('click', { clientX: 120, clientY: 40 });

		control(container, 'Playback speed').dispatchEvent(event);

		expect(callbacks.onSpeedMenu).toHaveBeenCalledWith(event);
	});

	it('reports a mute press', () => {
		const { container, callbacks } = createSut();

		control(container, 'Mute / unmute').click();

		expect(callbacks.onToggleMute).toHaveBeenCalledTimes(1);
	});

	it('reports the volume the slider was dragged to', () => {
		const { container, callbacks } = createSut();
		const volume = control<HTMLInputElement>(container, 'Volume');

		volume.value = '0.4';
		volume.dispatchEvent(new Event('input'));

		expect(callbacks.onVolumeInput).toHaveBeenCalledWith(0.4);
	});

	it.each([
		{
			name: 'a marker',
			label: 'Add marker at current position',
			kind: MARKER_KIND.bookmark,
		},
		{
			name: 'a chapter',
			label: 'Add chapter at current position',
			kind: MARKER_KIND.chapter,
		},
	])('reports adding $name by its kind', ({ label, kind }) => {
		const { container, callbacks } = createSut();

		control(container, label).click();

		expect(callbacks.onAddMarker).toHaveBeenCalledWith(kind);
	});

	it('reports a step to the previous chapter', () => {
		const { container, callbacks } = createSut();

		control(container, 'Previous chapter').click();

		expect(callbacks.onPreviousChapter).toHaveBeenCalledTimes(1);
	});

	it('reports a step to the next chapter', () => {
		const { container, callbacks } = createSut();

		control(container, 'Next chapter').click();

		expect(callbacks.onNextChapter).toHaveBeenCalledTimes(1);
	});

	it('reports a request to copy the timestamp link', () => {
		const { container, callbacks } = createSut();

		control(container, 'Copy timestamp link').click();

		expect(callbacks.onCopyTimestampLink).toHaveBeenCalledTimes(1);
	});

	// Looping is the one control whose new state the player answers with,
	// because the audio element owns it.
	it('takes the loop state from the answer rather than assuming it', () => {
		const { container, callbacks } = createSut();
		callbacks.onToggleLoop.mockReturnValue(true);

		control(container, 'Loop').click();

		expect(control(container, 'Loop')).toBeActiveControl();

		callbacks.onToggleLoop.mockReturnValue(false);
		control(container, 'Loop').click();

		expect(control(container, 'Loop')).not.toBeActiveControl();
	});
});

describe('a row mounted over audio that is already running', () => {
	// A mode switch re-renders the row over audio that never stopped, and a
	// play icon over playing audio invites a press that pauses it.
	it('shows the pause icon when the audio is already playing', () => {
		const { container } = createSut({ paused: false });

		expect(control(container, 'Play / pause').dataset['icon']).toBe(
			PLAYER_ICONS.pause,
		);
	});

	it('shows the play icon when the audio is paused', () => {
		const { container } = createSut({ paused: true });

		expect(control(container, 'Play / pause').dataset['icon']).toBe(
			PLAYER_ICONS.play,
		);
	});

	it('shows the loop state the audio was already in', () => {
		const { container } = createSut({ loop: true });

		expect(control(container, 'Loop')).toBeActiveControl();
	});

	it('shows the muted state the audio was already in', () => {
		const { container } = createSut({ muted: true });

		expect(control(container, 'Mute / unmute')).toBeActiveControl();
	});

	it('shows the speed the audio was already playing at', () => {
		const { container } = createSut({ playbackRate: 1.5 });

		expect(el(container, PLAYER.speed).textContent).toBe('1.5x');
	});

	it('shows the volume the audio was already at', () => {
		const { container } = createSut({ volume: 0.25 });

		expect(control<HTMLInputElement>(container, 'Volume').value).toBe(
			'0.25',
		);
	});

	it('starts the time display at zero of zero', () => {
		const { container } = createSut();

		expect(el(container, PLAYER.time).textContent).toBe('0:00 / 0:00');
	});
});

describe('reflecting a change the player made', () => {
	it('shows the speed the player switched to', () => {
		const { view, container } = createSut();

		view.setPlaybackRate(2);

		expect(el(container, PLAYER.speed).textContent).toBe('2x');
	});

	it('shows the elapsed and total time the player formatted', () => {
		const { view, container } = createSut();

		view.setTime('1:05 / 3:20');

		expect(el(container, PLAYER.time).textContent).toBe('1:05 / 3:20');
	});

	it('flips the play button to pause once playback starts', () => {
		const { view, container } = createSut();

		view.setPlaying(true);

		expect(control(container, 'Play / pause').dataset['icon']).toBe(
			PLAYER_ICONS.pause,
		);
	});

	it('marks the mute button active once the player muted the audio', () => {
		const { view, container } = createSut();

		view.setMuted(true);

		expect(control(container, 'Mute / unmute')).toBeActiveControl();
	});

	it('clears the mute mark once the player unmuted it', () => {
		const { view, container } = createSut({ muted: true });

		view.setMuted(false);

		expect(control(container, 'Mute / unmute')).not.toBeActiveControl();
	});
});

// The player owns the row's lifetime and can report a state change while no
// row is mounted - between a mode switch and the next render. Each setter
// has to be a no-op then rather than throwing into the player's own handler.
describe('a state change reported before anything is mounted', () => {
	function unmounted(): PlayerControlsView {
		return new PlayerControlsView(host, makeCallbacks());
	}

	it.each([
		{ name: 'playing', act: (v: PlayerControlsView) => v.setPlaying(true) },
		{ name: 'muted', act: (v: PlayerControlsView) => v.setMuted(true) },
		{
			name: 'a playback rate',
			act: (v: PlayerControlsView) => v.setPlaybackRate(2),
		},
		{ name: 'a time', act: (v: PlayerControlsView) => v.setTime('0:01') },
		{
			name: 'a chapter loop',
			act: (v: PlayerControlsView) => v.setChapterLoop(true),
		},
	])('ignores $name', ({ act }) => {
		const view = unmounted();

		expect(() => {
			act(view);
		}).not.toThrow();
	});

	it('renders nothing of its own until it is mounted', () => {
		const container = extendedEl();
		unmounted();

		expect(maybeControl(container, 'Play / pause')).toBeNull();
	});
});

// A styling class showed the state and announced nothing, so a listener using
// a screen reader could not tell whether looping was on or the sound was off
// without playing the track and finding out. aria-pressed is what a button
// that stays pressed reports itself with.
describe('reporting a toggle state to assistive technology', () => {
	/** What a control announces about being pressed. */
	function pressed(container: HTMLElement, label: string): string | null {
		return control(container, label).getAttribute('aria-pressed');
	}

	it('reports the loop state the audio was already in', () => {
		const { container } = createSut({ loop: true });

		expect(pressed(container, 'Loop')).toBe('true');
	});

	it('reports looping as off when it is', () => {
		const { container } = createSut({ loop: false });

		expect(pressed(container, 'Loop')).toBe('false');
	});

	it('reports the loop state the player answered a press with', () => {
		const { container, callbacks } = createSut({ loop: false });
		callbacks.onToggleLoop.mockReturnValue(true);

		control(container, 'Loop').click();

		expect(pressed(container, 'Loop')).toBe('true');
	});

	it('reports the muted state the audio was already in', () => {
		const { container } = createSut({ muted: true });

		expect(pressed(container, 'Mute / unmute')).toBe('true');
	});

	it('reports the mute state the player moved to', () => {
		const { view, container } = createSut({ muted: false });

		view.setMuted(true);

		expect(pressed(container, 'Mute / unmute')).toBe('true');
	});

	it('reports the sound as on again once the player unmuted it', () => {
		const { view, container } = createSut({ muted: true });

		view.setMuted(false);

		expect(pressed(container, 'Mute / unmute')).toBe('false');
	});

	// The play button had the gap in its stronger form: it carried its state
	// in the icon alone, without even the class the other two had, so a
	// listener using a screen reader was told what the button is for and never
	// which of the two states the track was in.
	it('reports playback as running when the audio already was', () => {
		const { container } = createSut({ paused: false });

		expect(pressed(container, 'Play / pause')).toBe('true');
	});

	it('reports playback as stopped when the audio is paused', () => {
		const { container } = createSut({ paused: true });

		expect(pressed(container, 'Play / pause')).toBe('false');
	});

	it('reports the playback state the player moved to', () => {
		const { view, container } = createSut({ paused: true });

		view.setPlaying(true);

		expect(pressed(container, 'Play / pause')).toBe('true');
	});

	// The accent class belongs to the two controls that use it to show they
	// are engaged. The play button shows its state in the icon, and tinting it
	// while the track runs would be a change to the row nobody asked for.
	it('leaves the play button without the engaged styling', () => {
		const { container } = createSut({ paused: false });

		expect(control(container, 'Play / pause')).not.toBeActiveControl();
	});
});

// The status bar toggles the same repeat, so the button follows what the
// player reports rather than its own click - which is why it returns nothing.
describe('repeating the current chapter', () => {
	const LABEL = 'Repeat current chapter';

	it('asks the player to toggle, without deciding the state itself', () => {
		const { container, callbacks } = createSut();

		control(container, LABEL).click();

		expect(callbacks.onToggleChapterLoop).toHaveBeenCalledTimes(1);
		expect(control(container, LABEL)).not.toBeActiveControl();
	});

	it('marks the button once the player reports the loop engaged', () => {
		const { view, container } = createSut();

		view.setChapterLoop(true);

		expect(control(container, LABEL)).toBeActiveControl();
		expect(control(container, LABEL).getAttribute('aria-pressed')).toBe(
			'true',
		);
	});

	it('clears the mark once the player reports it switched off', () => {
		const { view, container } = createSut({ chapterLoop: true });

		view.setChapterLoop(false);

		expect(control(container, LABEL)).not.toBeActiveControl();
	});

	it('shows the loop a re-rendered row was mounted over', () => {
		const { container } = createSut({ chapterLoop: true });

		expect(control(container, LABEL)).toBeActiveControl();
	});

	it('offers no repeat where there are no chapters to repeat', () => {
		const { container } = createSut({ markersEnabled: false });

		expect(maybeControl(container, LABEL)).toBeNull();
	});
});
