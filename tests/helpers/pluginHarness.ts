/**
 * Loading the plugin the way Obsidian loads it.
 *
 * Every e2e suite starts the same way - construct the plugin over a manifest,
 * stand in for the data.json read and write, and await `onload()` - and each
 * one used to spell it out. The manifest in particular has to be real enough
 * for `manifest.dir` to name a plugin folder, since that is where the settings
 * backup and the media-kind store live.
 * @module tests/helpers/pluginHarness
 */

import { App } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { partial } from './doubles';

/** The manifest Obsidian hands a plugin it loaded from disk. */
export const MANIFEST: PluginManifest = partial<PluginManifest>({
	id: 'advanced-audio-recorder',
	name: 'Advanced Audio Recorder',
	version: '2.2.2',
	minAppVersion: '1.6.6',
	author: 'akhmialeuski',
	dir: 'config-dir/plugins/advanced-audio-recorder',
});

/** A loaded plugin, with the persistence calls Obsidian owns as spies. */
export interface LoadedPlugin {
	plugin: AudioRecorderPlugin;
	app: App;
	loadData: jest.Mock;
	saveData: jest.Mock;
}

/**
 * Loads the plugin the way Obsidian does.
 * @param stored - What data.json holds, or null for a first install
 * @param app - The app to load into, when a test seeded its vault first
 * @returns The loaded plugin, its app, and its persistence spies
 */
export async function loadPlugin(
	stored: Record<string, unknown> | null = null,
	app: App = new App(),
): Promise<LoadedPlugin> {
	const plugin = new AudioRecorderPlugin(app, MANIFEST);
	const loadData = jest.fn().mockResolvedValue(stored);
	const saveData = jest.fn().mockResolvedValue(undefined);
	const persistence = plugin as unknown as Record<string, unknown>;
	persistence.loadData = loadData;
	persistence.saveData = saveData;
	await plugin.onload();
	return { plugin, app, loadData, saveData };
}
