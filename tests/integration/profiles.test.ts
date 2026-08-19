/**
 * Tests the shared profile-list machinery once, and then runs the same
 * behavioural contract against every profile list in the plugin. The three
 * kinds (dictionary glossaries, chapter guidance prompts, participant rosters)
 * used to carry three copies of this logic with three naming conventions; these
 * tests are what keep them on one implementation.
 * @module tests/unit/profiles.test
 */

import {
	addAndSelectProfile,
	addProfile,
	editingProfileId,
	effectiveProfileId,
	findProfile,
	moveProfile,
	removeAndReselectProfile,
	removeProfile,
	selectedProfile,
	type Profile,
	type ProfileList,
} from 'src/settings/profiles';
import { DICTIONARY_PROFILES } from 'src/settings/dictionaryProfiles';
import { CHAPTER_PROMPT_PROFILES } from 'src/settings/chapterPromptProfiles';
import { SPEAKER_PROFILES } from 'src/settings/speakerProfiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** A minimal profile list, so the generic helpers are tested on their own. */
interface Simple extends Profile {
	body: string;
}

const simple = (id: string, name: string): Simple => ({ id, name, body: '' });

describe('profile list helpers', () => {
	describe('addProfile', () => {
		it('appends a named profile', () => {
			const next = addProfile([], simple('a', 'Standup'));
			expect(next).toHaveLength(1);
			expect(next[0]?.name).toBe('Standup');
		});

		it('is a no-op for a blank name', () => {
			expect(addProfile([simple('a', 'A')], simple('b', ''))).toEqual([
				simple('a', 'A'),
			]);
		});

		it('allows two profiles with the same name (distinct ids)', () => {
			const next = addProfile(
				addProfile([], simple('a', 'Legal')),
				simple('b', 'Legal'),
			);
			expect(next).toHaveLength(2);
			expect(next[0]?.id).not.toBe(next[1]?.id);
		});
	});

	describe('removeProfile', () => {
		const profiles = [simple('a', 'A'), simple('b', 'B')];

		it('removes the profile with the given id', () => {
			expect(removeProfile(profiles, 'a')).toEqual([simple('b', 'B')]);
		});

		it('returns an unchanged copy for an absent id', () => {
			const next = removeProfile(profiles, 'missing');
			expect(next).toEqual(profiles);
			expect(next).not.toBe(profiles);
		});
	});

	describe('moveProfile', () => {
		const profiles = [simple('a', 'A'), simple('b', 'B'), simple('c', 'C')];

		it('moves a profile down to the dropped position', () => {
			expect(
				moveProfile(profiles, 0, 2).map((profile) => profile.id),
			).toEqual(['b', 'c', 'a']);
		});

		it('moves a profile up to the dropped position', () => {
			expect(
				moveProfile(profiles, 2, 0).map((profile) => profile.id),
			).toEqual(['c', 'a', 'b']);
		});

		it('leaves the order alone for a drop on the same position', () => {
			expect(
				moveProfile(profiles, 1, 1).map((profile) => profile.id),
			).toEqual(['a', 'b', 'c']);
		});

		it.each([
			['a source outside the list', 3, 0],
			['a target outside the list', 0, 3],
			['a negative index', -1, 0],
		])('leaves the order alone for %s', (_case, from, to) => {
			expect(moveProfile(profiles, from, to).map((p) => p.id)).toEqual([
				'a',
				'b',
				'c',
			]);
		});

		it('returns a copy rather than reordering in place', () => {
			const next = moveProfile(profiles, 0, 1);
			expect(next).not.toBe(profiles);
			expect(profiles.map((profile) => profile.id)).toEqual([
				'a',
				'b',
				'c',
			]);
		});
	});

	describe('findProfile', () => {
		it('returns the matching profile or undefined', () => {
			const profiles = [simple('a', 'A')];
			expect(findProfile(profiles, 'a')?.name).toBe('A');
			expect(findProfile(profiles, 'z')).toBeUndefined();
		});
	});

	describe('effectiveProfileId', () => {
		const profiles = [simple('a', 'A')];

		it('keeps an id that still names a profile', () => {
			expect(effectiveProfileId(profiles, 'a')).toBe('a');
		});

		it('reports no selection for a stale or empty id', () => {
			expect(effectiveProfileId(profiles, 'gone')).toBe('');
			expect(effectiveProfileId(profiles, '')).toBe('');
			expect(effectiveProfileId([], 'a')).toBe('');
		});
	});

	describe('editingProfileId', () => {
		const profiles = [simple('a', 'A'), simple('b', 'B')];

		it('edits the stored selection when it resolves', () => {
			expect(editingProfileId(profiles, 'b')).toBe('b');
		});

		it('falls back to the first profile without changing a stored none', () => {
			expect(editingProfileId(profiles, '')).toBe('a');
			expect(editingProfileId(profiles, 'gone')).toBe('a');
		});

		it('has nothing to edit for an empty list', () => {
			expect(editingProfileId([], 'a')).toBe('');
		});
	});
});

