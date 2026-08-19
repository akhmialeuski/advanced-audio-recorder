/**
 * Narrowing helpers for the parts of the obsidian mock the real type
 * definitions do not describe.
 *
 * Tests import `obsidian` through the specifier, which type-checks against the
 * published `obsidian.d.ts` - deliberately, so a test cannot lean on a shape the
 * real API does not have. The mock adds a few test-only affordances on top
 * (a menu's items, a vault's seed store, a plugin's recorded registrations),
 * and reaching them needs a cast. Doing that cast here, once, keeps the
 * `as unknown as` out of the test bodies and gives the affordance a name.
 * @module tests/helpers/obsidianMock
 */

import type { App, Menu, Plugin, Vault, Workspace } from 'obsidian';
import { partial } from './doubles';
import type {
	App as MockApp,
	Menu as MockMenu,
	Plugin as MockPlugin,
	Vault as MockVault,
	Workspace as MockWorkspace,
} from '../mocks/obsidian';

/**
 * The menu as the mock builds it: items are readable and clickable.
 * @param menu - A menu the production code built
 * @returns The same object, typed with the mock's affordances
 */
export function asMockMenu(menu: Menu): MockMenu {
	return menu as unknown as MockMenu;
}

/**
 * The vault as the mock builds it, with the seed store.
 * @param vault - The vault under test
 * @returns The same object, typed with the mock's affordances
 */
export function asMockVault(vault: Vault): MockVault {
	return vault as unknown as MockVault;
}

/**
 * The workspace as the mock builds it, with event delivery and seeding.
 * @param workspace - The workspace under test
 * @returns The same object, typed with the mock's affordances
 */
export function asMockWorkspace(workspace: Workspace): MockWorkspace {
	return workspace as unknown as MockWorkspace;
}

/**
 * The app as the mock builds it, so its vault and workspace carry the
 * affordances too.
 * @param app - The app under test
 * @returns The same object, typed with the mock's affordances
 */
export function asMockApp(app: App): MockApp {
	return app as unknown as MockApp;
}

/**
 * The plugin as the mock builds it, with the list of event registrations.
 * @param plugin - The plugin under test
 * @returns The same object, typed with the mock's affordances
 */
export function asMockPlugin(plugin: Plugin): MockPlugin {
	return plugin as unknown as MockPlugin;
}

/**
 * A partial stand-in typed as the App the code under test expects.
 *
 * Sugar over {@link partial} for the type nearly every suite needs one of.
 * @param parts - The slice of App the code under test reads
 * @returns The same object, typed as an App
 */
export function partialApp(parts: object): App {
	return partial<App>(parts);
}

/**
 * A partial stand-in typed as the Plugin the code under test expects.
 * @param parts - The slice of Plugin the code under test reads
 * @returns The same object, typed as a Plugin
 */
export function partialPlugin(parts: object): Plugin {
	return partial<Plugin>(parts);
}
