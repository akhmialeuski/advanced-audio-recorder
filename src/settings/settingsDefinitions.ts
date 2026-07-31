/**
 * The settings tab described as data: one tree of Obsidian setting definitions
 * that both render paths read.
 *
 * From Obsidian 1.13 this tree is the tab - the framework renders it, indexes
 * every setting for the settings search, reads and writes the values, runs the
 * validators, and re-evaluates the `visible`/`disabled` predicates. Below 1.13
 * none of that exists, so {@link module:settings/legacySettingsRenderer} walks
 * the same tree with the old `Setting` API. The official migration guide's
 * dual-support path keeps two hand-written implementations instead; for a tab
 * with sixty-odd settings that is a drift generator, and the guide says as much.
 *
 * Sections migrate into this tree from the bottom of the tab upwards, so the
 * part still rendered imperatively stays one contiguous block at the top and row
 * order never changes while the migration runs. That block is the remainder
 * definition below; it shrinks with each migrated section and goes away with the
 * last one.
 * @module settings/settingsDefinitions
 */

import type { Setting, SettingDefinitionItem } from 'obsidian';

/**
 * Marks the row that hosts the sections not described here yet. From 1.13 on,
 * the row of a render definition is the only DOM that definition owns, so the
 * stylesheet strips that row's own flex layout, padding, background, and
 * divider to let a whole imperative body read as an ordinary settings column.
 */
export const SETTINGS_ROOT_CLASS = 'aar-settings-root';

/**
 * Marks a row whose render callback puts block content (a status line, a
 * playback element) under its control instead of beside it. The stylesheet lets
 * such a row wrap so the block starts on its own line.
 */
export const SETTINGS_BLOCK_ROW_CLASS = 'aar-setting-block-row';

/**
 * The sections still rendered by the tab's own imperative body.
 */
export interface ImperativeRemainder {
	/** Row name, which is also what the settings search matches the tab by. */
	readonly name: string;
	/** Names of the settings inside the remainder, carried as search aliases. */
	readonly aliases: readonly string[];
	/** Draws those sections into a host the definition has already cleared. */
	render(host: HTMLElement): void;
}

/**
 * The diagnostics actions, which act on the plugin rather than on a setting.
 */
export interface DiagnosticsActions {
	/** Starts the fixed-length test capture, reporting into the row it is given. */
	startTestRecording(rowEl: HTMLElement): void;
	/** Releases the test capture and the blob URL of its playback element. */
	releaseTestRecording(): void;
	/** Opens the system-information dialog. */
	showSystemInfo(): void;
}

/**
 * What the definitions need from the tab that owns them.
 */
export interface SettingsDefinitionContext {
	/** The sections not migrated into this tree yet. */
	readonly remainder: ImperativeRemainder;
	/** Handlers for the diagnostics rows. */
	readonly diagnostics: DiagnosticsActions;
}

/**
 * The definition for the sections still rendered imperatively. Its row is the
 * only host that survives the framework's post-render pass, so the body is
 * rendered into the row itself, over the name, description, and control
 * elements the framework prefilled it with.
 * @param remainder - The imperative body and its search metadata
 */
function remainderDefinition(
	remainder: ImperativeRemainder,
): SettingDefinitionItem {
	return {
		name: remainder.name,
		// The settings inside this block are not definitions of their own yet,
		// so the search cannot index them individually. Their names travel as
		// aliases until they are migrated, which at least finds the tab.
		aliases: [...remainder.aliases],
		render: (setting: Setting): void => {
			const host = setting.settingEl;
			host.empty();
			host.addClass(SETTINGS_ROOT_CLASS);
			remainder.render(host);
		},
	};
}

/**
 * The diagnostics section: a test capture, the system-information dialog, and
 * the debug switch.
 * @param diagnostics - Handlers for the two action rows
 */
function diagnosticsGroup(
	diagnostics: DiagnosticsActions,
): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'Diagnostics',
		items: [
			{
				name: 'Test recording',
				desc: 'Records a 5-second test clip using your current settings and plays it back. Nothing is saved to your vault.',
				// A render row: the capture reports progress into the row and
				// leaves a playback element behind, which no control type covers.
				render: (setting: Setting): (() => void) => {
					setting.settingEl.addClass(SETTINGS_BLOCK_ROW_CLASS);
					setting.addButton((button) =>
						button.setButtonText('Start test').onClick(() => {
							diagnostics.startTestRecording(setting.settingEl);
						}),
					);
					// Handed to whoever renders the row - the framework on 1.13,
					// the legacy renderer below it - and run before the row is
					// rendered again or dropped, so a finished capture never
					// keeps its playback element and blob URL alive detached.
					return (): void => {
						diagnostics.releaseTestRecording();
					};
				},
			},
			{
				name: 'System info',
				desc: 'Show full system diagnostics including plugin settings, audio devices, and browser capabilities.',
				action: (): void => {
					diagnostics.showSystemInfo();
				},
			},
			{
				name: 'Debug mode',
				desc: 'Enable verbose logs for troubleshooting recording issues.',
				control: { type: 'toggle', key: 'debug' },
			},
		],
	};
}

/**
 * Builds the tab's definition tree.
 * @param ctx - The tab's remainder body and action handlers
 * @returns The definitions, in the order the tab renders them
 */
export function buildSettingsDefinitions(
	ctx: SettingsDefinitionContext,
): SettingDefinitionItem[] {
	return [
		remainderDefinition(ctx.remainder),
		diagnosticsGroup(ctx.diagnostics),
	];
}

/**
 * The control keys whose writes are worth debouncing: the text-bearing ones,
 * which fire a change per keystroke. Obsidian persists a control change the
 * moment it happens, so without this a single typed word rewrites data.json a
 * dozen times. Derived from the tree rather than listed by hand, so a control
 * that becomes a text field cannot be forgotten here.
 * @param items - The definition tree to scan
 * @returns Keys of every text and textarea control in the tree
 */
export function collectDebouncedControlKeys(
	items: readonly SettingDefinitionItem[],
): Set<string> {
	const keys = new Set<string>();
	const scan = (entries: readonly SettingDefinitionItem[]): void => {
		for (const entry of entries) {
			if ('type' in entry) {
				scan(entry.items ?? []);
				continue;
			}
			const control = entry.control;
			if (
				control &&
				(control.type === 'text' || control.type === 'textarea')
			) {
				keys.add(control.key);
			}
		}
	};
	scan(items);
	return keys;
}
