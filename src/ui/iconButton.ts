/**
 * The icon-only button every plugin surface builds the same way: the status
 * bar, the mobile banner, the transcription queue and the player's marker
 * rows. One builder, so the element, its class and how it is named cannot
 * drift between them.
 * @module ui/iconButton
 */

import { setIcon, setTooltip } from 'obsidian';
import type { TooltipOptions } from 'obsidian';

/** What an icon button shows and is called. */
export interface IconButtonSpec {
	/** Obsidian icon name. */
	icon: string;
	/** Accessible name, which Obsidian also shows as the tooltip. */
	label: string;
	/** The caller's own class, which styles the button and finds it again. */
	cls: string;
	/** Where the tooltip opens, when Obsidian's default would not fit. */
	tooltip?: TooltipOptions;
}

/**
 * Appends an icon button to a container.
 *
 * A native button in Obsidian's icon-button class: the platform makes it
 * focusable and activates it from Enter and Space, and the class gives it the
 * app's hover, press, engaged state and focus ring without a text button's
 * chrome. The name is set through setTooltip, which writes the aria-label a
 * screen reader announces and shows the same text on hover. The click is the
 * caller's, because the surfaces react to it differently.
 * @param parent - The element the button is appended to
 * @param spec - Its icon, name, class and tooltip placement
 * @returns The button
 */
export function createIconButton(
	parent: HTMLElement,
	spec: IconButtonSpec,
): HTMLButtonElement {
	const button = parent.createEl('button', {
		cls: `clickable-icon ${spec.cls}`,
		attr: { type: 'button' },
	});
	setIcon(button, spec.icon);
	setTooltip(button, spec.label, spec.tooltip);
	return button;
}
