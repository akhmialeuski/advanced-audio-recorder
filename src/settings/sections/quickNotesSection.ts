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
import { engineChoiceRow, transcriptionEngineChoiceRow } from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

/**
 * Quick notes behind an entry of their own on the main tab: the switch, the
 * engine a dictation is transcribed with, the engine a profile rewrites it
 * with, and the profiles themselves.
 *
 * A feature with its own ribbon button is looked for by its own name, not
 * inside the page of the pipeline it happens to run through, so the entry
 * sits on the main tab. The two engines are picked here, each for its own
 * stage, because a dictation and a recording are different jobs and a vault
 * may want a different service for each. They are still set up under the
 * Transcription page, and the entry says so when that page is switched off
 * rather than leaving a switched-on feature with no button.
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
						desc: 'A dictation is transcribed through the engines set up under Transcription. Turn transcription on there, and the button and the command appear.',
						visible: waitingForTranscription,
					},
					transcriptionEngineChoiceRow(
						'Quick note transcription engine',
						'Which engine turns a dictation into text. It can differ from the one recordings are transcribed with. Set it up under Transcription > Engines.',
						'quickNoteTranscriptionProvider',
						available,
					),
					// Named for its stage: beside a transcription engine, a
					// bare "Quick note engine" read as the one that hears the
					// dictation, and offered services that cannot.
					engineChoiceRow(
						'Quick note rewrite engine',
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
