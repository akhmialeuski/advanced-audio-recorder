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
 * A handful of rows cannot be declared: the documentation callout, the format
 * list blocked per option by an asynchronous encoder probe, the output summary
 * derived from two other rows, the test capture that reports into its own row,
 * each account's API key, which is a password field the control set has no type
 * for, and the local engine's binary and model paths, which are file pickers.
 * Those use the framework's own escape hatch, a render callback, and nothing
 * else does.
 *
 * Each section of the tab describes itself in its own module under
 * `./sections`, and this one only orders them. The sections never call each
 * other: they share a context, the row shapes in `./sections/rowHelpers`, and
 * nothing more, which is what keeps a section readable without the rest of the
 * tab. What a control key means once a value is read or written is a different
 * question, answered in `./controlValues`.
 * @module settings/settingsDefinitions
 */

import { audioCleanupPage } from './sections/audioCleanupSection';
import { audioInputGroup } from './sections/audioInputSection';
import { audioPlayerPage } from './sections/audioPlayerSection';
import { audioProcessingPage } from './sections/audioProcessingSection';
import { audioSplittingPage } from './sections/audioSplittingSection';
import { autoChaptersGroup } from './sections/autoChaptersSection';
import {
	SETTINGS_ROOT_CLASS,
	type SettingsDefinitionContext,
} from './sections/context';
import { diagnosticsPage } from './sections/diagnosticsSection';
import { enginesPage } from './sections/enginesSection';
import { fileStorageGroup } from './sections/fileStorageSection';
import { llmGroup } from './sections/llmSection';
import { multiTrackPage } from './sections/multiTrackSection';
import { outputFormatGroup } from './sections/outputFormatSection';
import { sectionItems } from './sections/rowHelpers';
import { transcriptionAdvancedGroup } from './sections/transcriptionAdvancedSection';
import { transcriptionGroup } from './sections/transcriptionSection';
import { transcriptOutputGroup } from './sections/transcriptOutputSection';
import { enginesStatus, type PageStatus } from './settingsAttention';
import type { Setting, SettingDefinitionItem } from 'obsidian';

// Re-exported for the settings tab, which reads the whole surface through
// this module. Only what it actually reads is passed on: a name the tab does
// not take is imported from the module that owns it.
export {
	parseProfileControlKey,
	parseTrackControlKey,
	type TrackControlField,
} from './sections/controlKeys';

export {
	SETTINGS_BLOCK_ROW_CLASS,
	SETTINGS_ROOT_CLASS,
	SETTINGS_SECTION_CLASS,
	SETTINGS_TAB_CLASS,
	STACKED_TEXT_CLASS,
} from './sections/context';

export type {
	DiagnosticsActions,
	ProfileCatalogue,
	SettingsDefinitionContext,
} from './sections/context';

export {
	CONTROL_WRITE_EFFECTS,
	controlValue,
	numberControlRejection,
} from './controlValues';

/**
 * Builds the tab's definition tree.
 *
 * The callout and the entries below the blocks are rows rather than blocks, so
 * each run of them is declared as a block here: Obsidian would otherwise wrap
 * them in one of its own, which carries no class and would be left ruled
 * between every row (see {@link SETTINGS_SECTION_CLASS}).
 * @param ctx - The tab's remainder body and action handlers
 * @returns The definitions, in the order the tab renders them
 */
export function buildSettingsDefinitions(
	ctx: SettingsDefinitionContext,
): SettingDefinitionItem[] {
	return [
		...sectionItems([
			{
				name: 'Documentation',
				searchable: false,
				render: (setting: Setting): void => {
					const host = setting.settingEl;
					host.empty();
					host.addClass(SETTINGS_ROOT_CLASS);
					ctx.renderDocumentationLink(host);
				},
			},
		]),
		audioInputGroup(ctx.settings, ctx.devices, ctx.sampleRates),
		outputFormatGroup(ctx.outputFormat),
		fileStorageGroup(ctx.settings),
		...sectionItems([
			audioSplittingPage(ctx.settings),
			multiTrackPage(ctx.settings, ctx.devices),
			audioPlayerPage(ctx.settings),
			{
				// Forty-odd settings with a scope of their own: the style guide's
				// case for a sub-page, and it keeps the main tab scannable.
				type: 'page',
				name: 'Transcription',
				desc: 'Speech-to-text, transcript output, chapters, and LLM post-processing.',
				displayValue: (): string =>
					ctx.settings.transcriptionEnabled ? 'On' : 'Off',
				// Every engine a job calls is configured under this entry, so
				// it carries what the Engines entry inside it carries: an
				// indicator the user cannot follow inwards is worse than none.
				status: (): PageStatus => enginesStatus(ctx.settings),
				items: [
					// Each block holds what belongs to it, catalogues included:
					// nothing floats on the page beside the section it configures.
					transcriptionGroup(ctx, enginesPage(ctx)),
					transcriptOutputGroup(ctx.settings),
					autoChaptersGroup(ctx, 'chapters'),
					...llmGroup(ctx),
					transcriptionAdvancedGroup(ctx, 'advanced'),
				],
			},
			audioProcessingPage(ctx.settings),
			audioCleanupPage(ctx.settings),
			diagnosticsPage(ctx.diagnostics, ctx.settings),
		]),
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
