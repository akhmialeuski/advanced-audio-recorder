/**
 * The rows of the transcription dialog that pick the prompt profile, or the
 * note template and where its note goes, of the post-processing task chosen
 * for the run.
 *
 * Which summary prompt or which template suits a recording is a choice made
 * per recording as often as once in the settings: a daily sync and a lecture
 * go through the same task and want different templates. The row offers the
 * profiles of the task's own kind, under the name the settings give that
 * kind's selection, so the two read as the same choice.
 * @module ui/taskProfilePicker
 */

import type { ProfileTextSource } from '../settings/ProfileTextSource';
import { PROFILE_KINDS } from '../settings/profileKinds';
import { PROMPT_KIND_OF_TASK } from '../settings/profileResolution';
import { TEMPLATE_OUTPUT_OPTIONS } from '../settings/labels';
import type { TemplateOutput } from '../transcription/llmPostProcess';
import {
	ProfileKindId,
	profilesOfKind,
	selectedProfile,
	selectedProfileId,
	setSelectedProfileId,
} from '../settings/profiles';
import {
	addDropdown,
	type SettingsSectionContext,
} from '../settings/settingControls';

/** What the row reports a pick to, so it is remembered for the next run. */
export type ProfilePicked = (kind: ProfileKindId, id: string) => void;

/**
 * Adds the row picking the profile of the run's post-processing task.
 * @param ctx - The dialog's controls, over the run's settings
 * @param profileText - Says where the picked profile's text comes from
 * @param onPicked - Told of each pick
 */
export function addTaskProfilePicker(
	ctx: SettingsSectionContext,
	profileText: ProfileTextSource,
	onPicked: ProfilePicked,
): void {
	const s = ctx.settings;
	const kindId = PROMPT_KIND_OF_TASK[s.llmPostProcessTask];
	const kind = PROFILE_KINDS.find((candidate) => candidate.id === kindId);
	if (!kind) {
		return;
	}
	addDropdown(ctx, {
		name: kind.selectionName,
		desc: profileText.status(selectedProfile(s, kindId)),
		options: [
			{ value: '', label: 'None' },
			...profilesOfKind(s.profiles, kindId).map((profile) => ({
				value: profile.id,
				label: profile.name,
			})),
		],
		get: () => selectedProfileId(s, kindId),
		set: (id) => {
			setSelectedProfileId(s, kindId, id);
			onPicked(kindId, id);
		},
		// Drawn again so the line naming the profile's text and the estimate,
		// which counts a template's calls, follow the pick.
		rerender: true,
	});
	if (kindId === ProfileKindId.LlmTemplate) {
		// For this run only, as the destination row above is.
		addDropdown(ctx, {
			name: 'Template output',
			options: TEMPLATE_OUTPUT_OPTIONS,
			get: () => s.llmTemplateOutput,
			set: (value) => (s.llmTemplateOutput = value as TemplateOutput),
		});
	}
}
