/**
 * Pointer and keyboard seeking on the player's seek area, plus the
 * client-X-to-time mapping shared with the marker overlay and the
 * context-menu actions. Owns only the interaction; what a seek does to
 * the shared audio element stays with the player.
 * @module player/SeekController
 */

import { PLAYER_SEEK_KEYBOARD_STEP_SECONDS } from '../constants';

/** Render-scoped listener registration provided by the player. */
export interface SeekHost {
	/** Adds a DOM listener torn down with the current render pass. */
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void;
}

/** What the seek interactions do to playback (owned by the player). */
export interface SeekCallbacks {
	/**
	 * Engages the shared timeline and moves playback to an absolute
	 * offset (pointer drag/click, Home, End).
	 */
	onSeekToTime(seconds: number): void;
	/** Relative skip (arrow keys), engaging the #t= start first. */
	onSkip(deltaSeconds: number): void;
	/**
	 * Consumes the #t= start hint without moving playback. Used by End
	 * when the duration is unknown, matching a seek that cannot land.
	 */
	onEngageTimeline(): void;
	/** Current duration of the shared audio (may be Infinity/NaN). */
	duration(): number;
}

/**
 * Wires click/drag and keyboard seeking on the seek area.
 */
export class SeekController {
	private seekEl: HTMLElement | null = null;
	private isSeeking = false;

	constructor(
		private readonly host: SeekHost,
		private readonly callbacks: SeekCallbacks,
	) {}

	/**
	 * Attaches the pointer and keyboard handlers to a (re)built seek area.
	 * The listeners are render-scoped: a re-render tears them down with the
	 * rest of the pass, so attach is called once per render.
	 * @param seekEl - The seek area element for the current render
	 */
	attach(seekEl: HTMLElement): void {
		this.seekEl = seekEl;
		this.isSeeking = false;
		this.registerPointer(seekEl);
		this.registerKeyboard(seekEl);
	}

	/**
	 * Converts a client X coordinate to a playback offset along the seek
	 * area, or null when the duration is unknown or the area has no width.
	 * @param clientX - Horizontal viewport coordinate
	 */
	timeAtClientX(clientX: number): number | null {
		const duration = this.callbacks.duration();
		if (!Number.isFinite(duration) || duration <= 0) {
			return null;
		}
		if (!this.seekEl) {
			return null;
		}
		const rect = this.seekEl.getBoundingClientRect();
		if (rect.width === 0) {
			return null;
		}
		const fraction = Math.min(
			1,
			Math.max(0, (clientX - rect.left) / rect.width),
		);
		return fraction * duration;
	}

	/**
	 * Wires pointer events for click/drag seeking on the seek area. The
	 * seek area captures the pointer on press so a drag that leaves it
	 * still tracks, without a document-wide listener per player instance.
	 */
	private registerPointer(seekEl: HTMLElement): void {
		this.host.registerDomEvent(seekEl, 'pointerdown', (event) => {
			// Ignore non-primary buttons so a right-click opens the
			// context menu instead of seeking
			if (event.button !== 0) {
				return;
			}
			this.isSeeking = true;
			// Route subsequent pointer events to the seek area even when
			// the cursor leaves it during the drag
			seekEl.setPointerCapture(event.pointerId);
			this.seekToPointer(event);
		});
		this.host.registerDomEvent(seekEl, 'pointermove', (event) => {
			if (this.isSeeking) {
				this.seekToPointer(event);
			}
		});
		this.host.registerDomEvent(seekEl, 'pointerup', (event) => {
			this.isSeeking = false;
			if (seekEl.hasPointerCapture(event.pointerId)) {
				seekEl.releasePointerCapture(event.pointerId);
			}
		});
		this.host.registerDomEvent(seekEl, 'pointercancel', () => {
			this.isSeeking = false;
		});
	}

	/**
	 * Wires keyboard seeking on the slider-role seek area: arrow keys
	 * nudge by a few seconds, Home/End jump to the bounds.
	 */
	private registerKeyboard(seekEl: HTMLElement): void {
		this.host.registerDomEvent(seekEl, 'keydown', (event) => {
			switch (event.key) {
				case 'ArrowRight':
				case 'ArrowUp':
					this.callbacks.onSkip(PLAYER_SEEK_KEYBOARD_STEP_SECONDS);
					break;
				case 'ArrowLeft':
				case 'ArrowDown':
					this.callbacks.onSkip(-PLAYER_SEEK_KEYBOARD_STEP_SECONDS);
					break;
				case 'Home':
					this.callbacks.onSeekToTime(0);
					break;
				case 'End': {
					const duration = this.callbacks.duration();
					if (Number.isFinite(duration)) {
						this.callbacks.onSeekToTime(duration);
					} else {
						this.callbacks.onEngageTimeline();
					}
					break;
				}
				default:
					return;
			}
			event.preventDefault();
		});
	}

	/**
	 * Seeks to the position under the pointer along the seek area.
	 * @param event - Pointer event from the seek interaction
	 */
	private seekToPointer(event: PointerEvent): void {
		const time = this.timeAtClientX(event.clientX);
		if (time === null) {
			return;
		}
		this.callbacks.onSeekToTime(time);
	}
}
