/**
 * Tests the pure chapter-guidance profile helpers: creating a profile with a
 * fresh id, removing and finding by id, and resolving the selected profile's
 * guidance for a run. Resolving must return '' for no selection, a removed
 * profile, or an empty list, since that empty string is the single guard that
 * makes buildChapterPrompt append no guidance clause.
 * @module tests/unit/chapterPromptProfiles.test
 */

import {
	createChapterPromptProfile,
	findChapterPromptProfile,
	removeChapterPromptProfile,
	resolveChapterGuidance,
} from 'src/settings/chapterPromptProfiles';
import type { ChapterPromptProfile } from 'src/settings/settingsSchema';

describe('createChapterPromptProfile', () => {
	it('assigns a fresh id, trims the name, and starts with an empty prompt', () => {
		const profile = createChapterPromptProfile('  Meeting  ');
		expect(profile.name).toBe('Meeting');
		expect(profile.prompt).toBe('');
		expect(profile.id).toMatch(/[0-9a-f-]{36}/);
	});

	it('gives distinct ids to same-named profiles', () => {
		const a = createChapterPromptProfile('Lecture');
		const b = createChapterPromptProfile('Lecture');
		expect(a.id).not.toBe(b.id);
	});
});

describe('removeChapterPromptProfile', () => {
	it('drops the profile with the id and leaves the rest untouched', () => {
		const profiles: ChapterPromptProfile[] = [
			{ id: 'a', name: 'A', prompt: 'x' },
			{ id: 'b', name: 'B', prompt: 'y' },
		];
		expect(removeChapterPromptProfile(profiles, 'a')).toEqual([
			{ id: 'b', name: 'B', prompt: 'y' },
		]);
	});

	it('returns an unchanged copy when the id is absent', () => {
		const profiles: ChapterPromptProfile[] = [
			{ id: 'a', name: 'A', prompt: 'x' },
		];
		const next = removeChapterPromptProfile(profiles, 'missing');
		expect(next).toEqual(profiles);
		expect(next).not.toBe(profiles);
	});
});

describe('findChapterPromptProfile', () => {
	it('returns the matching profile or undefined', () => {
		const profiles: ChapterPromptProfile[] = [
			{ id: 'a', name: 'A', prompt: 'x' },
		];
		expect(findChapterPromptProfile(profiles, 'a')?.name).toBe('A');
		expect(findChapterPromptProfile(profiles, 'z')).toBeUndefined();
	});
});

describe('resolveChapterGuidance', () => {
	const profiles: ChapterPromptProfile[] = [
		{ id: 'a', name: 'Agenda', prompt: 'Split by agenda item.' },
	];

	it("returns the selected profile's guidance", () => {
		expect(
			resolveChapterGuidance({
				transcriptionChapterPromptProfiles: profiles,
				transcriptionChapterPromptProfileId: 'a',
			}),
		).toBe('Split by agenda item.');
	});

	it('returns empty for no selection', () => {
		expect(
			resolveChapterGuidance({
				transcriptionChapterPromptProfiles: profiles,
				transcriptionChapterPromptProfileId: '',
			}),
		).toBe('');
	});

	it('returns empty for a stale selection that was removed', () => {
		expect(
			resolveChapterGuidance({
				transcriptionChapterPromptProfiles: profiles,
				transcriptionChapterPromptProfileId: 'gone',
			}),
		).toBe('');
	});
});
