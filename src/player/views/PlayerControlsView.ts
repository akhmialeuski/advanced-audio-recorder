/**
 * The enhanced player's control row: play/pause, skip, speed, mute,
 * volume, loop, optional marker/chapter buttons, the time display, and
 * the copy-timestamp action. Pure DOM: state changes are reported through
 * callbacks and reflected back via the set* methods, so the player keeps
 * ownership of the shared audio element.
 * @module player/views/PlayerControlsView
 */

import { setIcon } from 'obsidian';
import {
	PLAYER_ICONS,
	PLAYER_SKIP_SECONDS,
	PLAYER_VOLUME_SLIDER_STEP,
} from '../../constants';
import { MARKER_KIND, type MarkerKind } from '../../markers/markerModel';
import { formatTimecode } from '../../utils/TimeUtils';
import { formatPlaybackRate } from '../playbackRate';

/**
 * Snapshot of the shared audio's state at mount time, so a player
 * re-rendered while playback is already running (e.g. after a mode
 * switch) reflects the live state instead of the defaults.
 */
export interface PlayerControlsState {
	paused: boolean;
	playbackRate: number;
	volume: number;
	muted: boolean;
	loop: boolean;
	/** Render the marker/chapter buttons. */
	markersEnabled: boolean;
}

/** What each control does (owned by the player). */
export interface PlayerControlsCallbacks {
	onTogglePlay(): void;
	onSkip(deltaSeconds: number): void;
	onSpeedMenu(event: MouseEvent): void;
	onToggleMute(): void;
	/** The volume slider moved; the player applies it to the audio. */
	onVolumeInput(volume: number): void;
	/** Toggles looping; returns the new loop state for the button. */
	onToggleLoop(): boolean;
	onAddMarker(kind: MarkerKind): void;
	onPreviousChapter(): void;
	onNextChapter(): void;
	onCopyTimestampLink(): void;
}

/** Render-scoped listener registration provided by the player. */
export interface PlayerControlsHost {
	/** Adds a DOM listener torn down with the current render pass. */
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void;
}

/**
 * Shows a toggle button's state, to the eye and to a screen reader.
 *
 * The styling class alone left the state visible and unannounced: nothing said
 * whether looping was on or the sound was off, so a listener using a reader
 * had to play the track to find out. `aria-pressed` is what a button that
 * stays pressed reports itself with, and it is set here rather than at each
 * call site so the class and the attribute cannot drift apart.
 * @param button - The toggle button
 * @param active - Whether it is currently engaged
 */
function setToggleState(button: HTMLElement, active: boolean): void {
	button.toggleClass('is-active', active);
	button.setAttribute('aria-pressed', String(active));
}

/**
 * Builds and updates the control row. One instance per render pass; the
 * DOM it owns is recreated by the player's containerEl.empty().
 */
export class PlayerControlsView {
	private playButton: HTMLElement | null = null;
	private speedButton: HTMLElement | null = null;
	private muteButton: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;

	constructor(
		private readonly host: PlayerControlsHost,
		private readonly callbacks: PlayerControlsCallbacks,
	) {}

