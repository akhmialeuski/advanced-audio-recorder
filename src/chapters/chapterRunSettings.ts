/**
 * The choices one chapter generation is made with - the guidance profile, the
 * engine, and that engine's model - and how they become the stored defaults.
 *
 * The chapter service reads all three from the plugin settings, so a run made
 * with other choices writes them there first. The dialog and the command line
 * both go through here, which is what keeps "the run used this model" and
 * "the next run defaults to this model" one fact rather than two that a
 * second surface could let drift apart.
 * @module chapters/chapterRunSettings
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	ProfileKindId,
	profileIdNamed,
	selectedProfileId,
	setSelectedProfileId,
} from '../settings/profiles';
import { ensureSelectedInList } from '../settings/modelList';
import { vendorEngine } from '../providers/providers';
import { applyEngineSettings } from '../providers/engineSettings';
import {
	jobLlmVendor,
	LLM_VENDOR_IDS,
	LlmJobId,
} from '../transcription/llm/vendors';

/** The job these choices configure. */
const CHAPTERS_JOB = LlmJobId.AutoChapters;

/**
 * Writes a run's choices into the live settings: the engine chapters are
 * generated with, that engine's model, and the guidance profile.
 *
 * Only that engine's model is committed, so an engine the dialog was merely
 * switched through keeps the id it had. The engine that actually ran is a
 * different matter: where it serves one catalogue for both jobs, the model
 * committed here is the one transcription reads, which is what the engine row
 * says before the choice is made rather than after.
 * @param live - The plugin's settings, updated in place
 * @param run - The run's copy holding the choices
 */
export function commitChapterRunSettings(
	live: AudioRecorderSettings,
	run: AudioRecorderSettings,
): void {
	live.chaptersLlmProvider = run.chaptersLlmProvider;
	const vendor = jobLlmVendor(run, CHAPTERS_JOB);
	applyEngineSettings(live, vendorEngine(vendor.id).id, {
		model: vendor.settings.model(run),
	});
	setSelectedProfileId(
		live,
		ProfileKindId.ChapterPrompt,
		selectedProfileId(run, ProfileKindId.ChapterPrompt),
	);
}

/** Choices typed for one run, each optional. */
export interface ChapterRunChoices {
	/** Guidance profile name, or `none` for the base prompt alone. */
	readonly profile?: string | null;
	/** Engine id. */
	readonly llm?: string | null;
	/** Model id of that engine. */
	readonly model?: string | null;
}

/**
 * Applies typed choices to a run's copy of the settings, checking each against
 * what the dialog would have offered: a profile of the chapter kind, an engine
 * that answers prompts, a model in that engine's list.
 * @param run - The run's copy, updated in place
 * @param choices - What was typed
 * @returns Null once applied, or the sentence naming what is not offered
 */
export function applyChapterRunChoices(
	run: AudioRecorderSettings,
	choices: ChapterRunChoices,
): string | null {
	if (choices.profile) {
		const picked = profileIdNamed(
			run.profiles,
			ProfileKindId.ChapterPrompt,
			choices.profile,
		);
		if ('refusal' in picked) {
			return picked.refusal;
		}
		setSelectedProfileId(run, ProfileKindId.ChapterPrompt, picked.id);
	}
	if (choices.llm) {
		const llm = LLM_VENDOR_IDS.find((id) => id === choices.llm);
		if (!llm) {
			return `llm=${choices.llm} is not one of: ${LLM_VENDOR_IDS.join(', ')}.`;
		}
		run.chaptersLlmProvider = llm;
	}
	if (choices.model) {
		const vendor = jobLlmVendor(run, CHAPTERS_JOB);
		const models = ensureSelectedInList(
			vendor.settings.models(run),
			vendor.settings.model(run),
		);
		if (!models.includes(choices.model)) {
			return `model=${choices.model} is not in the ${vendor.label} model list: ${models.join(', ')}.`;
		}
		applyEngineSettings(run, vendorEngine(vendor.id).id, {
			model: choices.model,
		});
	}
	return null;
}
