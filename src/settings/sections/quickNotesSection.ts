/**
 * Quick notes: dictation inserted at the cursor.
 * @module settings/sections/quickNotesSection
 */

import { LLM_JOBS } from '../../transcription/llm/vendors';
import { ProfileSection } from '../profileKinds';
import { quickNotesAvailable } from '../settingsSchema';
import { PageStatus, quickNoteRefusal } from '../settingsAttention';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import { engineChoiceRow } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/**
 * Quick notes behind an entry of their own on the main tab: the switch, the
 * engine a profile rewrites a dictation with, and the profiles themselves.
 *
 * A feature with its own ribbon button is looked for by its own name, not
 * inside the page of the pipeline it happens to run through, so the entry
 * sits on the main tab. A dictation is still transcribed by the engine the
 * Transcription page configures, and the entry says so when that page is
 * switched off rather than leaving a switched-on feature with no button.
 *
 * Every setting a dictation reads is here or on the Transcription page: the
 * button that starts one asks nothing, so there is nowhere else to put them.
 * @param ctx - Everything the tree reads from the tab
 */
export function quickNotesPage(
	ctx: SettingsDefinitionContext,
): SettingGroupItem {
	const settings = ctx.settings;
	const available = (): boolean => quickNotesAvailable(settings);
	const waitingForTranscription = (): boolean =>
		settings.quickNotesEnabled && !settings.transcriptionEnabled;
	return {
		type: 'page',
		name: 'Quick notes',
		desc: 'Dictation inserted at the cursor, optionally rewritten by an LLM profile.',
		displayValue: (): string => {
			if (available()) {
				return 'On';
			}
			return waitingForTranscription() ? 'Needs transcription' : 'Off';
		},
		// Set while a press would be refused, for the same reason the entry
		// of an engine with no key carries it: the explanation is one click in.
		status: (): PageStatus =>
			settings.quickNotesEnabled && quickNoteRefusal(settings) !== null
				? PageStatus.Warning
				: null,
		items: [
			{
				type: 'group',
				cls: SETTINGS_SECTION_CLASS,
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
					{
						name: 'Transcription is off',
						desc: 'A dictation is transcribed by the engine set up under Transcription. Turn transcription on there, and the button and the command appear.',
						visible: waitingForTranscription,
					},
					engineChoiceRow(
						'Quick note engine',
						'Which engine rewrites a dictation when a quick note profile is selected. Set it up under Transcription > Engines.',
						LLM_JOBS.quickNote.key,
						available,
					),
					...profileCatalogues(ctx, ProfileSection.QuickNotes),
				],
			},
		],
	};
}
