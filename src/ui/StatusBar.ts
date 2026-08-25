/**
 * Status bar component for displaying recording status and controls.
 * @module ui/StatusBar
 */

import { setIcon } from 'obsidian';
import {
	PLAYER_ICONS,
	PLAYER_SKIP_SECONDS,
	PLAYER_VOLUME_SLIDER_STEP,
} from '../constants';
import { MARKER_KIND } from '../markers/markerModel';
import type { PlaybackControlsState } from '../player/playbackControls';
import { RecordingStatus } from '../types';
import type { SaveProgress, RecordingControls } from '../types';
import { formatTimecode } from '../utils/TimeUtils';
import { formatByteSize } from '../utils/formatBytes';

/** Latest command snapshot used by the persistent playback controls DOM. */
const playbackStates = new WeakMap<HTMLElement, PlaybackControlsState>();

/**
 * Class names of the persistent playback controls. Each is referenced both
 * where the element is built and where it is updated or queried, so a single
 * source of truth keeps the two in sync (a typo becomes a compile error).
 */
const PLAYBACK_CONTROLS_CLASS = 'aar-playback-controls';
const PLAYBACK_TOGGLE_CLASS = 'aar-playback-toggle';
const PLAYBACK_MUTE_CLASS = 'aar-playback-mute';
const PLAYBACK_VOLUME_CLASS = 'aar-playback-volume';
const PLAYBACK_MARKER_CONTROLS_CLASS = 'aar-playback-marker-controls';
const PLAYBACK_TIME_CLASS = 'aar-playback-time';

/** Which live indicators to render in the recording state. */
export interface RecordingLiveOptions {
	/** Show elapsed time and recorded size. */
	showStats: boolean;
	/** Show the input-level meter. */
	showMeter: boolean;
}

/** Live values pushed to the recording status bar on a timer. */
export interface RecordingLiveStats {
	/** Elapsed active recording time in milliseconds. */
	elapsedMs: number;
	/** Recorded bytes so far. */
	bytes: number;
	/** Input level as a 0..1 fraction. */
	level: number;
}

/**
 * Options for an interactive background progress indicator.
 */
export type BackgroundProgressOptions = {
	/** Restores the hidden UI associated with the background task. */
	onActivate: () => void;
	/** Accessible label for the restore action. */
	activationLabel: string;
};

/**
 * Updates the status bar element based on recording status.
 * Uses Obsidian's extended HTMLElement methods.
 * @param statusBarItem - The status bar HTML element
 * @param status - Current recording status
 * @param saveProgress - Optional save progress info for Saving state
 * @param controls - Optional recording control callbacks for interactive buttons
 */
export function updateStatusBar(
	statusBarItem: HTMLElement | null,
	status: RecordingStatus,
	saveProgress?: SaveProgress,
	controls?: RecordingControls,
	liveOptions?: RecordingLiveOptions,
): void {
	if (!statusBarItem) {
		return;
	}

	switch (status) {
		case RecordingStatus.Recording:
			renderRecordingState(
				statusBarItem,
				'Recording...',
				controls,
				liveOptions,
			);
			break;
		case RecordingStatus.Paused:
			renderRecordingState(
				statusBarItem,
				'Recording paused',
				controls,
				liveOptions,
			);
			break;
		case RecordingStatus.Interrupted:
			// The same progress surface as an ordinary save, because that is
			// what is happening, under a label that says why: the user did not
			// press stop, and a bare "Saving..." would leave them to work that
			// out from a Notice that has already gone.
			renderProgressState(
				statusBarItem,
				saveProgress,
				'is-saving',
				'Input lost, saving...',
			);
			break;
		case RecordingStatus.Saving:
			renderSavingState(statusBarItem, saveProgress);
			break;
		case RecordingStatus.Idle:
		default:
			renderIdleState(statusBarItem);
			break;
	}
}

/**
 * Renders the recording or paused state with control buttons.
 * @param el - The status bar HTML element
 * @param label - Display text for the current state
 * @param controls - Optional recording control callbacks
 */
