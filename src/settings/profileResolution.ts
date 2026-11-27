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
import { LlmTask } from '../transcription/llmPostProcess';
import {
	findProfile,
	profilesOfKind,
	selectedProfile,
	type Profile,
	ProfileKindId,
} from './profiles';
import { parseDictionary } from '../transcription/dictionary';
import {
	formatParticipantBody,
	mergeParticipantNames,
	parseParticipantBody,
} from '../speakers/participantRoster';

/** The kind of profile holding the prompt for each post-processing task. */
export const PROMPT_KIND_OF_TASK: Record<LlmTask, ProfileKindId> = {
	[LlmTask.Cleanup]: ProfileKindId.LlmCleanup,
	[LlmTask.Summary]: ProfileKindId.LlmSummary,
	[LlmTask.Custom]: ProfileKindId.LlmCustom,
	[LlmTask.Translate]: ProfileKindId.LlmTranslate,
	[LlmTask.Template]: ProfileKindId.LlmTemplate,
};

/**
 * The kinds of prompt profile a part of a note template may name with
 * `profile="..."`, in the order a name is looked up in: an instruction written
 * for one part is a custom instruction first, then a summary or cleanup prompt
 * kept for those tasks.
 */
export const PART_PROFILE_KINDS: readonly ProfileKindId[] = [
	ProfileKindId.LlmCustom,
	ProfileKindId.LlmSummary,
	ProfileKindId.LlmCleanup,
];

/**
 * The prompt profile a part of a note template names.
 * @param profiles - Every stored profile
 * @param name - The name the part gives, matched as typed and trimmed
 * @returns The first profile of {@link PART_PROFILE_KINDS} by that name
 */
export function findPartProfile(
	profiles: readonly Profile[],
	name: string,
): Profile | undefined {
	const wanted = name.trim();
	for (const kind of PART_PROFILE_KINDS) {
		const found = profilesOfKind(profiles, kind).find(
			(profile) => profile.name === wanted,
		);
		if (found) {
			return found;
		}
	}
	return undefined;
}

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
 * Resolves the run's effective dictionary terms as a clean, de-duplicated list.
 * The single source of the terms a run biases toward: the single-pass
 * dictionary plan, the advanced two-pass context candidates, and the LLM
 * cleanup hint all read from here, so the same profile drives every term-aware
 * stage and there is no second, parallel glossary to keep in sync. The
 * dictionary lives under the advanced settings, so this returns an empty list
 * whenever that master switch is off - a plain run applies no term biasing.
 *
 * A body of '' is what makes both "None" and a selection naming a removed
 * profile safe, since {@link parseDictionary} reads it as no terms at all.
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
	return parseDictionary(selectedBody(settings, ProfileKindId.Dictionary));
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
	return selectedBody(settings, ProfileKindId.ChapterPrompt);
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
 * Resolves the instruction a dictated quick note is rewritten with: the
 * selected profile's body, or '' when none is selected or the stored id points
 * at a removed profile. Unlike a post-processing task, '' here means the text
 * is inserted as it was recognized, since quick notes ship no default prompt.
 * @param settings - The active settings
 * @returns The selected profile's instruction, or '' for none
 */
export function resolveQuickNotePrompt(
	settings: AudioRecorderSettings,
): string {
	return selectedBody(settings, ProfileKindId.QuickNote).trim();
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
	return parseParticipantBody(
		selectedBody(settings, ProfileKindId.Participants),
	);
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
		profilesOfKind(settings.profiles, ProfileKindId.Participants),
		id,
	);
	return profile ? parseParticipantBody(profile.body) : [];
}

/**
 * Adds names to a profile's roster, skipping ones already present, so names
 * applied in the rename dialog become suggestions next time. Nothing to add is
 * answered with undefined rather than with a list, because a copy of the input
 * is indistinguishable from a grown roster by anything a caller can compare:
 * the one question a caller has is whether there is something to persist, and
 * the return value answers exactly that.
 * @param profiles - All stored profiles
 * @param id - Id of the profile to extend
 * @param names - Names to add
 * @returns A new list with that profile's roster extended, or undefined when
 *   the id names no participant profile or every name was already there
 */
export function addParticipantsToProfile(
	profiles: readonly Profile[],
	id: string,
	names: readonly string[],
): Profile[] | undefined {
	const target = findProfile(profiles, id);
	if (!target || target.kind !== ProfileKindId.Participants) {
		return undefined;
	}
	const current = parseParticipantBody(target.body);
	const merged = mergeParticipantNames(current, names);
	// A merge that added nothing comes back the same length, and a roster that
	// did not grow is nothing to write.
	if (merged.length === current.length) {
		return undefined;
	}
	return profiles.map((profile) =>
		profile.id === id
			? { ...profile, body: formatParticipantBody(merged) }
			: profile,
	);
}

/**
 * The dictionary profile with the terms added after its own, each on a line
 * of its own, so the text typed for it stays as it was. The terms go through
 * {@link parseDictionary} with the profile's own, so a term it already holds
 * in any case, a repeat or a blank adds nothing.
 * @param profiles - All stored profiles
 * @param id - Id of the dictionary profile to extend
 * @param terms - Terms to add
 * @returns A new list with that profile's terms extended, or undefined when
 *   the id names no dictionary profile or every term was already there
 */
export function addTermsToProfile(
	profiles: readonly Profile[],
	id: string,
	terms: readonly string[],
): Profile[] | undefined {
	const target = findProfile(profiles, id);
	if (target?.kind !== ProfileKindId.Dictionary) {
		return undefined;
	}
	const fresh = newDictionaryTerms(target.body, terms);
	if (fresh.length === 0) {
		return undefined;
	}
	const text = target.body.trimEnd();
	const body = `${text}${text === '' ? '' : '\n'}${fresh.join('\n')}`;
	return profiles.map((profile) =>
		profile.id === id ? { ...profile, body } : profile,
	);
}

/**
 * The terms a dictionary's text does not hold yet, without regard to case.
 * @param body - The dictionary's text
 * @param terms - Terms to add
 */
export function newDictionaryTerms(
	body: string,
	terms: readonly string[],
): string[] {
	const current = parseDictionary(body);
	return parseDictionary([body, ...terms].join('\n')).slice(current.length);
}
