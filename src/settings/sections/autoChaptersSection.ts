/**
 * Chapters generated from a transcript on demand.
 * @module settings/sections/autoChaptersSection
 */

import { LLM_JOBS } from '../../transcription/llm/vendors';
import type { ProfileSection } from '../profileKinds';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import { engineChoiceRow, transcriptionPageActive } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * LLM-generated chapters, and the guidance profiles they use.
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block whose profile catalogues belong here
 */
export function autoChaptersGroup(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingDefinitionItem {
	const settings = ctx.settings;
	// The block follows its own switch, not transcription's: the chapters action
	// is offered on a recording that already has a transcript, so it outlives
	// transcription being turned off and its engine still has to be configurable.
	const enabled = (): boolean => settings.transcriptionAutoChaptersEnabled;
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Auto chapters',
		visible: (): boolean => transcriptionPageActive(settings),
		items: [
			{
				name: 'Auto chapters',
				aliases: ['sections', 'headings'],
				desc: 'Add an action that asks the LLM to divide a transcribed recording into titled chapters, shown in the enhanced player.',
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersEnabled',
				},
			},
			engineChoiceRow(
				'Chapters engine',
				'Which engine divides a transcript into chapters. Set it up under Engines.',
				LLM_JOBS.autoChapters.key,
				enabled,
			),
			{
				name: 'Generate after transcription',
				// The one row here that does need transcription: there is no
				// run for it to follow when nothing transcribes.
				desc: 'Generate chapters each time a recording is transcribed.',
				visible: (): boolean =>
					enabled() && settings.transcriptionEnabled,
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersOnTranscribe',
				},
			},
			// The profiles this block owns, inside the block that gates them.
			...profileCatalogues(ctx, section),
		],
	};
}
