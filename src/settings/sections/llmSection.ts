/**
 * Post-processing a transcript with a language model.
 * @module settings/sections/llmSection
 */

import { LLM_JOBS } from '../../transcription/llm/vendors';
import { LLM_TASK_LABELS } from '../labels';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
} from './context';
import { profileCatalogues } from './profilesSection';
import { engineChoiceRow } from './rowHelpers';
import type { SettingDefinitionItem } from 'obsidian';

/**
 * LLM post-processing: the switch, the engine that writes it, and the task and
 * prompt profiles that steer it. Nothing here is shared with the other two LLM
 * jobs any more - each names its own engine beside its own switch - so the rows
 * follow this feature alone.
 *
 * The prompt is a catalogue rather than a field: each task keeps its own named
 * prompts, so a standup and a client call are two profiles instead of one text
 * area rewritten between runs. The task decides which catalogue is shown, so
 * the block always holds exactly the prompts being chosen between.
 * @param ctx - Everything the tree reads from the tab
 */
export function llmGroup(
	ctx: SettingsDefinitionContext,
): SettingDefinitionItem[] {
	const settings = ctx.settings;
	const postProcessing = (): boolean =>
		settings.transcriptionEnabled && settings.llmPostProcessEnabled;
	return [
		{
			type: 'group',
			cls: SETTINGS_SECTION_CLASS,
			heading: 'LLM post-processing',
			visible: (): boolean => settings.transcriptionEnabled,
			items: [
				{
					name: 'Enable LLM post-processing',
					aliases: ['ai', 'summary', 'cleanup', 'gpt'],
					desc: 'Clean up punctuation and formatting, or summarize the transcript with an LLM.',
					control: { type: 'toggle', key: 'llmPostProcessEnabled' },
				},
				engineChoiceRow(
					'Post-processing engine',
					'Which engine writes the post-processed transcript. Set it up under Engines.',
					LLM_JOBS.postProcess.key,
					postProcessing,
				),
				{
					name: 'Task',
					desc: 'Clean up, summarize into key points, or apply a custom instruction.',
					visible: postProcessing,
					control: {
						type: 'dropdown',
						key: 'llmPostProcessTask',
						options: LLM_TASK_LABELS,
					},
				},
				// The prompt profiles of whichever task is selected: each kind
				// answers the task itself, so this is one entry, not a branch.
				...profileCatalogues(ctx, 'llm'),
			],
		},
	];
}
