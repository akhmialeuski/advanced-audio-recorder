/**
 * What the status bar shows for each thing the plugin can be doing.
 *
 * The status bar is the only feedback a user gets while a recording, a save, a
 * transcription, or a playback is running, and all four render into the same
 * element - so the interesting behaviour is as much what one state clears from
 * the previous one as what it draws.
 * @module tests/unit/StatusBar.test
 */

import {
	updateStatusBar,
	initializeStatusBar,
	renderPlaybackStatusBar,
	renderTranscriptionStatusBar,
	updateRecordingLiveStats,
} from 'src/ui/StatusBar';
import { at } from '../helpers/assertions';
import { allEls, control, el, maybeEl } from '../helpers/dom';
import { PLAYBACK, PLAYER, STATUS } from '../helpers/selectors';
import { addObsidianDomExtensions } from '../mocks/domExtensions';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { RecordingStatus } from 'src/types';
import type { RecordingControls } from 'src/types';

/** A status bar element with the DOM extensions Obsidian adds at runtime. */
function createStatusBar(): HTMLElement {
	return addObsidianDomExtensions(document.createElement('div'));
}

/**
 * A complete playback snapshot with jest-backed commands.
 * @param overrides - State fields to replace for a specific assertion
 * @returns Playback state accepted by the status-bar renderer
 */
function makePlaybackState(
	overrides: Partial<PlaybackControlsState> = {},
): PlaybackControlsState {
	return {
		currentTime: 65,
		duration: 222,
		paused: false,
		volume: 0.75,
		muted: false,
		markersEnabled: true,
		onTogglePlay: jest.fn(),
		onStop: jest.fn(),
		onSkip: jest.fn(),
		onToggleMute: jest.fn(),
		onVolumeInput: jest.fn(),
		onAddMarker: jest.fn(),
		...overrides,
	};
}

/**
 * The pause/stop commands the recording state renders buttons for.
 * @param isPaused - Whether the recording is currently paused
 * @returns Controls with jest-backed commands
 */
function recordingControls(isPaused = false): RecordingControls {
	return { onPauseResume: jest.fn(), onStop: jest.fn(), isPaused };
}

/** A status bar already showing a recording with its controls. */
function recordingWithControls(isPaused = false): {
	statusBarItem: HTMLElement;
	controls: RecordingControls;
} {
	const statusBarItem = createStatusBar();
	const controls = recordingControls(isPaused);
	updateStatusBar(
		statusBarItem,
		isPaused ? RecordingStatus.Paused : RecordingStatus.Recording,
		undefined,
		controls,
	);
	return { statusBarItem, controls };
}

/** A status bar already showing a minimised transcription. */
function transcribing(percent = 10): {
	statusBarItem: HTMLElement;
	onActivate: jest.Mock;
} {
	const statusBarItem = createStatusBar();
	const onActivate = jest.fn();
	renderTranscriptionStatusBar(
		statusBarItem,
		{ percent, description: 'Transcribing...' },
		{ onActivate, activationLabel: 'Restore transcription window' },
	);
	return { statusBarItem, onActivate };
}

