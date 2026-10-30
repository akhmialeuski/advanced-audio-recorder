/**
 * Ribbon icon component for displaying recording status.
 * @module ui/RibbonIcon
 */

import { setIcon, setTooltip } from 'obsidian';
import { RecordingStatus } from '../types';

/**
 * The recorder button's tooltip: what the button does, named after the
 * plugin so it is told apart from the core Audio recorder's button, and how
 * many stopped recordings are still being saved. The icon shows only the
 * capture, so a save running behind it is said here.
 * @param pluginName - The plugin's name from its manifest
 * @param saves - How many stopped recordings are being saved or wait to be
 * @returns The tooltip text
 */
export function recorderRibbonTooltip(
	pluginName: string,
	saves: number,
): string {
	return withSavesInProgress(`${pluginName}: start/stop recording`, saves);
}

/**
 * A record button's label, followed by how many stopped recordings are still
 * being saved, so every button that starts a recording says it the same way.
 * @param label - What the button does
 * @param saves - How many stopped recordings are being saved or wait to be
 * @returns The label, with the saves named when there are any
 */
export function withSavesInProgress(label: string, saves: number): string {
	if (saves === 0) {
		return label;
	}
	const count = saves === 1 ? '1 recording' : `${String(saves)} recordings`;
	return `${label} (${count} saving)`;
}

/**
 * Sets the recorder button's tooltip to name the saves still running.
 * @param ribbonIconEl - The recorder's ribbon button, or null before it exists
 * @param pluginName - The plugin's name from its manifest
 * @param saves - How many stopped recordings are being saved or wait to be
 */
export function updateRecorderRibbonTooltip(
	ribbonIconEl: HTMLElement | null,
	pluginName: string,
	saves: number,
): void {
	if (!ribbonIconEl) {
		return;
	}
	setTooltip(ribbonIconEl, recorderRibbonTooltip(pluginName, saves));
}

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
export const ICON_SAVING = 'save';

/**
 * Icon name of the quick note button.
 *
 * Neither microphone: the recorder's button and Obsidian's own Audio recorder
 * already hold one each in the same ribbon, and a third would be a button
 * nobody can tell from the other two. A waveform says "speech becomes
 * something", which is what a dictation into the note is.
 */
export const ICON_QUICK_NOTE = 'audio-lines';

/**
 * Class that hides a ribbon button the plugin registered but does not offer
 * right now. The rule lives in the plugin stylesheet, so a theme can override
 * it like any other.
 */
export const RIBBON_HIDDEN_CLASS = 'aar-ribbon-hidden';

/** The glyphs one ribbon button shows. */
export interface RibbonGlyphs {
	/** Shown while idle and while capturing. */
	readonly live: string;
	/** Shown while the capture is being saved or processed. */
	readonly busy: string;
}

/** The recorder's own button: a microphone, and a disk while saving. */
const RECORDER_GLYPHS: RibbonGlyphs = { live: ICON_MIC, busy: ICON_SAVING };

/**
 * The quick note button keeps its glyph throughout: it saves nothing, so a
 * disk would say something untrue, and the busy colour and pulse already say
 * the dictation is being worked on.
 */
export const QUICK_NOTE_GLYPHS: RibbonGlyphs = {
	live: ICON_QUICK_NOTE,
	busy: ICON_QUICK_NOTE,
};

/**
 * Updates the ribbon icon element based on recording status.
 * Toggles the state CSS class, and swaps the glyph for the one saving has.
 * @param ribbonIconEl - The ribbon icon HTML element
 * @param status - Current recording status
 * @param glyphs - The button's glyphs; the recorder's own by default
 */
export function updateRibbonIcon(
	ribbonIconEl: HTMLElement | null,
	status: RecordingStatus,
	glyphs: RibbonGlyphs = RECORDER_GLYPHS,
): void {
	if (!ribbonIconEl) {
		return;
	}

	switch (status) {
		// A paused session still holds the microphone, so the ribbon says the
		// same thing it says while the audio is flowing.
		case RecordingStatus.Recording:
		case RecordingStatus.Paused:
			setIcon(ribbonIconEl, glyphs.live);
			ribbonIconEl.classList.add('is-recording');
			ribbonIconEl.classList.remove('is-saving');
			break;
		case RecordingStatus.Interrupted:
		case RecordingStatus.Saving:
			setIcon(ribbonIconEl, glyphs.busy);
			ribbonIconEl.classList.remove('is-recording');
			ribbonIconEl.classList.add('is-saving');
			break;
		case RecordingStatus.Idle:
		default:
			setIcon(ribbonIconEl, glyphs.live);
			ribbonIconEl.classList.remove('is-recording');
			ribbonIconEl.classList.remove('is-saving');
			break;
	}
}
