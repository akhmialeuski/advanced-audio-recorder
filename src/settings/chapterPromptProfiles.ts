/**
 * The chapter-guidance profile list: named prompts describing how to divide a
 * recording into chapters. The list mechanics come from the shared profile
 * module; this file only describes where the list lives and how a run resolves
 * its guidance.
 * @module settings/chapterPromptProfiles
 */

import type {
	AudioRecorderSettings,
	ChapterPromptProfile,
} from './settingsSchema';
import { selectedProfile, type ProfileList } from './profiles';

/**
 * Builds a profile with a fresh id and empty guidance. The name is trimmed so a
 * stray-space name cannot masquerade as distinct from a trimmed one.
 * @param name - Display name for the profile
 * @returns A new profile with a unique id
 */
export function createChapterPromptProfile(name: string): ChapterPromptProfile {
	return { id: crypto.randomUUID(), name: name.trim(), prompt: '' };
}

/** Where the chapter guidance profiles and their selection live in settings. */
export const CHAPTER_PROMPT_PROFILES: ProfileList<ChapterPromptProfile> = {
	get: (s) => s.transcriptionChapterPromptProfiles,
	set: (s, profiles) => (s.transcriptionChapterPromptProfiles = profiles),
	selectedId: (s) => s.transcriptionChapterPromptProfileId,
	setSelectedId: (s, id) => (s.transcriptionChapterPromptProfileId = id),
	create: createChapterPromptProfile,
};

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
	settings: AudioRecorderSettings,
): string {
	return selectedProfile(CHAPTER_PROMPT_PROFILES, settings)?.prompt ?? '';
}
