/**
 * Status bar component for displaying recording status and controls.
 * @module ui/StatusBar
 */

import { setIcon, setTooltip } from 'obsidian';
import { PLAYER_ICONS, PLAYER_SKIP_SECONDS } from '../constants';
import { MARKER_KIND } from '../markers/markerModel';
import type { PlaybackControlsState } from '../player/playbackControls';
import { RecordingStatus } from '../types';
import type { SaveProgress, RecordingControls } from '../types';
import { formatTimecode } from '../utils/TimeUtils';
import { formatByteSize } from '../utils/formatBytes';
import { createProgressBar, type ProgressBar } from './progressBar';
import { createVolumeSlider, type VolumeSlider } from './volumeSlider';

/**
 * Where a status-bar tooltip opens. The bar sits on the bottom edge of the
 * window, so Obsidian's default placement below the control would open
 * off-screen; the app's own status-bar items open theirs above.
 */
const STATUS_BAR_TOOLTIP = { placement: 'top' } as const;

/** Latest command snapshot used by the persistent playback controls DOM. */
const playbackStates = new WeakMap<HTMLElement, PlaybackControlsState>();

/** The slider behind each mounted volume input, found again on update. */
const volumeSliders = new WeakMap<Element, VolumeSlider>();

/**
 * Class names of the persistent playback controls. Each is referenced both
 * where the element is built and where it is updated or queried, so a single
 * source of truth keeps the two in sync (a typo becomes a compile error).
 */
const PLAYBACK_CONTROLS_CLASS = 'aar-playback-controls';
const PLAYBACK_TOGGLE_CLASS = 'aar-playback-toggle';
const PLAYBACK_SKIP_BACK_CLASS = 'aar-playback-skip-back';
const PLAYBACK_SKIP_FORWARD_CLASS = 'aar-playback-skip-forward';
const PLAYBACK_MUTE_CLASS = 'aar-playback-mute';
const PLAYBACK_VOLUME_CLASS = 'aar-playback-volume';
const PLAYBACK_MARKER_CONTROLS_CLASS = 'aar-playback-marker-controls';
const PLAYBACK_CHAPTER_CONTROLS_CLASS = 'aar-playback-chapter-controls';
const PLAYBACK_CHAPTER_LOOP_CLASS = 'aar-playback-chapter-loop';
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
 * Why a save nobody asked for is running, shown for as long as it runs.
 *
 * Written once because it appears twice: before the finalizer has reported
 * anything, and in front of every line it reports after that.
 */
