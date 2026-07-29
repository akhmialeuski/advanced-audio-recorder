/**
 * Tests what is specific to the chapter-guidance profile kind: building a
 * profile and resolving the selected one's guidance for a run. Resolving must
 * return '' for no selection, a removed profile, or an empty list, since that
 * empty string is the single guard that makes buildChapterPrompt append no
 * guidance clause. The shared list mechanics are covered in profiles.test.
 * @module tests/unit/chapterPromptProfiles.test
 */

import {
	CHAPTER_PROMPT_PROFILES,
	createChapterPromptProfile,
	resolveChapterGuidance,
} from 'src/settings/chapterPromptProfiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { ChapterPromptProfile } from 'src/settings/settingsSchema';

describe('createChapterPromptProfile', () => {
	it('assigns a fresh id, trims the name, and starts with an empty prompt', () => {
		const profile = createChapterPromptProfile('  Meeting  ');
		expect(profile.name).toBe('Meeting');
		expect(profile.prompt).toBe('');
		expect(profile.id).toMatch(/[0-9a-f-]{36}/);
	});
});

describe('resolveChapterGuidance', () => {
	const profiles: ChapterPromptProfile[] = [
		{ id: 'a', name: 'Agenda', prompt: 'Split by agenda item.' },
	];

	/** Settings holding the given profiles and selection. */
	const withSelection = (id: string, list = profiles) =>
		mergeSettings({
			transcriptionChapterPromptProfiles: list,
			transcriptionChapterPromptProfileId: id,
		});

	it("returns the selected profile's guidance", () => {
		expect(resolveChapterGuidance(withSelection('a'))).toBe(
			'Split by agenda item.',
		);
	});

	it('returns empty for no selection', () => {
		expect(resolveChapterGuidance(withSelection(''))).toBe('');
	});

	it('returns empty for a stale selection that was removed', () => {
		expect(resolveChapterGuidance(withSelection('gone'))).toBe('');
	});

	it('returns empty for an empty profile list', () => {
		expect(resolveChapterGuidance(withSelection('a', []))).toBe('');
	});

	it('is bound to the settings fields the descriptor names', () => {
		const settings = withSelection('a');
		expect(CHAPTER_PROMPT_PROFILES.get(settings)).toEqual(profiles);
		expect(CHAPTER_PROMPT_PROFILES.selectedId(settings)).toBe('a');
	});
});
