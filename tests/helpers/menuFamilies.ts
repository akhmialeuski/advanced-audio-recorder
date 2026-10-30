/**
 * The registered families the context menus render, built the way the plugin
 * builds them at load: every family added to one action registry over a
 * plugin double. A menu test therefore renders exactly what the palette and
 * the command line register, rather than a list of its own.
 * @module tests/helpers/menuFamilies
 */

import { ActionRegistry } from 'src/actions/core/ActionRegistry';
import type { ActionServices } from 'src/actions/core/PluginAction';
import { fileActionFamily } from 'src/actions/file/fileActions';
import { folderActionFamily } from 'src/actions/folder/folderActions';
import { positionActionFamily } from 'src/actions/position/positionActions';
import { transcriptActionFamily } from 'src/actions/transcript/transcriptActions';
import type { MenuFamilies } from 'src/actions/ContextMenu';
import { mockPluginHost } from './obsidianMock';

/** The registry, and the families the menus render. */
export interface RegisteredMenus {
	/** The registry the families were added to. */
	readonly registry: ActionRegistry;
	/** The families, as the plugin hands them to the menus. */
	readonly families: MenuFamilies;
}

/**
 * Registers the menu families over the given services.
 * @param services - The services every action runs against
 * @returns The registry and the families
 */
export function registeredMenus(services: ActionServices): RegisteredMenus {
	const registry = new ActionRegistry(
		mockPluginHost(services.app),
		jest.fn(),
	);
	return {
		registry,
		families: {
			file: registry.add(fileActionFamily(services)),
			transcript: registry.add(transcriptActionFamily(services)),
			position: registry.add(positionActionFamily(services, () => null)),
			folder: registry.add(folderActionFamily(services)),
		},
	};
}
