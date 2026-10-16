/**
 * Contract a rendered player exposes for its embed element so other
 * parts of the plugin (notably the context menu) can drive it without
 * importing the DOM-heavy player module. The association is held in a
 * WeakMap keyed by the embed element rather than on the element itself,
 * so nothing is stored on the DOM node and stale entries are collected
 * once the element is gone. Kept dependency-light so it can be imported
 * from anywhere.
 * @module player/playerEmbedActions
 */

/**
 * What the context menu needs from a player to offer the position actions
 * at the point that was right-clicked, without reaching into the player's
 * internals: the actions themselves are the plugin's position actions.
 */
export interface PlayerEmbedActions {
	/**
	 * Whether a marker may be added from this player: markers switched on,
	 * and the player not read-only.
	 */
	readonly markersEnabled: boolean;
	/** Converts a client X coordinate to a playback offset, or null. */
	timeAtClientX(clientX: number): number | null;
	/** Toggles play / pause. */
	togglePlayback(): void;
}

/**
 * Maps an embed element to its live player's context-menu actions. A
 * WeakMap keeps the association off the DOM node and lets the entry be
 * reclaimed automatically once the element is gone.
 */
const actionsByEmbed = new WeakMap<HTMLElement, PlayerEmbedActions>();

/**
 * Publishes a player's context-menu actions for its embed element.
 * @param embed - Embed element the player rendered into
 * @param actions - Position-aware actions the context menu can invoke
 */
export function setPlayerEmbedActions(
	embed: HTMLElement,
	actions: PlayerEmbedActions,
): void {
	actionsByEmbed.set(embed, actions);
}

/**
 * Removes the published actions for an embed element.
 * @param embed - Embed element to clear
 */
export function clearPlayerEmbedActions(embed: HTMLElement): void {
	actionsByEmbed.delete(embed);
}

/**
 * Returns the published actions for an embed element, or undefined when
 * the embed is not (or no longer) an enhanced player.
 * @param embed - Embed element to look up
 */
export function getPlayerEmbedActions(
	embed: HTMLElement,
): PlayerEmbedActions | undefined {
	return actionsByEmbed.get(embed);
}
