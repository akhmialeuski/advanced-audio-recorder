/**
 * The row and block shapes more than one section builds.
 *
 * Each of these exists because two or more sections would otherwise write the
 * same thing: the group every page wraps its rows in, the summary line a page
 * entry carries, the row whose body is drawn by hand, the engine picker three
 * jobs offer. A helper used by one section stays in that section.
 * @module settings/sections/rowHelpers
 */

import { LLM_PROVIDER_LABELS } from '../labels';
import type { AudioRecorderSettings } from '../settingsSchema';
import {
	type DeviceOptions,
	SETTINGS_ROOT_CLASS,
	SETTINGS_SECTION_CLASS,
} from './context';
import type {
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	SettingGroupItem,
} from 'obsidian';

/**
 * The rows of a page that is a single block, wrapped in the group the
 * stylesheet separates. The page title already names the block, so the group
 * carries no heading of its own; without it the framework would wrap the rows
 * in a group of its own that nothing here can mark.
 * @param rows - The page's rows, in the order they are shown
 * @param extraClass - Class the block carries beyond the shared one, where its
 * rows need a layout of their own
 * @returns The page's items
 */
export function sectionItems(
	rows: SettingGroupItem[],
	extraClass?: string,
): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			cls: extraClass
				? `${SETTINGS_SECTION_CLASS} ${extraClass}`
				: SETTINGS_SECTION_CLASS,
			items: rows,
		},
	];
}

/**
 * Whether anything on the Transcription page still calls an engine.
 *
 * Turning transcription off does not retire every feature the page holds.
 * Chapters are offered on a recording that already has a transcript, so the
 * action stays registered on its own switch alone, and it calls an engine with
 * a key, an endpoint, and a model of its own. Gating the rows that configure
 * that engine on transcription instead would leave the action offered while
 * everything it needs is off screen - and the failure it then reports names the
 * Engines page as the place to fix it.
 * @param settings - Live settings, read for the two switches
 */
export function transcriptionPageActive(
	settings: AudioRecorderSettings,
): boolean {
	return (
		settings.transcriptionEnabled ||
		settings.transcriptionAutoChaptersEnabled
	);
}

/**
 * What a page of independent switches says on its entry: how many of them are
 * on. Counted from the rows themselves rather than from a second list of keys,
 * so a switch added to the page is counted without being registered twice.
 * @param rows - The page's rows
 * @param settings - Live settings, read by each row's own key
 * @returns The count, as the entry shows it
 */
export function toggleSummary(
	rows: readonly SettingDefinition[],
	settings: AudioRecorderSettings,
): string {
	const keys = rows.flatMap((row) =>
		'control' in row && row.control?.type === 'toggle'
			? [row.control.key]
			: [],
	);
	const on = keys.filter(
		(key) => settings[key as keyof AudioRecorderSettings] === true,
	).length;
	return `${String(on)} of ${String(keys.length)} on`;
}

/**
 * A row whose body is rendered by hand, hosted in the row itself, which is the
 * only DOM a render definition owns. The fields inside such a block are
 * invisible to the settings search - it indexes definitions, and the block is
 * one - so the row carries what a user would type looking for them.
 * @param row - Row name, its extra search terms, its body and when it applies
 */
export function imperativeBlockRow(row: {
	name: string;
	aliases: string[];
	render: (host: HTMLElement) => void;
}): SettingDefinition {
	return {
		name: row.name,
		aliases: row.aliases,
		render: (setting: Setting): void => {
			const host = setting.settingEl;
			host.empty();
			host.addClass(SETTINGS_ROOT_CLASS);
			row.render(host);
		},
	};
}

/**
 * What a device-picking row says under its dropdown.
 *
 * An empty dropdown reads as "this machine has no microphone", which is the
 * one thing it does not mean when the list could not be read: an environment
 * with no device API - a vault served over plain HTTP, some embedded WebViews
 * - or an enumeration the platform refused. The row says so rather than
 * leaving the user to guess at an empty list.
 * @param devices - The audio-input picture the rows are built from
 * @param whenListed - What the row says when the list was read
 * @param selectable - Whether this platform offers the choice at all
 * @returns The row's description
 */
export function deviceRowDesc(
	devices: DeviceOptions,
	whenListed: string,
	selectable: boolean,
): string {
	if (!selectable) {
		return 'Not selectable on this device; recording uses the system default microphone.';
	}
	if (!devices.enumerated) {
		return 'The list of audio devices could not be read here, so recording uses the system default microphone.';
	}
	return whenListed;
}

/**
 * The filter a list of named entries carries in its header. Every collection
 * here is a flat list of names, so they all narrow the same way: the framework
 * draws the field, keeps the query across re-renders, and reapplies it.
 * @param placeholder - Prompt shown in the empty filter field
 * @returns The group's search declaration
 */
export function nameFilter(placeholder: string): {
	placeholder: string;
	match: (definition: SettingDefinition, query: string) => boolean;
} {
	return {
		placeholder,
		match: (definition, query): boolean =>
			definition.name.toLowerCase().includes(query.toLowerCase()),
	};
}

/**
 * A labelled row repeating a list's add affordance, declared where the renderer
 * draws only a plus icon in the list header. It sits beside the list rather
 * than in it, since a row inside would be filtered away by the list's own
 * search exactly when an empty result makes adding one the obvious next move.
 * @param name - The label, which is also the icon's tooltip
 * @param desc - What the row creates
 * @param action - The list's own add action
 */
export function addItemRow(
	name: string,
	desc: string,
	action: () => void,
): SettingDefinition {
	return {
		name,
		desc,
		action: (): void => {
			action();
		},
	};
}

/**
 * The row that picks which engine does a job. Every job that calls an engine
 * declares one, right under the switch that turns the job on, so the engine is
 * settled before anything about how the job runs.
 * @param name - Row name, e.g. "Chapters engine"
 * @param desc - What the engine is called for
 * @param key - Settings key holding the choice
 * @param visible - Whether the job is on
 */
export function engineChoiceRow(
	name: string,
	desc: string,
	key: keyof AudioRecorderSettings,
	visible: () => boolean,
): SettingGroupItem {
	return {
		name,
		aliases: ['provider', 'vendor', 'model', 'llm'],
		desc,
		visible,
		control: {
			type: 'dropdown',
			key,
			options: LLM_PROVIDER_LABELS,
		},
	};
}
