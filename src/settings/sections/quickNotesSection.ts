/**
 * Quick notes: dictation inserted at the cursor.
 * @module settings/sections/quickNotesSection
 */

import { LLM_JOBS } from '../../transcription/llm/vendors';
import { ProfileSection } from '../profileKinds';
import { quickNotesAvailable } from '../settingsSchema';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import { engineChoiceRow } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * The quick notes switch, the engine a profile rewrites a dictation with, and
 * the profiles themselves. The block lives on the transcription page because a
 * dictation is transcribed by the engine configured there, and it follows that
 * page's own switch for the same reason.
 *
 * Every setting a dictation reads is here or on the transcription page: the
 * button that starts one asks nothing, so there is nowhere else to put them.
 * @param ctx - Everything the tree reads from the tab
 */
export function quickNotesGroup(
	ctx: SettingsDefinitionContext,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const enabled = (): boolean => quickNotesAvailable(settings);
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Quick notes',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Enable quick notes',
				aliases: [
					'dictation',
					'dictate',
					'voice note',
					'speech to text',
				],
				desc: 'Add a ribbon button and a command that record a dictation and insert its text at the cursor. The audio is never saved.',
				control: { type: 'toggle', key: 'quickNotesEnabled' },
			},
			engineChoiceRow(
				'Quick note engine',
				'Which engine rewrites a dictation when a quick note profile is selected. Set it up under Engines.',
				LLM_JOBS.quickNote.key,
				enabled,
			),
			...profileCatalogues(ctx, ProfileSection.QuickNotes),
		],
	};
}
