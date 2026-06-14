/**
 * Contract a rendered player publishes on its embed element so other
 * parts of the plugin (notably the context menu) can drive it without
 * importing the DOM-heavy player module. Kept dependency-light so it can
 * be imported from anywhere.
 * @module player/playerEmbedActions
 */

import type { MarkerKind } from './markers/markerModel';

/**
 * Position-aware player actions exposed on the embed element so the
 * context menu can offer them on right-click without reaching into the
 * player's internals.
 */
export interface PlayerEmbedActions {
	/** Whether marker/chapter actions should be offered. */
	readonly markersEnabled: boolean;
	/** Whether the copy-timestamp action should be offered. */
	readonly timestampLinksEnabled: boolean;
	/** Converts a client X coordinate to a playback offset, or null. */
	timeAtClientX(clientX: number): number | null;
	/** Adds a marker or chapter at the given time. */
	addMarkerAtTime(time: number, kind: MarkerKind): void;
	/** Copies a timestamp link at the given time. */
	copyTimestampAtTime(time: number): void;
	/** Toggles play / pause. */
	togglePlayback(): void;
}

/** Property name under which a player publishes its actions on an embed. */
export const PLAYER_ACTIONS_PROP = 'aarPlayerActions';

/** Embed element augmented with the player's context-menu actions. */
export type PlayerEmbedElement = HTMLElement & {
	[PLAYER_ACTIONS_PROP]?: PlayerEmbedActions;
};
