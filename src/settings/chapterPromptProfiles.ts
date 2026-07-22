/**
 * Pure helpers for the user-editable chapter guidance profiles. Each profile
 * is a named prompt describing how to divide a recording into chapters; the
 * user adds, edits, and removes profiles in the settings tab and picks one per
 * case. These functions are side-effect free (they return new arrays) so the
 * settings UI never mutates the stored array in place, and the run resolver
 * tolerates a selection that no longer exists.
 * @module settings/chapterPromptProfiles
 */

import type {
	AudioRecorderSettings,
	ChapterPromptProfile,
} from './settingsSchema';

/**
 * Builds a profile with a fresh id and empty guidance. The name is trimmed so a
 * stray-space name cannot masquerade as distinct from a trimmed one.
 * @param name - Display name for the profile
 * @returns A new profile with a unique id
 */
export function createChapterPromptProfile(name: string): ChapterPromptProfile {
	return { id: crypto.randomUUID(), name: name.trim(), prompt: '' };
}

/**
 * Removes the profile with the given id. Returns a copy without it (or an
 * unchanged copy when the id is absent).
 * @param profiles - Current profiles
 * @param id - Id of the profile to remove
 * @returns A new list without the profile
 */
export function removeChapterPromptProfile(
	profiles: ChapterPromptProfile[],
	id: string,
): ChapterPromptProfile[] {
	return profiles.filter((profile) => profile.id !== id);
}

/**
 * Finds a profile by id.
 * @param profiles - Current profiles
 * @param id - Id to look up
 * @returns The matching profile, or undefined
 */
export function findChapterPromptProfile(
	profiles: ChapterPromptProfile[],
	id: string,
): ChapterPromptProfile | undefined {
	return profiles.find((profile) => profile.id === id);
}

/**
 * Resolves the chapter guidance to append to the prompt for a run: the
 * selected profile's prompt, or an empty string when nothing is selected or
 * the stored id points to a removed profile. Returning '' is the single guard
 * that makes both "no guidance" and a stale selection safe, since
 * {@link buildChapterPrompt} appends no clause for empty guidance.
 * @param settings - The active settings (profiles plus the selected id)
 * @returns The selected profile's guidance, or '' when none applies
 */
export function resolveChapterGuidance(
	settings: Pick<
		AudioRecorderSettings,
		| 'transcriptionChapterPromptProfiles'
		| 'transcriptionChapterPromptProfileId'
	>,
): string {
	return (
		findChapterPromptProfile(
			settings.transcriptionChapterPromptProfiles,
			settings.transcriptionChapterPromptProfileId,
		)?.prompt ?? ''
	);
}
