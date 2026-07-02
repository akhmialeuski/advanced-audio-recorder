/**
 * Single source of truth for the player's mode decisions, kept pure so
 * they can be unit-tested and never drift across the codebase:
 *
 * - `isEditableContext` - is the embed editable (Live Preview) or
 *   read-only (Reading view / detached / unknown)? Editing is allowed
 *   only inside the CodeMirror editor; everything else is display-only.
 * - `shouldEnhance` - should the enhanced player take over, or should the
 *   built-in embed be used? Only enabled, audio-only files are enhanced;
 *   video and unsupported files fall back to the built-in embed.
 * @module player/playerMode
 */

import { MEDIA_KIND, type MediaKind } from './mediaProbe';

/**
 * Whether an embed is in an editable context. True only when the element
 * is inside the CodeMirror editor (Live Preview); Reading view, detached,
 * and any unknown context are read-only.
 * @param el - The embed container element
 */
export function isEditableContext(el: HTMLElement): boolean {
	return el.closest('.cm-editor') !== null;
}

/**
 * Whether the enhanced player should take over the embed. Only when the
 * feature is enabled and the file is audio-only; video, unsupported, and
 * not-yet-probed (null) files use Obsidian's built-in embed. Accepting null
 * lets this be the single decision point even before a file has been probed.
 * @param enabled - The enhancedPlayerEnabled setting
 * @param kind - Probed media kind, or null when the file has not been probed
 */
export function shouldEnhance(
	enabled: boolean,
	kind: MediaKind | null,
): boolean {
	return enabled && kind === MEDIA_KIND.audio;
}