/** The lists to run the shared contract against, with a persisted selection. */
const SELECTABLE_LISTS: [string, ProfileList<Profile>][] = [
	['dictionary', DICTIONARY_PROFILES],
	['chapter guidance', CHAPTER_PROMPT_PROFILES],
];

describe.each(SELECTABLE_LISTS)('%s profile list', (_name, list) => {
	let settings: AudioRecorderSettings;

	beforeEach(() => {
		settings = mergeSettings();
		list.set(settings, []);
		list.setSelectedId(settings, '');
	});

	it('adds a profile and selects it', () => {
		const created = addAndSelectProfile(list, settings, 'Standup');
		expect(created?.name).toBe('Standup');
		expect(list.get(settings)).toHaveLength(1);
		expect(list.selectedId(settings)).toBe(created?.id);
		expect(selectedProfile(list, settings)).toEqual(created);
	});

	it('refuses a blank name and leaves the list untouched', () => {
		expect(addAndSelectProfile(list, settings, '   ')).toBeUndefined();
		expect(list.get(settings)).toEqual([]);
		expect(list.selectedId(settings)).toBe('');
	});

	it('reselects the first remaining profile after a removal', () => {
		const first = addAndSelectProfile(list, settings, 'First');
		const second = addAndSelectProfile(list, settings, 'Second');
		removeAndReselectProfile(list, settings, second?.id ?? '');
		expect(list.get(settings)).toHaveLength(1);
		expect(list.selectedId(settings)).toBe(first?.id);
	});

	it('falls back to no selection when the last profile is removed', () => {
		const only = addAndSelectProfile(list, settings, 'Only');
		removeAndReselectProfile(list, settings, only?.id ?? '');
		expect(list.get(settings)).toEqual([]);
		expect(list.selectedId(settings)).toBe('');
		expect(selectedProfile(list, settings)).toBeUndefined();
	});

	it('resolves no profile for a selection pointing at a removed one', () => {
		const created = addAndSelectProfile(list, settings, 'Gone');
		list.set(
			settings,
			removeProfile(list.get(settings), created?.id ?? ''),
		);
		// The id is still stored; the resolver must treat it as no selection.
		expect(list.selectedId(settings)).toBe(created?.id);
		expect(selectedProfile(list, settings)).toBeUndefined();
	});

	it('creates profiles with distinct ids and a trimmed name', () => {
		const a = list.create('  Legal  ');
		const b = list.create('Legal');
		expect(a.name).toBe('Legal');
		expect(a.id).toMatch(/[0-9a-f-]{36}/);
		expect(a.id).not.toBe(b.id);
	});
});

describe('speaker profile list', () => {
	// The pick is persisted like the dictionary and chapter ones: a
	// transcription records it with the recording, and the next run defaults
	// to it.
	it('stores profiles and persists the selection', () => {
		const settings = mergeSettings();
		SPEAKER_PROFILES.set(settings, []);
		const created = SPEAKER_PROFILES.create('Weekly sync');
		SPEAKER_PROFILES.set(
			settings,
			addProfile(SPEAKER_PROFILES.get(settings), created),
		);
		expect(SPEAKER_PROFILES.get(settings)).toHaveLength(1);
		SPEAKER_PROFILES.setSelectedId(settings, created.id);
		expect(SPEAKER_PROFILES.selectedId(settings)).toBe(created.id);
		expect(settings.transcriptionSpeakerProfileId).toBe(created.id);
	});
});
