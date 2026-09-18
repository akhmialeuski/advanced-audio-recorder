/**
 * Ribbon icon component for displaying recording status.
 * @module ui/RibbonIcon
 */

import { setIcon } from 'obsidian';
import { RecordingStatus } from '../types';

/**
 * Icon name for every state that shows the microphone.
 *
 * A hand microphone rather than the plain one, because Obsidian's own Audio
 * recorder registers `lucide-mic` in the same ribbon, and two identical
 * glyphs side by side are two buttons nobody can tell apart. That a session
 * is live is said by the colour and the pulse the CSS class brings, which is
 * what said it before this name existed: the idle icon was `microphone`,
 * Obsidian's own alias of `mic`, so the glyph never changed with the state.
 */
export const ICON_MIC = 'mic-vocal';
/** Icon name for saving state */
const ICON_SAVING = 'save';

/**
 * Updates the ribbon icon element based on recording status.
 * Toggles the state CSS class, and swaps the glyph for the one saving has.
 * @param ribbonIconEl - The ribbon icon HTML element
 * @param status - Current recording status
 */
export function updateRibbonIcon(
	ribbonIconEl: HTMLElement | null,
	status: RecordingStatus,
): void {
	if (!ribbonIconEl) {
		return;
	}

	switch (status) {
		// A paused session still holds the microphone, so the ribbon says the
		// same thing it says while the audio is flowing.
		case RecordingStatus.Recording:
		case RecordingStatus.Paused:
			setIcon(ribbonIconEl, ICON_MIC);
			ribbonIconEl.classList.add('is-recording');
			ribbonIconEl.classList.remove('is-saving');
			break;
		case RecordingStatus.Interrupted:
		case RecordingStatus.Saving:
			setIcon(ribbonIconEl, ICON_SAVING);
			ribbonIconEl.classList.remove('is-recording');
			ribbonIconEl.classList.add('is-saving');
			break;
		case RecordingStatus.Idle:
		default:
			setIcon(ribbonIconEl, ICON_MIC);
			ribbonIconEl.classList.remove('is-recording');
			ribbonIconEl.classList.remove('is-saving');
			break;
	}
}

/**
 * Initializes the ribbon icon to idle state.
 * @param ribbonIconEl - The ribbon icon HTML element
 */
export function initializeRibbonIcon(ribbonIconEl: HTMLElement | null): void {
	updateRibbonIcon(ribbonIconEl, RecordingStatus.Idle);
}