const INTERRUPTED_REASON = 'Input lost';

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
				recordingButtons(controls),
				liveOptions,
			);
			break;
		case RecordingStatus.Paused:
			renderRecordingState(
				statusBarItem,
				'Recording paused',
				recordingButtons(controls),
				liveOptions,
			);
			break;
		case RecordingStatus.Interrupted:
			// The same progress surface as an ordinary save, because that is
			// what is happening, under a label that keeps saying why: the user
			// did not press stop, and a bare "Saving..." would leave them to
			// work that out from a Notice that has already gone. The reason
			// stays in front of whatever the finalizer reports rather than
			// being replaced by its first line, because it holds for as long
			// as the save does.
			renderProgressState(
				statusBarItem,
				saveProgress && {
					...saveProgress,
					description: `${INTERRUPTED_REASON}: ${saveProgress.description}`,
				},
				'is-saving',
				`${INTERRUPTED_REASON}, saving...`,
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

/** One button of the controls a capture shows beside its label. */
interface ControlButtonSpec {
	/** Obsidian icon name. */
	readonly icon: string;
	/** Accessible label. */
	readonly label: string;
	readonly onClick: () => void;
}

/**
 * The buttons a recording session shows: a marker when markers are on, pause
 * or resume, and stop.
 * @param controls - The session's control callbacks, when it has any
 * @returns The buttons, in the order they are shown
 */
function recordingButtons(controls?: RecordingControls): ControlButtonSpec[] {
	if (!controls) {
		return [];
	}
	return [
		...(controls.onAddMarker
			? [
					{
						icon: 'bookmark',
						label: 'Add marker',
						onClick: controls.onAddMarker,
					},
				]
			: []),
		{
			icon: controls.isPaused ? 'play' : 'pause',
			label: controls.isPaused ? 'Resume recording' : 'Pause recording',
			onClick: controls.onPauseResume,
		},
		{ icon: 'square', label: 'Stop recording', onClick: controls.onStop },
	];
}

/**
 * Renders a capture that is running: its label, its control buttons, and the
 * live indicators. A recording session and a quick note show the same
 * surface, so the one a user already knows says what either is doing.
 * @param el - The status bar HTML element
 * @param label - Display text for the current state
 * @param buttons - The control buttons, in order
 * @param liveOptions - Which live indicators to show
 */
function renderRecordingState(
	el: HTMLElement,
	label: string,
	buttons: readonly ControlButtonSpec[],
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

	if (buttons.length > 0) {
		const buttonsEl = container.createSpan({
			cls: 'aar-recording-buttons',
		});
		for (const button of buttons) {
			createControlButton(
				buttonsEl,
				button.icon,
				button.label,
				button.onClick,
			);
		}
	}

	if (liveOptions?.showStats || liveOptions?.showMeter) {
		const live = container.createSpan({ cls: 'aar-recording-live' });
		if (liveOptions.showStats) {
			live.createSpan({ cls: 'aar-recording-time', text: '0:00' });
			live.createSpan({ cls: 'aar-recording-size', text: '0 B' });
		}
		if (liveOptions.showMeter) {
			// A meter rather than a picture of one: a screen reader can read
			// the level on request, and it is not a live region, so the five
			// readings a second are not announced on their own.
			const meter = live.createSpan({
				cls: 'aar-input-meter',
				attr: {
					role: 'meter',
					'aria-label': 'Input level',
					'aria-valuemin': '0',
					'aria-valuemax': '100',
					'aria-valuenow': '0',
				},
			});
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
	const meter = live.querySelector<HTMLElement>('.aar-input-meter');
	const fill = meter?.querySelector<HTMLElement>('.aar-input-meter-fill');
	if (meter && fill) {
		const percent = String(meterPercent(stats.level));
		fill.setCssProps({ '--aar-meter-fill': `${percent}%` });
		meter.setAttribute('aria-valuenow', percent);
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
 * Creates an icon button in the status bar.
 *
 * A native button in Obsidian's icon-button class: the platform makes it
 * focusable and activates it from Enter and Space, and the class gives it the
 * app's hover, press, engaged state and focus ring. The accessible name is set
 * through setTooltip, which is also what shows it on hover.
 * @param parent - Parent element to append the button to
 * @param icon - Obsidian icon name
 * @param label - Accessible name and tooltip
 * @param onClick - Click handler, which a key press reaches as well
 * @returns The created button
 */
function createControlButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: () => void,
): HTMLButtonElement {
	const button = parent.createEl('button', {
		cls: 'clickable-icon aar-control-btn',
		attr: { type: 'button' },
	});
	setIcon(button, icon);
	setTooltip(button, label, STATUS_BAR_TOOLTIP);
	// The status bar item is clickable in Obsidian, and it must not also
	// react to a press on one of its controls.
	button.addEventListener('click', (event: MouseEvent) => {
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
	// The label is set here and refreshed by updatePlaybackControls, because
	// the controls are built once and the step can change under them. The
	// handler reads the live snapshot rather than closing over a number.
	const skipBack = createControlButton(
		transport,
		PLAYER_ICONS.skipBack,
		`Back ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			const state = playbackStates.get(statusBarItem);
			state?.onSkip(-state.skipSeconds);
		},
	);
	skipBack.addClass(PLAYBACK_SKIP_BACK_CLASS);
	createControlButton(transport, PLAYER_ICONS.pause, 'Pause playback', () => {
		playbackStates.get(statusBarItem)?.onTogglePlay();
	}).addClass(PLAYBACK_TOGGLE_CLASS);
	createControlButton(transport, PLAYER_ICONS.stop, 'Stop playback', () => {
		playbackStates.get(statusBarItem)?.onStop();
	});
	const skipForward = createControlButton(
		transport,
		PLAYER_ICONS.skipForward,
		`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
		() => {
			const state = playbackStates.get(statusBarItem);
			state?.onSkip(state.skipSeconds);
		},
	);
	skipForward.addClass(PLAYBACK_SKIP_FORWARD_CLASS);

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
	const volume = createVolumeSlider(
		audioControls,
		PLAYBACK_VOLUME_CLASS,
		1,
		(value) => {
			playbackStates.get(statusBarItem)?.onVolumeInput(value);
		},
	);
	volumeSliders.set(volume.el, volume);

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

	// Its own span rather than a button inside the marker controls: chapter
	// navigation stays available in reading view, where adding markers does
	// not, so the two groups appear and disappear independently.
	const chapterControls = container.createSpan({
		cls: PLAYBACK_CHAPTER_CONTROLS_CLASS,
	});
	createControlButton(
		chapterControls,
		PLAYER_ICONS.chapterLoop,
		'Repeat current chapter',
		() => {
			playbackStates.get(statusBarItem)?.onToggleChapterLoop();
		},
	).addClass(PLAYBACK_CHAPTER_LOOP_CLASS);

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
	// The step is a setting, so the two skip buttons say what they will
	// actually do rather than the number they were built with.
	const skipBack = container.querySelector<HTMLElement>(
		`.${PLAYBACK_SKIP_BACK_CLASS}`,
	);
	if (skipBack) {
		setTooltip(
			skipBack,
			`Back ${String(state.skipSeconds)}s`,
			STATUS_BAR_TOOLTIP,
		);
	}
	const skipForward = container.querySelector<HTMLElement>(
		`.${PLAYBACK_SKIP_FORWARD_CLASS}`,
	);
	if (skipForward) {
		setTooltip(
			skipForward,
			`Forward ${String(state.skipSeconds)}s`,
			STATUS_BAR_TOOLTIP,
		);
	}

	const toggle = container.querySelector<HTMLElement>(
		`.${PLAYBACK_TOGGLE_CLASS}`,
	);
	if (toggle) {
		setIcon(toggle, state.paused ? PLAYER_ICONS.play : PLAYER_ICONS.pause);
		setTooltip(
			toggle,
			state.paused ? 'Play audio' : 'Pause playback',
			STATUS_BAR_TOOLTIP,
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

	const volumeEl = container.querySelector(`.${PLAYBACK_VOLUME_CLASS}`);
	const volume = volumeEl && volumeSliders.get(volumeEl);
	// A slider the user is holding keeps the value under their finger
	if (volume && activeDocument.activeElement !== volume.el) {
		volume.show(state.volume);
	}

	const markerControls = container.querySelector<HTMLElement>(
		`.${PLAYBACK_MARKER_CONTROLS_CLASS}`,
	);
	if (markerControls) {
		markerControls.hidden = !state.markersEnabled;
	}

	const chapterControls = container.querySelector<HTMLElement>(
		`.${PLAYBACK_CHAPTER_CONTROLS_CLASS}`,
	);
	if (chapterControls) {
		chapterControls.hidden = !state.chaptersEnabled;
	}
	const chapterLoop = container.querySelector<HTMLElement>(
		`.${PLAYBACK_CHAPTER_LOOP_CLASS}`,
	);
	if (chapterLoop) {
		chapterLoop.toggleClass('is-active', state.chapterLoopEnabled);
		chapterLoop.setAttribute(
			'aria-pressed',
			String(state.chapterLoopEnabled),
		);
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
 * Renders a minimized transcription job in the status bar. The progress is a
 * button that restores the transcription modal, from a click or from Enter
 * and Space once it has focus.
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
 * Renders a quick note that is under way: while it records, the same surface
 * a recording shows, with a stop button and the live indicators; while it is
 * transcribed and rewritten, the progress of each stage.
 * @param statusBarItem - The status bar HTML element
 * @param status - Recording while it captures, Saving while it is processed
 * @param progress - The stage being processed and how far along it is
 * @param onStop - Stops the dictation, as a second press of its button does
 * @param liveOptions - Which live indicators to show while it records
 */
export function renderQuickNoteStatusBar(
	statusBarItem: HTMLElement | null,
	status: RecordingStatus,
	progress: SaveProgress | undefined,
	onStop: () => void,
	liveOptions: RecordingLiveOptions,
): void {
	if (!statusBarItem) {
		return;
	}
	if (status === RecordingStatus.Recording) {
		renderRecordingState(
			statusBarItem,
			'Quick note...',
			[{ icon: 'square', label: 'Stop quick note', onClick: onStop }],
			liveOptions,
		);
		return;
	}
	renderProgressState(
		statusBarItem,
		progress,
		'is-transcribing',
		'Transcribing quick note...',
	);
}

/** The state classes a progress surface shows under. */
type ProgressStateClass = 'is-saving' | 'is-transcribing';

/** The parts of a mounted progress surface that every update rewrites. */
interface ProgressView {
	/** The state it was built for; another state builds it again. */
	readonly stateClass: ProgressStateClass;
	/** The line saying what the work is doing. */
	readonly text: HTMLElement;
	readonly bar: ProgressBar;
	/** The button that restores a background task's window, if it has one. */
	readonly restore: HTMLButtonElement | null;
	/** The latest restore action, read by the button when it is pressed. */
	onActivate: (() => void) | null;
}

/**
 * The progress surface behind each mounted content element, found again on
 * the next update rather than rebuilt.
 */
const progressViews = new WeakMap<Element, ProgressView>();

/** Class of the element that holds a progress surface. */
const PROGRESS_CONTENT_CLASS = 'aar-status-progress-content';

/**
 * Renders or updates a compact progress indicator in the status bar.
 *
 * The surface is built once and its text and bar are rewritten in place on
 * every report, as the playback controls are: a report arrives with every
 * stage of the work, and a rebuild would take the keyboard focus off the
 * restore button and restart the bar's growth from nothing each time.
 * @param el - The status bar HTML element
 * @param progress - Optional progress info
 * @param stateClass - CSS class for the active state
 * @param defaultDescription - Fallback text
 * @param options - Optional restore action metadata
 */
function renderProgressState(
	el: HTMLElement,
	progress: SaveProgress | undefined,
	stateClass: ProgressStateClass,
	defaultDescription: string,
	options?: BackgroundProgressOptions,
): void {
	const mounted = el.querySelector(`.${PROGRESS_CONTENT_CLASS}`);
	let view = mounted ? progressViews.get(mounted) : undefined;
	if (
		!view ||
		view.stateClass !== stateClass ||
		(view.restore !== null) !== (options !== undefined)
	) {
		view = buildProgressView(el, stateClass, options !== undefined);
	}

	const description = progress?.description ?? defaultDescription;
	view.text.textContent = description;
	view.bar.setLabel(description);
	view.bar.setValue(progress?.percent);
	view.onActivate = options?.onActivate ?? null;
	if (view.restore && options) {
		setTooltip(view.restore, options.activationLabel, STATUS_BAR_TOOLTIP);
	}
}

/**
 * Builds a progress surface: the line of text and the bar under it.
 *
 * A background task's line is a native button in Obsidian's icon-button
 * class, which the platform activates from the keyboard and the app draws a
 * hover and a focus ring for. The bar sits beside the button rather than in
 * it: a button's content is flattened for a screen reader, which would lose
 * the bar's role and value, and a button may not hold the divs the bar is
 * made of. The stylesheet stretches the button over the bar, so a click on
 * either restores the window.
 * @param el - The status bar HTML element
 * @param stateClass - CSS class for the active state
 * @param restorable - Whether the surface restores a background task
 * @returns The mounted surface
 */
function buildProgressView(
	el: HTMLElement,
	stateClass: ProgressStateClass,
	restorable: boolean,
): ProgressView {
	el.empty();
	playbackStates.delete(el);
	el.classList.remove('is-recording');
	el.classList.remove('is-saving');
	el.classList.remove('is-transcribing');
	el.classList.remove('is-playback');
	el.classList.add(stateClass);

	const content = el.createDiv({ cls: PROGRESS_CONTENT_CLASS });
	const restore = restorable
		? content.createEl('button', {
				cls: 'clickable-icon aar-status-progress-actionable',
				attr: { type: 'button' },
			})
		: null;
	const view: ProgressView = {
		stateClass,
		text: (restore ?? content).createSpan(),
		bar: createProgressBar(content, 'aar-save-progress', ''),
		restore,
		onActivate: null,
	};
	// Single click matches the sibling recording controls; stop propagation
	// so the surrounding status bar item does not also react.
	restore?.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		view.onActivate?.();
	});
	progressViews.set(content, view);
	return view;
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