describe('recording status', () => {
	it.each([
		{
			name: 'recording',
			status: RecordingStatus.Recording,
			text: 'Recording...',
		},
		{
			name: 'paused',
			status: RecordingStatus.Paused,
			text: 'Recording paused',
		},
	])('says it is $name', ({ status, text }) => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, status);

		expect(statusBarItem.textContent).toContain(text);
		expect(statusBarItem.classList.contains('is-recording')).toBe(true);
		expect(statusBarItem.classList.contains('is-saving')).toBe(false);
	});

	it.each([
		{ name: 'idle', status: RecordingStatus.Idle },
		{ name: 'a status it does not know', status: 'unknown' },
	])('clears itself when the plugin goes $name', ({ status }) => {
		const statusBarItem = createStatusBar();
		statusBarItem.classList.add('is-recording', 'is-saving');
		statusBarItem.textContent = 'Something';

		updateStatusBar(statusBarItem, status as RecordingStatus);

		expect(statusBarItem.textContent).toBe('');
		expect(statusBarItem.classList.contains('is-recording')).toBe(false);
		expect(statusBarItem.classList.contains('is-saving')).toBe(false);
	});

	it.each([
		{
			name: 'updateStatusBar',
			act: (): void => updateStatusBar(null, RecordingStatus.Recording),
		},
		{
			name: 'initializeStatusBar',
			act: (): void => initializeStatusBar(null),
		},
		{
			name: 'renderPlaybackStatusBar',
			act: (): void => renderPlaybackStatusBar(null, makePlaybackState()),
		},
		{
			name: 'renderTranscriptionStatusBar',
			act: (): void =>
				renderTranscriptionStatusBar(
					null,
					{ percent: 10, description: 'Transcribing...' },
					{ onActivate: jest.fn(), activationLabel: 'Restore' },
				),
		},
		{
			name: 'updateRecordingLiveStats',
			act: (): void =>
				updateRecordingLiveStats(null, {
					elapsedMs: 0,
					bytes: 0,
					level: 0,
				}),
		},
	])('$name does nothing when there is no status bar', ({ act }) => {
		// Obsidian hands out no status bar on mobile, and every entry point is
		// reachable from there.
		expect(act).not.toThrow();
	});

	it('starts out cleared', () => {
		const statusBarItem = createStatusBar();
		statusBarItem.classList.add('is-recording');
		statusBarItem.textContent = 'Recording...';

		initializeStatusBar(statusBarItem);

		expect(statusBarItem.textContent).toBe('');
		expect(statusBarItem.classList.contains('is-recording')).toBe(false);
	});
});

describe('saving progress', () => {
	it('shows what it is doing and how far along it is', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Saving, {
			percent: 40,
			description: 'Assembling audio...',
		});

		expect(statusBarItem.classList.contains('is-saving')).toBe(true);
		expect(statusBarItem.classList.contains('is-recording')).toBe(false);
		expect(el(statusBarItem, 'span').textContent).toBe(
			'Assembling audio...',
		);
		expect(
			el(statusBarItem, STATUS.saveProgressBar).style.getPropertyValue(
				'--save-progress',
			),
		).toBe('40%');
	});

	// A save the user did not ask for reads as an ordinary one unless the bar
	// says why, and the Notice that explained it has usually gone by then. The
	// finalizer's own progress line used to replace the reason the moment it
	// arrived, which is most of the save.
	it('keeps saying the input was lost while the save runs', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Interrupted, {
			percent: 20,
			description: 'Assembling audio...',
		});

		expect(el(statusBarItem, 'span').textContent).toBe(
			'Input lost: Assembling audio...',
		);
		expect(statusBarItem.classList.contains('is-saving')).toBe(true);
		expect(statusBarItem.classList.contains('is-recording')).toBe(false);
	});

	it('names the lost input before any progress is reported', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Interrupted);

		expect(el(statusBarItem, 'span').textContent).toBe(
			'Input lost, saving...',
		);
	});

	it('says a plain "Saving..." at zero when no progress was reported', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Saving);

		expect(el(statusBarItem, 'span').textContent).toBe('Saving...');
		expect(
			el(statusBarItem, STATUS.saveProgressBar).style.getPropertyValue(
				'--save-progress',
			),
		).toBe('0%');
	});

	it('puts the bar inside the progress container', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Saving, {
			percent: 60,
			description: 'Writing file...',
		});

		const container = el(statusBarItem, STATUS.saveProgress);
		const bar = el(container, STATUS.saveProgressBar);

		// The bar is the only part that moves, and it moves through the
		// custom property the stylesheet reads: a bar that is there but never
		// fills says nothing is happening.
		expect(bar.style.getPropertyValue('--save-progress')).toBe('60%');
	});

	it.each([
		// The percentage comes from bytes written over bytes expected, and
		// both come off a recorder mid-save: a division that has not started
		// yet is NaN, and a final flush that writes more than it announced
		// overshoots. Neither may reach the stylesheet.
		{ name: 'has not started counting', percent: Number.NaN, shown: '0%' },
		{ name: 'overshot its own estimate', percent: 140, shown: '100%' },
		{ name: 'went backwards', percent: -20, shown: '0%' },
		{ name: 'is exactly done', percent: 100, shown: '100%' },
		{ name: 'is exactly at the start', percent: 0, shown: '0%' },
	])('fills the bar to $shown when the save $name', ({ percent, shown }) => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Saving, {
			percent,
			description: 'Writing file...',
		});

		const bar = el(
			el(statusBarItem, STATUS.saveProgress),
			STATUS.saveProgressBar,
		);

		expect(bar.style.getPropertyValue('--save-progress')).toBe(shown);
	});

	it.each([
		{ name: 'idle', status: RecordingStatus.Idle, text: '' },
		{
			name: 'recording again',
			status: RecordingStatus.Recording,
			text: 'Recording...',
		},
	])('drops the progress when it goes $name', ({ status, text }) => {
		const statusBarItem = createStatusBar();
		updateStatusBar(statusBarItem, RecordingStatus.Saving, {
			percent: 50,
			description: 'Assembling...',
		});
		expect(maybeEl(statusBarItem, STATUS.saveProgress)).not.toBeNull();

		updateStatusBar(statusBarItem, status);

		expect(maybeEl(statusBarItem, STATUS.saveProgress)).toBeNull();
		expect(statusBarItem.classList.contains('is-saving')).toBe(false);
		expect(statusBarItem.textContent).toContain(text);
	});
});

