/**
 * What a run makes of the profiles in use.
 *
 * A profile stores one body of text whatever kind it is, and every kind reads
 * that body its own way: a glossary parses terms out of it, a roster parses
 * names, a prompt is the text itself. That reading is what a run needs and the
 * editor does not, so it lives here rather than in the storage model
 * ({@link module:settings/profiles}) or in the descriptors the settings show
 * ({@link module:settings/profileKinds}).
 *
 * Every resolver answers a missing selection and a stale one the same way -
 * with the empty result its caller treats as "no profile applies" - so "None"
 * needs no branch of its own anywhere downstream.
 * @module settings/profileResolution
 */

import type { AudioRecorderSettings } from './settingsSchema';
import type { LlmTask } from '../transcription/llmPostProcess';
import {
	findProfile,
	profilesOfKind,
	selectedProfile,
	type Profile,
	type ProfileKindId,
} from './profiles';
import { parseDictionary } from '../transcription/dictionary';
import {
	formatParticipantBody,
	mergeParticipantNames,
	parseParticipantBody,
} from '../speakers/participantRoster';

/** The kind of profile holding the prompt for each post-processing task. */
const PROMPT_KIND_OF_TASK: Record<LlmTask, ProfileKindId> = {
	cleanup: 'llmCleanup',
	summary: 'llmSummary',
	custom: 'llmCustom',
};

/**
 * The body of the profile a kind applies, or '' when none does. The one guard
 * every resolver below is built on.
 * @param settings - The active settings
 * @param kind - Kind being resolved
 * @returns The selected profile's body, or ''
 */
function selectedBody(
	settings: AudioRecorderSettings,
	kind: ProfileKindId,
): string {
	return selectedProfile(settings, kind)?.body ?? '';
}

/**
 * Resolves the raw dictionary text to bias with for a run: the selected
 * profile's terms, or an empty string when nothing is selected or the stored id
 * points to a removed profile. Returning '' is what makes both "None" and a
 * stale selection safe, since the downstream pipeline
 * ({@link parseDictionary} then planDictionaryBias) treats '' as no terms.
 * @param settings - The active settings
 * @returns The selected profile's terms, or '' when none applies
 */
export function resolveDictionaryTerms(
	settings: AudioRecorderSettings,
): string {
	return selectedBody(settings, 'dictionary');
}

/**
 * Resolves the run's effective dictionary terms as a clean, de-duplicated list.
 * The single source of the terms a run biases toward: the single-pass
 * dictionary plan, the advanced two-pass context candidates, and the LLM
 * cleanup hint all read from here, so the same profile drives every term-aware
 * stage and there is no second, parallel glossary to keep in sync. The
 * dictionary lives under the advanced settings, so this returns an empty list
 * whenever that master switch is off - a plain run applies no term biasing.
 * @param settings - The active settings (the advanced switch and the profiles)
 * @returns The selected profile's terms, de-duplicated; empty when the advanced
 *   settings are off, none is selected, or the selected profile is gone
 */
export function resolveDictionaryTermList(
	settings: AudioRecorderSettings,
): string[] {
	if (!settings.transcriptionAdvancedSettingsEnabled) {
		return [];
	}
	return parseDictionary(resolveDictionaryTerms(settings));
}

/**
 * Resolves the chapter guidance to append to the prompt for a run: the
 * selected profile's prompt, or an empty string when nothing is selected or
 * the stored id points to a removed profile, since
 * {@link buildChapterPrompt} appends no clause for empty guidance.
 * @param settings - The active settings
 * @returns The selected profile's guidance, or '' when none applies
 */
export function resolveChapterGuidance(
	settings: AudioRecorderSettings,
): string {
	return selectedBody(settings, 'chapterPrompt');
}

/**
 * Resolves the system prompt for a post-processing task: the selected
 * profile's body, or '' when none is selected or the stored id points at a
 * removed profile. '' is what the prompt builder reads as "use the built-in
 * default", so a task always has a prompt to run with.
 * @param settings - The active settings
 * @param task - The post-processing task being prepared
 * @returns The selected profile's prompt, or '' for the built-in default
 */
export function resolveLlmPrompt(
	settings: AudioRecorderSettings,
	task: LlmTask,
): string {
	return selectedBody(settings, PROMPT_KIND_OF_TASK[task]);
}

/**
 * The participant names a transcription run carries into the recording's
 * sidecar: those of the selected profile, or an empty list when none is
 * selected or the stored id points at a removed profile.
 * @param settings - The active settings
 * @returns The selected profile's participants, or an empty list
 */
export function resolveRunParticipants(
	settings: AudioRecorderSettings,
): string[] {
	return parseParticipantBody(selectedBody(settings, 'participants'));
}

/**
 * The participants a profile offers as suggestions, or an empty list when the
 * id names no participant profile.
 * @param settings - The active settings
 * @param id - Id of the profile feeding the suggestions ('' means none)
 * @returns The profile's participant names
 */
export function participantsOf(
	settings: AudioRecorderSettings,
	id: string,
): string[] {
	const profile = findProfile(
		profilesOfKind(settings.profiles, 'participants'),
		id,
	);
	return profile ? parseParticipantBody(profile.body) : [];
}

/**
 * Adds names to a profile's roster, skipping ones already present, so names
 * applied in the rename dialog become suggestions next time. Returns the
 * profiles unchanged (a copy) when the id names no participant profile or
 * nothing new was added, so callers can compare references to decide whether
 * to persist.
 * @param profiles - All stored profiles
 * @param id - Id of the profile to extend
 * @param names - Names to add
 * @returns A new list with that profile's roster extended
 */
export function addParticipantsToProfile(
	profiles: readonly Profile[],
	id: string,
	names: readonly string[],
): Profile[] {
	const target = findProfile(profiles, id);
	if (!target || target.kind !== 'participants') {
		return [...profiles];
	}
	const current = parseParticipantBody(target.body);
	const merged = mergeParticipantNames(current, names);
	// A merge that added nothing comes back the same length; returning a copy
	// then lets the caller skip the settings save on a reference comparison.
	if (merged.length === current.length) {
		return [...profiles];
	}
	return profiles.map((profile) =>
		profile.id === id
			? { ...profile, body: formatParticipantBody(merged) }
			: profile,
	);
}