function renderRecordingState(
	el: HTMLElement,
	label: string,
	controls?: RecordingControls,
	liveOptions?: RecordingLiveOptions,
): void {
	el.empty();
	playbackStates.delete(el);
	el.classList.add('is-recording');
	el.classList.remove('is-saving');
	el.classList.remove('is-transcribing');
	el.classList.remove('is-playback');

	const container = el.createDiv({ cls: 'aar-recording-controls' });
	const text = container.createSpan({ cls: 'aar-recording-label' });
	text.textContent = label;

	if (controls) {
		const buttons = container.createSpan({
			cls: 'aar-recording-buttons',
		});
		if (controls.onAddMarker) {
			createControlButton(
				buttons,
				'bookmark',
				'Add marker',
				controls.onAddMarker,
			);
		}
		createControlButton(
			buttons,
			controls.isPaused ? 'play' : 'pause',
			controls.isPaused ? 'Resume recording' : 'Pause recording',
			controls.onPauseResume,
		);
		createControlButton(
			buttons,
			'square',
			'Stop recording',
			controls.onStop,
		);
	}

	if (liveOptions?.showStats || liveOptions?.showMeter) {
		const live = container.createSpan({ cls: 'aar-recording-live' });
		if (liveOptions.showStats) {
			live.createSpan({ cls: 'aar-recording-time', text: '0:00' });
			live.createSpan({ cls: 'aar-recording-size', text: '0 B' });
		}
		if (liveOptions.showMeter) {
			const meter = live.createSpan({ cls: 'aar-input-meter' });
			meter.createSpan({ cls: 'aar-input-meter-fill' });
		}
	}
}

/**
 * Updates the live recording indicators (elapsed time, recorded size,
 * input level) in place, without re-rendering the status bar. No-op when
 * the recording state is not currently shown.
 * @param statusBarItem - The status bar element
 * @param stats - Live values to display
 */
export function updateRecordingLiveStats(
	statusBarItem: HTMLElement | null,
	stats: RecordingLiveStats,
): void {
	const live = statusBarItem?.querySelector('.aar-recording-live');
	if (!live) {
		return;
	}
	const time = live.querySelector('.aar-recording-time');
	if (time) {
		time.textContent = formatTimecode(stats.elapsedMs / 1000);
	}
	const size = live.querySelector('.aar-recording-size');
	if (size) {
		size.textContent = formatByteSize(stats.bytes);
	}
	const fill = live.querySelector<HTMLElement>('.aar-input-meter-fill');
	if (fill) {
		fill.setCssProps({
			'--aar-meter-fill': `${String(meterPercent(stats.level))}%`,
		});
	}
}

/**
 * Turns a level reading into a percentage the meter can actually paint.
 *
 * The reading crosses a module boundary from an analyser, and an analyser
 * whose context closed under it - a device unplugged mid-recording - fills its
 * buffer with values that carry NaN through the RMS maths. Painting `NaN%`
 * leaves the meter blank with no explanation, and anything above 100% spills
 * the fill out of its track.
 * @param level - Input level, nominally 0..1
 * @returns A whole percentage in 0..100
 */
function meterPercent(level: number): number {
	if (!Number.isFinite(level)) {
		return 0;
	}
	return Math.round(Math.min(1, Math.max(0, level)) * 100);
}

/**
 * Creates a clickable control button with an icon in the status bar.
 * @param parent - Parent element to append the button to
 * @param icon - Obsidian icon name
 * @param ariaLabel - Accessible label for the button
 * @param onClick - Click handler
 * @returns The created keyboard-operable control
 */
function createControlButton(
	parent: HTMLElement,
	icon: string,
	ariaLabel: string,
	onClick: () => void,
): HTMLElement {
	const button = parent.createSpan({ cls: 'aar-control-btn' });
	button.setAttribute('aria-label', ariaLabel);
	button.setAttribute('role', 'button');
	button.tabIndex = 0;
	setIcon(button, icon);
	button.addEventListener('click', (e: MouseEvent) => {
		e.stopPropagation();
		onClick();
	});
	button.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});
	return button;
}

/**
 * Renders or updates the controls for the active audio playback. The DOM is
 * retained across timeupdate events so focus and volume dragging stay stable.
 * @param statusBarItem - The shared status bar element
 * @param state - Current playback state and commands
 */
export function renderPlaybackStatusBar(
	statusBarItem: HTMLElement | null,
	state: PlaybackControlsState,
): void {
	if (!statusBarItem) {
		return;
	}
	playbackStates.set(statusBarItem, state);
	statusBarItem.classList.remove('is-recording');
	statusBarItem.classList.remove('is-saving');
	statusBarItem.classList.remove('is-transcribing');
	statusBarItem.classList.add('is-playback');

	let container = statusBarItem.querySelector<HTMLElement>(
		`.${PLAYBACK_CONTROLS_CLASS}`,
	);
	if (!container) {
		statusBarItem.empty();
		container = buildPlaybackControls(statusBarItem);
	}
	updatePlaybackControls(container, state);
}

