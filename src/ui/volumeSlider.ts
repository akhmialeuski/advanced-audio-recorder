/**
 * The volume slider the inline player and the status bar both show, built
 * from Obsidian's own SliderComponent.
 * @module ui/volumeSlider
 */

import { SliderComponent } from 'obsidian';
import { PLAYER_VOLUME_SLIDER_STEP } from '../constants';

/** A mounted volume slider. */
export interface VolumeSlider {
	/** The range input itself, for focus checks. */
	readonly el: HTMLInputElement;
	/**
	 * Shows a volume that came from the playback rather than from the user,
	 * without reporting it back as a change.
	 * @param volume - Volume in the inclusive 0..1 range
	 */
	show(volume: number): void;
}

/**
 * What a screen reader announces for a volume: the slider's own value is a
 * fraction, and "0.85" says less than "85%".
 * @param volume - Volume in the inclusive 0..1 range
 * @returns The volume as a whole percentage
 */
function volumeText(volume: number): string {
	return `${String(Math.round(volume * 100))}%`;
}

/**
 * Mounts a volume slider into a container.
 *
 * The component draws the app's own slider, fills the track up to the thumb
 * from every change of value, and keeps a drag on it from opening a sidebar on
 * mobile. It reports while the thumb is being dragged (setInstant), because
 * the volume is meant to follow the finger rather than jump on release.
 *
 * Two things it does are not wanted here. It shows the value as text beside
 * the slider, which neither the player row nor the status bar has room for:
 * an empty display format leaves that text empty, and Obsidian hides an empty
 * value. And its setValue reports the new value to the change callback like a
 * drag would, which for a volume pushed in from the playback would unmute a
 * muted track; show() sets the value with the callback held back instead.
 * @param parent - The element the slider is appended to
 * @param cls - The class the caller styles and finds the slider by
 * @param volume - The volume to show at first, 0..1
 * @param onInput - Called with each volume the user picks
 * @returns The mounted slider
 */
export function createVolumeSlider(
	parent: HTMLElement,
	cls: string,
	volume: number,
	onInput: (volume: number) => void,
): VolumeSlider {
	const slider = new SliderComponent(parent)
		.setLimits(0, 1, PLAYER_VOLUME_SLIDER_STEP)
		.setInstant(true)
		.setDisplayFormat(() => '')
		.setValue(volume);
	const el = slider.sliderEl;
	el.addClass(cls);
	el.setAttribute('aria-label', 'Volume');
	el.setAttribute('aria-valuetext', volumeText(slider.getValue()));
	let showing = false;
	slider.onChange((value) => {
		el.setAttribute('aria-valuetext', volumeText(value));
		if (!showing) {
			onInput(value);
		}
	});
	return {
		el,
		show(value: number): void {
			showing = true;
			try {
				slider.setValue(value);
			} finally {
				showing = false;
			}
		},
	};
}