	/**
	 * Builds the control row into the container. Every control is fixed;
	 * only the marker controls depend on the markers window being enabled.
	 * @param container - The player's container element
	 * @param state - Live audio state to reflect on the controls
	 */
	mount(container: HTMLElement, state: PlayerControlsState): void {
		const controls = container.createDiv({
			cls: 'aar-player-controls',
		});

		this.playButton = this.createIconButton(
			controls,
			// Reflect the shared audio's current state, so a player rendered
			// while playback is already running (e.g. after a mode switch)
			// shows the pause icon rather than a stale play icon
			state.paused ? PLAYER_ICONS.play : PLAYER_ICONS.pause,
			'Play / pause',
			() => {
				this.callbacks.onTogglePlay();
			},
		);

		this.createIconButton(
			controls,
			PLAYER_ICONS.skipBack,
			`Back ${String(PLAYER_SKIP_SECONDS)}s`,
			() => {
				this.callbacks.onSkip(-PLAYER_SKIP_SECONDS);
			},
		);
		this.createIconButton(
			controls,
			PLAYER_ICONS.skipForward,
			`Forward ${String(PLAYER_SKIP_SECONDS)}s`,
			() => {
				this.callbacks.onSkip(PLAYER_SKIP_SECONDS);
			},
		);

		this.speedButton = controls.createEl('button', {
			cls: 'aar-player-btn aar-player-speed',
			// Reflect the shared audio's current rate, not the default, so a
			// re-render after a mode switch keeps showing the chosen speed
			text: formatPlaybackRate(state.playbackRate),
		});
		this.speedButton.setAttribute('aria-label', 'Playback speed');
		this.host.registerDomEvent(this.speedButton, 'click', (event) => {
			this.callbacks.onSpeedMenu(event);
		});

		this.muteButton = this.createIconButton(
			controls,
			PLAYER_ICONS.volume,
			'Mute / unmute',
			() => {
				this.callbacks.onToggleMute();
			},
		);
		this.setMuted(state.muted);

		const volume = controls.createEl('input', {
			cls: 'aar-player-volume',
			attr: {
				type: 'range',
				min: '0',
				max: '1',
				step: String(PLAYER_VOLUME_SLIDER_STEP),
				// Reflect the shared audio's current volume on re-render
				value: String(state.volume),
				'aria-label': 'Volume',
			},
		});
		this.host.registerDomEvent(volume, 'input', () => {
			this.callbacks.onVolumeInput(Number(volume.value));
		});

		const loopButton = this.createIconButton(
			controls,
			PLAYER_ICONS.loop,
			'Loop',
			() => {
				setToggleState(loopButton, this.callbacks.onToggleLoop());
			},
		);
		setToggleState(loopButton, state.loop);

		if (state.markersEnabled) {
			// Adding markers/chapters is edit-only; hidden in reading view
			this.createIconButton(
				controls,
				PLAYER_ICONS.addBookmark,
				'Add marker at current position',
				() => {
					this.callbacks.onAddMarker(MARKER_KIND.bookmark);
				},
			).addClass('aar-player-edit-only');
			this.createIconButton(
				controls,
				PLAYER_ICONS.addChapter,
				'Add chapter at current position',
				() => {
					this.callbacks.onAddMarker(MARKER_KIND.chapter);
				},
			).addClass('aar-player-edit-only');
			this.createIconButton(
				controls,
				PLAYER_ICONS.previousChapter,
				'Previous chapter',
				() => {
					this.callbacks.onPreviousChapter();
				},
			);
			this.createIconButton(
				controls,
				PLAYER_ICONS.nextChapter,
				'Next chapter',
				() => {
					this.callbacks.onNextChapter();
				},
			);
		}

		this.timeEl = controls.createDiv({ cls: 'aar-player-time' });
		this.timeEl.setText(
			`${formatTimecode(0, 0)} / ${formatTimecode(0, 0)}`,
		);

		this.createIconButton(
			controls,
			PLAYER_ICONS.copyLink,
			'Copy timestamp link',
			() => {
				this.callbacks.onCopyTimestampLink();
			},
		);
	}

	/**
	 * Reflects the playing state on the play/pause button.
	 * @param playing - True while the shared audio is playing
	 */
	setPlaying(playing: boolean): void {
		if (this.playButton) {
			setIcon(
				this.playButton,
				playing ? PLAYER_ICONS.pause : PLAYER_ICONS.play,
			);
		}
	}

	/**
	 * Reflects a playback rate on the speed button.
	 * @param rate - Playback rate multiplier
	 */
	setPlaybackRate(rate: number): void {
		this.speedButton?.setText(formatPlaybackRate(rate));
	}

	/**
	 * Reflects the muted state on the mute button.
	 * @param muted - True while the shared audio is muted
	 */
	setMuted(muted: boolean): void {
		if (this.muteButton) {
			setIcon(
				this.muteButton,
				muted ? PLAYER_ICONS.muted : PLAYER_ICONS.volume,
			);
			setToggleState(this.muteButton, muted);
		}
	}

	/**
	 * Updates the elapsed/total time display.
	 * @param text - Preformatted "elapsed / total" text
	 */
	setTime(text: string): void {
		this.timeEl?.setText(text);
	}

	/**
	 * Creates an icon button in a container and wires its click handler.
	 * @param container - Parent element
	 * @param icon - Obsidian icon id
	 * @param label - Accessible label / tooltip
	 * @param onClick - Click handler
	 * @returns The created button element
	 */
	private createIconButton(
		container: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLElement {
		const button = container.createEl('button', {
			cls: 'aar-player-btn',
			attr: { 'aria-label': label },
		});
		setIcon(button, icon);
		this.host.registerDomEvent(button, 'click', onClick);
		return button;
	}
}