/**
 * Builds the persistent status-bar playback control surface.
 * @param statusBarItem - Status bar element that owns the controls
 * @returns The mounted playback controls container
 */
function buildPlaybackControls(statusBarItem: HTMLElement): HTMLElement {
	const container = statusBarItem.createDiv({
		cls: PLAYBACK_CONTROLS_CLASS,
	});
	const transport = container.createSpan({ cls: 'aar-playback-buttons' });
	createControlButton(
		transport,
		PLAYER_ICONS.skipBack,
		`Back ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			playbackStates.get(statusBarItem)?.onSkip(-PLAYER_SKIP_SECONDS);
		},
	);
	createControlButton(transport, PLAYER_ICONS.pause, 'Pause playback', () => {
		playbackStates.get(statusBarItem)?.onTogglePlay();
	}).addClass(PLAYBACK_TOGGLE_CLASS);
	createControlButton(transport, PLAYER_ICONS.stop, 'Stop playback', () => {
		playbackStates.get(statusBarItem)?.onStop();
	});
	createControlButton(
		transport,
		PLAYER_ICONS.skipForward,
		`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			playbackStates.get(statusBarItem)?.onSkip(PLAYER_SKIP_SECONDS);
		},
	);

	const audioControls = container.createSpan({
		cls: 'aar-playback-audio-controls',
	});
	createControlButton(
		audioControls,
		PLAYER_ICONS.volume,
		'Mute / unmute',
		() => {
			playbackStates.get(statusBarItem)?.onToggleMute();
		},
	).addClass(PLAYBACK_MUTE_CLASS);
	const volume = audioControls.createEl('input', {
		cls: PLAYBACK_VOLUME_CLASS,
		attr: {
			type: 'range',
			min: '0',
			max: '1',
			step: String(PLAYER_VOLUME_SLIDER_STEP),
			value: '1',
			'aria-label': 'Volume',
		},
	});
	volume.addEventListener('input', () => {
		playbackStates.get(statusBarItem)?.onVolumeInput(Number(volume.value));
	});

	const markerControls = container.createSpan({
		cls: PLAYBACK_MARKER_CONTROLS_CLASS,
	});
	createControlButton(
		markerControls,
		PLAYER_ICONS.addBookmark,
		'Add marker at current position',
		() => {
			playbackStates
				.get(statusBarItem)
				?.onAddMarker(MARKER_KIND.bookmark);
		},
	);
	createControlButton(
		markerControls,
		PLAYER_ICONS.addChapter,
		'Add chapter at current position',
		() => {
			playbackStates.get(statusBarItem)?.onAddMarker(MARKER_KIND.chapter);
		},
	);

	container.createSpan({
		cls: PLAYBACK_TIME_CLASS,
		text: `${formatTimecode(0, 0)} / ${formatTimecode(0, 0)}`,
	});
	return container;
}

/**
 * Applies a playback snapshot without replacing the controls DOM.
 * @param container - Mounted playback controls container
 * @param state - Latest active playback snapshot
 */
function updatePlaybackControls(
	container: HTMLElement,
	state: PlaybackControlsState,
): void {
	const toggle = container.querySelector<HTMLElement>(
		`.${PLAYBACK_TOGGLE_CLASS}`,
	);
	if (toggle) {
		setIcon(toggle, state.paused ? PLAYER_ICONS.play : PLAYER_ICONS.pause);
		toggle.setAttribute(
			'aria-label',
			state.paused ? 'Play audio' : 'Pause playback',
		);
	}

	const mute = container.querySelector<HTMLElement>(
		`.${PLAYBACK_MUTE_CLASS}`,
	);
	if (mute) {
		setIcon(mute, state.muted ? PLAYER_ICONS.muted : PLAYER_ICONS.volume);
		mute.toggleClass('is-active', state.muted);
		mute.setAttribute('aria-pressed', String(state.muted));
	}

	const volume = container.querySelector<HTMLInputElement>(
		`.${PLAYBACK_VOLUME_CLASS}`,
	);
	if (volume && activeDocument.activeElement !== volume) {
		volume.value = String(state.volume);
	}

	const markerControls = container.querySelector<HTMLElement>(
		`.${PLAYBACK_MARKER_CONTROLS_CLASS}`,
	);
	if (markerControls) {
		markerControls.hidden = !state.markersEnabled;
	}

	const total = state.duration > 0 ? state.duration : 0;
	const time = container.querySelector<HTMLElement>(
		`.${PLAYBACK_TIME_CLASS}`,
	);
	time?.setText(
		`${formatTimecode(state.currentTime, total)} / ${formatTimecode(total, total)}`,
	);
}

