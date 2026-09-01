/**
 * The two-pass mode that biases a second run on context mined from the first.
 * @module settings/sections/transcriptionAdvancedSection
 */

import {
	ADVANCED_SECOND_PASS_RATIO_STEP,
	MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
	MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
} from '../../constants';
import { LLM_JOBS } from '../../transcription/llm/vendors';
import type { ProfileSection } from '../profileKinds';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import { engineChoiceRow } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * The advanced transcription block: dictionary term biasing and the two-pass
 * mode, both behind a master switch that is off for a plain run.
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block whose profile catalogues belong here
 */
export function transcriptionAdvancedGroup(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const advanced = (): boolean =>
		settings.transcriptionEnabled &&
		settings.transcriptionAdvancedSettingsEnabled;
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Advanced',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Advanced settings',
				desc: 'Reveal dictionary term biasing and the experimental two-pass mode. Off by default: a recording then transcribes in a single plain pass.',
				control: {
					type: 'toggle',
					key: 'transcriptionAdvancedSettingsEnabled',
				},
			},
			{
				name: 'Advanced two-pass transcription (experimental)',
				desc: 'Transcribe twice: LLM agents mine the first draft for names and jargon, and the second pass re-decodes biased toward them. Roughly twice the engine cost and time, plus several LLM calls per file.',
				visible: advanced,
				control: {
					type: 'toggle',
					key: 'transcriptionAdvancedEnabled',
				},
			},
			engineChoiceRow(
				'Context agents engine',
				'Which engine the context agents call between the two passes. Set it up under Engines.',
				LLM_JOBS.contextAgents.key,
				(): boolean =>
					advanced() && settings.transcriptionAdvancedEnabled,
			),
			{
				name: 'Second-pass length safeguard',
				desc: 'Keep the second pass only when its text is at least this fraction of the first. A shorter biased decode lost content, so the run falls back.',
				visible: (): boolean =>
					advanced() && settings.transcriptionAdvancedEnabled,
				control: {
					type: 'number',
					key: 'advancedSecondPassMinRatio',
					min: MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
					max: MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
					step: ADVANCED_SECOND_PASS_RATIO_STEP,
				},
			},
			// The profiles this block owns, inside the block that gates them.
			...profileCatalogues(ctx, section),
		],
	};
}
