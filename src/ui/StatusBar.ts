/**
 * Status bar component for displaying recording status and controls.
 * @module ui/StatusBar
 */

import { setIcon } from 'obsidian';
import { PLAYER_SKIP_SECONDS } from '../constants';
import { MARKER_KIND } from '../markers/markerModel';
import type { PlaybackControlsState } from '../player/playbackControls';
import { RecordingStatus } from '../types';
import type { SaveProgress, RecordingControls } from '../types';
import { formatTimecode } from '../utils/TimeUtils';
import { formatByteSize } from '../utils/formatBytes';

/** Latest command snapshot used by the persistent playback controls DOM. */
const playbackStates = new WeakMap<HTMLElement, PlaybackControlsState>();

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
			'--aar-meter-fill': `${String(Math.round(stats.level * 100))}%`,
		});
	}
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
		'.aar-playback-controls',
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
		cls: 'aar-playback-controls',
	});
	const transport = container.createSpan({ cls: 'aar-playback-buttons' });
	createControlButton(
		transport,
		'rewind',
		`Back ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			playbackStates.get(statusBarItem)?.onSkip(-PLAYER_SKIP_SECONDS);
		},
	);
	createControlButton(transport, 'pause', 'Pause playback', () => {
		playbackStates.get(statusBarItem)?.onTogglePlay();
	}).addClass('aar-playback-toggle');
	createControlButton(transport, 'square', 'Stop playback', () => {
		playbackStates.get(statusBarItem)?.onStop();
	});
	createControlButton(
		transport,
		'fast-forward',
		`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			playbackStates.get(statusBarItem)?.onSkip(PLAYER_SKIP_SECONDS);
		},
	);

	const audioControls = container.createSpan({
		cls: 'aar-playback-audio-controls',
	});
	createControlButton(audioControls, 'volume-2', 'Mute / unmute', () => {
		playbackStates.get(statusBarItem)?.onToggleMute();
	}).addClass('aar-playback-mute');
	const volume = audioControls.createEl('input', {
		cls: 'aar-playback-volume',
		attr: {
			type: 'range',
			min: '0',
			max: '1',
			step: '0.05',
			value: '1',
			'aria-label': 'Volume',
		},
	});
	volume.addEventListener('input', () => {
		playbackStates.get(statusBarItem)?.onVolumeInput(Number(volume.value));
	});

	const markerControls = container.createSpan({
		cls: 'aar-playback-marker-controls',
	});
	createControlButton(
		markerControls,
		'bookmark-plus',
		'Add marker at current position',
		() => {
			playbackStates
				.get(statusBarItem)
				?.onAddMarker(MARKER_KIND.bookmark);
		},
	);
	createControlButton(
		markerControls,
		'list-plus',
		'Add chapter at current position',
		() => {
			playbackStates.get(statusBarItem)?.onAddMarker(MARKER_KIND.chapter);
		},
	);

	container.createSpan({
		cls: 'aar-playback-time',
		text: '0:00 / 0:00',
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
	const toggle = container.querySelector<HTMLElement>('.aar-playback-toggle');
	if (toggle) {
		setIcon(toggle, state.paused ? 'play' : 'pause');
		toggle.setAttribute(
			'aria-label',
			state.paused ? 'Play audio' : 'Pause playback',
		);
	}

	const mute = container.querySelector<HTMLElement>('.aar-playback-mute');
	if (mute) {
		setIcon(mute, state.muted ? 'volume-x' : 'volume-2');
		mute.toggleClass('is-active', state.muted);
		mute.setAttribute('aria-pressed', String(state.muted));
	}

	const volume = container.querySelector<HTMLInputElement>(
		'.aar-playback-volume',
	);
	if (volume && activeDocument.activeElement !== volume) {
		volume.value = String(state.volume);
	}

	const markerControls = container.querySelector<HTMLElement>(
		'.aar-playback-marker-controls',
	);
	if (markerControls) {
		markerControls.hidden = !state.markersEnabled;
	}

	const total = state.duration > 0 ? state.duration : 0;
	const time = container.querySelector<HTMLElement>('.aar-playback-time');
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
	const percent = progress?.percent ?? 0;
	progressBar.setCssProps({
		'--save-progress': `${String(percent)}%`,
	});
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