/**
 * Renders the saving state with progress bar.
 * @param el - The status bar HTML element
 * @param saveProgress - Optional save progress info
 */
function renderSavingState(el: HTMLElement, saveProgress?: SaveProgress): void {
	renderProgressState(el, saveProgress, 'is-saving', 'Saving...');
}

/**
 * Renders a minimized transcription job in the status bar. Clicking the
 * progress surface or focusing it and pressing Enter/Space restores the
 * transcription modal.
 * @param statusBarItem - The status bar HTML element
 * @param progress - Current transcription progress
 * @param options - Restore action metadata
 */
export function renderTranscriptionStatusBar(
	statusBarItem: HTMLElement | null,
	progress: SaveProgress,
	options: BackgroundProgressOptions,
): void {
	if (!statusBarItem) {
		return;
	}
	renderProgressState(
		statusBarItem,
		progress,
		'is-transcribing',
		'Transcribing...',
		options,
	);
}

/**
 * Renders a compact progress indicator in the status bar.
 * @param el - The status bar HTML element
 * @param progress - Optional progress info
 * @param stateClass - CSS class for the active state
 * @param defaultDescription - Fallback text
 * @param options - Optional restore action metadata
 */
function renderProgressState(
	el: HTMLElement,
	progress: SaveProgress | undefined,
	stateClass: 'is-saving' | 'is-transcribing',
	defaultDescription: string,
	options?: BackgroundProgressOptions,
): void {
	el.empty();
	playbackStates.delete(el);
	el.classList.remove('is-recording');
	el.classList.remove('is-saving');
	el.classList.remove('is-transcribing');
	el.classList.remove('is-playback');
	el.classList.add(stateClass);

	const wrapper = el.createDiv({
		cls: options
			? 'aar-status-progress-content aar-status-progress-actionable'
			: 'aar-status-progress-content',
	});
	if (options) {
		wrapper.setAttribute('role', 'button');
		wrapper.setAttribute('aria-label', options.activationLabel);
		wrapper.tabIndex = 0;
		// Single click matches the sibling recording controls and the
		// role="button" semantics; stop propagation so the surrounding status
		// bar item does not also react.
		wrapper.addEventListener('click', (event: MouseEvent) => {
			event.stopPropagation();
			options.onActivate();
		});
		wrapper.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}
			event.preventDefault();
			options.onActivate();
		});
	}

	const text = wrapper.createSpan();
	text.textContent = progress?.description ?? defaultDescription;

	const progressContainer = wrapper.createDiv({
		cls: 'aar-save-progress',
	});
	const progressBar = progressContainer.createDiv({
		cls: 'aar-save-progress-bar',
	});
	progressBar.setCssProps({
		'--save-progress': `${String(savePercent(progress?.percent))}%`,
	});
}

/**
 * Clamps a save percentage into something the bar can paint.
 *
 * The number is bytes written over bytes expected, both read off a save in
 * flight: before the first chunk lands that division is NaN, and a final flush
 * that writes more than it announced overshoots 100. The stylesheet takes the
 * value straight into a width, so neither may reach it.
 * @param percent - Reported percentage, or undefined before any was reported
 * @returns A whole percentage in 0..100
 */
function savePercent(percent: number | undefined): number {
	if (percent === undefined || !Number.isFinite(percent)) {
		return 0;
	}
	return Math.round(Math.min(100, Math.max(0, percent)));
}

/**
 * Renders the idle state (empty status bar).
 * @param el - The status bar HTML element
 */
function renderIdleState(el: HTMLElement): void {
	el.empty();
	playbackStates.delete(el);
	el.textContent = '';
	el.classList.remove('is-recording');
	el.classList.remove('is-saving');
	el.classList.remove('is-transcribing');
	el.classList.remove('is-playback');
}

/**
 * Creates the initial status bar state.
 * @param statusBarItem - The status bar HTML element
 */
export function initializeStatusBar(statusBarItem: HTMLElement | null): void {
	updateStatusBar(statusBarItem, RecordingStatus.Idle);
}