describe('transcription progress', () => {
	it('shows the transcription and nothing from the other states', () => {
		const { statusBarItem } = transcribing(35);

		expect(statusBarItem.classList.contains('is-transcribing')).toBe(true);
		expect(statusBarItem.classList.contains('is-recording')).toBe(false);
		expect(statusBarItem.classList.contains('is-saving')).toBe(false);
		expect(statusBarItem.textContent).toContain('Transcribing...');
		expect(
			el(statusBarItem, STATUS.saveProgressBar).style.getPropertyValue(
				'--save-progress',
			),
		).toBe('35%');
	});

	it('gives way to a recording that starts under it', () => {
		const { statusBarItem } = transcribing(50);

		updateStatusBar(statusBarItem, RecordingStatus.Recording);

		expect(statusBarItem.classList.contains('is-transcribing')).toBe(false);
		expect(statusBarItem.textContent).toContain('Recording...');
	});

	it('restores the window on a single click', () => {
		const { statusBarItem, onActivate } = transcribing();

		el(statusBarItem, STATUS.actionableProgress).dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it('does not restore the window on a bare double click', () => {
		// A real double click also fires the two clicks that do restore it;
		// handling dblclick as well would restore it twice.
		const { statusBarItem, onActivate } = transcribing();

		el(statusBarItem, STATUS.actionableProgress).dispatchEvent(
			new MouseEvent('dblclick', { bubbles: true }),
		);

		expect(onActivate).not.toHaveBeenCalled();
	});

	it.each([
		{ name: 'Enter', key: 'Enter', restores: true },
		{ name: 'Space', key: ' ', restores: true },
		{ name: 'Tab', key: 'Tab', restores: false },
	])('$name restores the window: $restores', ({ key, restores }) => {
		const { statusBarItem, onActivate } = transcribing();

		el(statusBarItem, STATUS.actionableProgress).dispatchEvent(
			new KeyboardEvent('keydown', { key, bubbles: true }),
		);

		expect(onActivate).toHaveBeenCalledTimes(restores ? 1 : 0);
	});
});

describe('playback controls', () => {
	const TRANSPORT = [
		'Back 10s',
		'Pause playback',
		'Stop playback',
		'Forward 10s',
		'Mute / unmute',
		'Volume',
		'Add marker at current position',
		'Add chapter at current position',
	];

	it.each(TRANSPORT)('offers %s', (label) => {
		const statusBarItem = createStatusBar();

		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		expect(statusBarItem).toHaveControl(label);
	});

	it('marks the status bar as showing playback', () => {
		const statusBarItem = createStatusBar();

		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		expect(statusBarItem.classList.contains('is-playback')).toBe(true);
	});

	it('shows the position against the length', () => {
		const statusBarItem = createStatusBar();

		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		expect(statusBarItem).toShowTime('1:05 / 3:42');
	});

	it('leaves the speed control to the inline player', () => {
		// The status bar is a remote for whatever is playing, not a second
		// copy of the player; speed lives where the waveform is.
		const statusBarItem = createStatusBar();

		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		expect(statusBarItem).not.toHaveControl('Playback speed');
		expect(maybeEl(statusBarItem, PLAYER.speed)).toBeNull();
	});

	it.each([
		{ label: 'Back 10s', command: 'onSkip', args: [-10] },
		{ label: 'Forward 10s', command: 'onSkip', args: [10] },
		{ label: 'Pause playback', command: 'onTogglePlay', args: [] },
		{ label: 'Stop playback', command: 'onStop', args: [] },
		{ label: 'Mute / unmute', command: 'onToggleMute', args: [] },
		{
			label: 'Add marker at current position',
			command: 'onAddMarker',
			args: ['bookmark'],
		},
		{
			label: 'Add chapter at current position',
			command: 'onAddMarker',
			args: ['chapter'],
		},
	] satisfies {
		label: string;
		command: keyof PlaybackControlsState;
		args: unknown[];
	}[])('$label calls $command', ({ label, command, args }) => {
		const statusBarItem = createStatusBar();
		const state = makePlaybackState();
		renderPlaybackStatusBar(statusBarItem, state);

		control(statusBarItem, label).click();

		expect(state[command]).toHaveBeenCalledWith(...args);
	});

	it('reports a dragged volume slider', () => {
		const statusBarItem = createStatusBar();
		const state = makePlaybackState();
		renderPlaybackStatusBar(statusBarItem, state);
		const volume = el<HTMLInputElement>(statusBarItem, PLAYBACK.volume);

		volume.value = '0.4';
		volume.dispatchEvent(new Event('input'));

		expect(state.onVolumeInput).toHaveBeenCalledWith(0.4);
	});

	it.each([
		{ name: 'Enter', key: 'Enter', activates: true },
		{ name: 'Space', key: ' ', activates: true },
		{ name: 'ArrowRight', key: 'ArrowRight', activates: false },
	])('$name activates the transport: $activates', ({ key, activates }) => {
		const statusBarItem = createStatusBar();
		const state = makePlaybackState();
		renderPlaybackStatusBar(statusBarItem, state);

		el(statusBarItem, PLAYBACK.toggle).dispatchEvent(
			new KeyboardEvent('keydown', { key }),
		);

		expect(state.onTogglePlay).toHaveBeenCalledTimes(activates ? 1 : 0);
	});

	it('updates in place rather than rebuilding the controls', () => {
		// Rebuilding would drop focus and interrupt a volume drag on every
		// timeupdate, which fires several times a second.
		const statusBarItem = createStatusBar();
		renderPlaybackStatusBar(statusBarItem, makePlaybackState());
		const controls = el(statusBarItem, PLAYBACK.controls);

		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		expect(el(statusBarItem, PLAYBACK.controls)).toBe(controls);
	});

	it('reflects a paused, muted, marker-less state on the controls it kept', () => {
		const statusBarItem = createStatusBar();
		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		renderPlaybackStatusBar(
			statusBarItem,
			makePlaybackState({
				currentTime: 5,
				duration: 0,
				paused: true,
				muted: true,
				volume: 0.2,
				markersEnabled: false,
			}),
		);

		expect(statusBarItem).toHaveControl('Play audio');
		expect(
			el(statusBarItem, PLAYBACK.mute).classList.contains('is-active'),
		).toBe(true);
		expect(el<HTMLInputElement>(statusBarItem, PLAYBACK.volume).value).toBe(
			'0.2',
		);
		expect(el(statusBarItem, PLAYBACK.markerControls).hidden).toBe(true);
		expect(statusBarItem).toShowTime('0:05 / 0:00');
	});

	it('leaves a focused volume slider where the user put it', () => {
		const statusBarItem = createStatusBar();
		document.body.appendChild(statusBarItem);
		renderPlaybackStatusBar(statusBarItem, makePlaybackState());
		const volume = el<HTMLInputElement>(statusBarItem, PLAYBACK.volume);
		volume.value = '0.3';
		volume.focus();

		renderPlaybackStatusBar(
			statusBarItem,
			makePlaybackState({ volume: 0.9 }),
		);

		expect(volume.value).toBe('0.3');
		statusBarItem.remove();
	});

	it('survives an external refresh that removed its controls', () => {
		// Another plugin, or Obsidian itself, can empty the status bar between
		// two timeupdates; the next render must rebuild rather than throw.
		const statusBarItem = createStatusBar();
		renderPlaybackStatusBar(statusBarItem, makePlaybackState());
		const controls = el(statusBarItem, PLAYBACK.controls);
		for (const part of [
			PLAYBACK.toggle,
			PLAYBACK.mute,
			PLAYBACK.volume,
			PLAYBACK.markerControls,
			PLAYBACK.time,
		]) {
			el(controls, part).remove();
		}

		expect(() => {
			renderPlaybackStatusBar(statusBarItem, makePlaybackState());
		}).not.toThrow();
	});

	it('gives way to a recording that starts under it', () => {
		const statusBarItem = createStatusBar();
		renderPlaybackStatusBar(statusBarItem, makePlaybackState());

		updateStatusBar(statusBarItem, RecordingStatus.Recording);

		expect(maybeEl(statusBarItem, PLAYBACK.controls)).toBeNull();
		expect(statusBarItem.classList.contains('is-playback')).toBe(false);
		expect(statusBarItem.textContent).toContain('Recording...');
	});
});

describe('recording controls', () => {
	it.each([
		{
			name: 'recording',
			paused: false,
			label: 'Recording...',
			first: 'Pause recording',
		},
		{
			name: 'paused',
			paused: true,
			label: 'Recording paused',
			first: 'Resume recording',
		},
	])('offers $first while $name', ({ paused, label, first }) => {
		const { statusBarItem } = recordingWithControls(paused);

		expect(el(statusBarItem, STATUS.recordingLabel).textContent).toBe(
			label,
		);
		expect(statusBarItem).toHaveControl(first);
		expect(statusBarItem).toHaveControl('Stop recording');
	});

	it('groups the buttons in their own container', () => {
		const { statusBarItem } = recordingWithControls();

		expect(maybeEl(statusBarItem, STATUS.recordingControls)).not.toBeNull();
		expect(maybeEl(statusBarItem, STATUS.recordingButtons)).not.toBeNull();
		expect(allEls(statusBarItem, PLAYER.controlButton)).toHaveLength(2);
	});

	it.each([
		{ label: 'Pause recording', command: 'onPauseResume' },
		{ label: 'Stop recording', command: 'onStop' },
	] satisfies { label: string; command: keyof RecordingControls }[])(
		'$label calls $command',
		({ label, command }) => {
			const { statusBarItem, controls } = recordingWithControls();

			control(statusBarItem, label).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);

			expect(controls[command]).toHaveBeenCalledTimes(1);
		},
	);

	it('keeps a button click from reaching the status bar behind it', () => {
		// The status bar itself is clickable in Obsidian; without this a stop
		// would also trigger whatever the bar does on click.
		const { statusBarItem } = recordingWithControls();
		const event = new MouseEvent('click', { bubbles: true });
		const stopPropagation = jest.spyOn(event, 'stopPropagation');

		control(statusBarItem, 'Pause recording').dispatchEvent(event);

		expect(stopPropagation).toHaveBeenCalled();
	});

	it('makes every button reachable by keyboard', () => {
		const { statusBarItem } = recordingWithControls();

		for (const button of allEls(statusBarItem, PLAYER.controlButton)) {
			expect(button.getAttribute('role')).toBe('button');
			expect(button.getAttribute('tabindex')).toBe('0');
			expect(button.getAttribute('aria-label')).toBeTruthy();
		}
	});

	it('shows the label but no buttons when no commands were given', () => {
		const statusBarItem = createStatusBar();

		updateStatusBar(statusBarItem, RecordingStatus.Recording);

		expect(allEls(statusBarItem, PLAYER.controlButton)).toHaveLength(0);
		expect(el(statusBarItem, STATUS.recordingLabel).textContent).toBe(
			'Recording...',
		);
	});

	it.each([
		{ name: 'idle', status: RecordingStatus.Idle, progress: undefined },
		{
			name: 'saving',
			status: RecordingStatus.Saving,
			progress: { percent: 10, description: 'Saving...' },
		},
	])(
		'drops the buttons when the recording goes $name',
		({ status, progress }) => {
			const { statusBarItem } = recordingWithControls();
			expect(allEls(statusBarItem, PLAYER.controlButton)).toHaveLength(2);

			updateStatusBar(statusBarItem, status, progress);

			expect(allEls(statusBarItem, PLAYER.controlButton)).toHaveLength(0);
		},
	);

	it('orders the buttons pause first, stop second', () => {
		const { statusBarItem } = recordingWithControls();

		const labels = allEls(statusBarItem, PLAYER.controlButton).map(
			(button) => button.getAttribute('aria-label'),
		);

		expect(at(labels, 0)).toBe('Pause recording');
		expect(at(labels, 1)).toBe('Stop recording');
	});
});

describe('live recording indicators', () => {
	/** A status bar recording with the given live indicators switched on. */
	function recordingWithLive(options: {
		showStats: boolean;
		showMeter: boolean;
	}): HTMLElement {
		const statusBarItem = createStatusBar();
		updateStatusBar(
			statusBarItem,
			RecordingStatus.Recording,
			undefined,
			recordingControls(),
			options,
		);
		return statusBarItem;
	}

	it('offers a marker button only when dropping markers is possible', () => {
		const statusBarItem = createStatusBar();
		const onAddMarker = jest.fn();

		updateStatusBar(statusBarItem, RecordingStatus.Recording, undefined, {
			...recordingControls(),
			onAddMarker,
		});

		expect(statusBarItem).toHaveControl('Add marker');
		control(statusBarItem, 'Add marker').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);
		expect(onAddMarker).toHaveBeenCalledTimes(1);
	});

	it('offers no marker button when the recording cannot take one', () => {
		const { statusBarItem } = recordingWithControls();

		expect(statusBarItem).not.toHaveControl('Add marker');
	});

	it('starts the elapsed time and size at zero', () => {
		const statusBarItem = recordingWithLive({
			showStats: true,
			showMeter: false,
		});

		expect(el(statusBarItem, STATUS.elapsed).textContent).toBe('0:00');
		expect(el(statusBarItem, STATUS.recordedSize).textContent).toBe('0 B');
		expect(maybeEl(statusBarItem, STATUS.inputMeter)).toBeNull();
	});

	it('draws the input meter on its own', () => {
		const statusBarItem = recordingWithLive({
			showStats: false,
			showMeter: true,
		});

		expect(maybeEl(statusBarItem, STATUS.inputMeterFill)).not.toBeNull();
		expect(maybeEl(statusBarItem, STATUS.elapsed)).toBeNull();
	});

	it('draws nothing live when neither indicator is asked for', () => {
		const statusBarItem = recordingWithLive({
			showStats: false,
			showMeter: false,
		});

		expect(maybeEl(statusBarItem, STATUS.live)).toBeNull();
	});

	it('updates the indicators in place', () => {
		// They tick several times a second; re-rendering would drop focus and
		// restart the CSS transition on the meter every time.
		const statusBarItem = recordingWithLive({
			showStats: true,
			showMeter: true,
		});
		const live = el(statusBarItem, STATUS.live);

		updateRecordingLiveStats(statusBarItem, {
			elapsedMs: 65_000,
			bytes: 2048,
			level: 0.5,
		});

		expect(el(statusBarItem, STATUS.live)).toBe(live);
		expect(el(statusBarItem, STATUS.elapsed).textContent).toBe('1:05');
		expect(el(statusBarItem, STATUS.recordedSize).textContent).toBe(
			'2.0 KB',
		);
		expect(
			el(statusBarItem, STATUS.inputMeterFill).style.getPropertyValue(
				'--aar-meter-fill',
			),
		).toBe('50%');
	});

	it.each([
		{
			name: 'the meter is off',
			options: { showStats: true, showMeter: false },
			present: STATUS.elapsed,
			absent: STATUS.inputMeterFill,
		},
		{
			name: 'the stats are off',
			options: { showStats: false, showMeter: true },
			present: STATUS.inputMeterFill,
			absent: STATUS.elapsed,
		},
	])('updates what is there when $name', ({ options, present, absent }) => {
		// Both indicators are settings-controlled and independent, so the
		// update has to cope with either half missing.
		const statusBarItem = recordingWithLive(options);

		expect(() => {
			updateRecordingLiveStats(statusBarItem, {
				elapsedMs: 1000,
				bytes: 1,
				level: 1,
			});
		}).not.toThrow();
		expect(maybeEl(statusBarItem, present)).not.toBeNull();
		expect(maybeEl(statusBarItem, absent)).toBeNull();
	});

	it('does nothing when the status bar is not showing a recording', () => {
		const statusBarItem = createStatusBar();
		updateStatusBar(statusBarItem, RecordingStatus.Idle);

		updateRecordingLiveStats(statusBarItem, {
			elapsedMs: 1000,
			bytes: 1,
			level: 1,
		});

		expect(statusBarItem.textContent).toBe('');
	});
});
