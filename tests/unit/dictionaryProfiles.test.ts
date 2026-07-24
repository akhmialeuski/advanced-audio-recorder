/**
 * Tests the pure dictionary-profile helpers: creating a profile with a fresh
 * id, appending and removing by id, and resolving the selected profile's terms
 * for a run. Resolving must return '' for None, a removed profile, or an empty
 * list, since that empty string is the single guard that keeps the downstream
 * bias pipeline safe.
 * @module tests/unit/dictionaryProfiles.test
 */

import {
	addProfile,
	createDictionaryProfile,
	findProfile,
	removeProfile,
	resolveDictionaryTerms,
	resolveDictionaryTermList,
} from 'src/settings/dictionaryProfiles';
import type { DictionaryProfile } from 'src/settings/settingsSchema';

describe('createDictionaryProfile', () => {
	it('assigns a fresh id, trims the name, and starts with empty terms', () => {
		const profile = createDictionaryProfile('  Standup  ');
		expect(profile.name).toBe('Standup');
		expect(profile.terms).toBe('');
		expect(profile.id).toMatch(/[0-9a-f-]{36}/);
	});

	it('gives distinct ids to same-named profiles', () => {
		const a = createDictionaryProfile('Legal');
		const b = createDictionaryProfile('Legal');
		expect(a.id).not.toBe(b.id);
	});
});

describe('addProfile', () => {
	it('appends a new profile', () => {
		const next = addProfile([], 'Standup');
		expect(next).toHaveLength(1);
		expect(next[0]?.name).toBe('Standup');
	});

	it('is a no-op for a blank or whitespace-only name', () => {
		expect(addProfile([], '   ')).toEqual([]);
	});

	it('allows two profiles with the same name (distinct ids)', () => {
		const next = addProfile(addProfile([], 'Legal'), 'Legal');
		expect(next).toHaveLength(2);
		expect(next[0]?.id).not.toBe(next[1]?.id);
	});
});

describe('removeProfile', () => {
	const profiles: DictionaryProfile[] = [
		{ id: 'a', name: 'A', terms: '' },
		{ id: 'b', name: 'B', terms: '' },
	];

	it('removes the profile with the given id', () => {
		expect(removeProfile(profiles, 'a')).toEqual([
			{ id: 'b', name: 'B', terms: '' },
		]);
	});

	it('returns an unchanged copy for an absent id', () => {
		const next = removeProfile(profiles, 'missing');
		expect(next).toEqual(profiles);
		expect(next).not.toBe(profiles);
	});
});

describe('findProfile', () => {
	const profiles: DictionaryProfile[] = [{ id: 'a', name: 'A', terms: 'x' }];

	it('returns the matching profile', () => {
		expect(findProfile(profiles, 'a')?.name).toBe('A');
	});

	it('returns undefined for a missing id', () => {
		expect(findProfile(profiles, 'b')).toBeUndefined();
	});
});

describe('resolveDictionaryTerms', () => {
	const profiles: DictionaryProfile[] = [
		{ id: 'a', name: 'A', terms: 'Kubernetes\ngRPC' },
	];

	it('returns the selected profile terms', () => {
		expect(
			resolveDictionaryTerms({
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: 'a',
			}),
		).toBe('Kubernetes\ngRPC');
	});

	it('returns an empty string when None is selected', () => {
		expect(
			resolveDictionaryTerms({
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: '',
			}),
		).toBe('');
	});

	it('returns an empty string when the selected profile was removed', () => {
		expect(
			resolveDictionaryTerms({
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: 'gone',
			}),
		).toBe('');
	});

	it('returns an empty string for an empty profile list', () => {
		expect(
			resolveDictionaryTerms({
				transcriptionDictionaryProfiles: [],
				transcriptionDictionaryProfileId: 'a',
			}),
		).toBe('');
	});
});

describe('resolveDictionaryTermList', () => {
	const profiles: DictionaryProfile[] = [
		{ id: 'a', name: 'A', terms: 'Kubernetes\ngRPC\n\nkubernetes\n' },
	];

	it('parses the selected profile terms into a de-duplicated list', () => {
		// The single source every term-aware stage reads: the same profile that
		// biases the single pass also feeds the advanced context candidates and
		// the cleanup hint, with blanks and case-insensitive duplicates dropped.
		expect(
			resolveDictionaryTermList({
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: 'a',
			}),
		).toEqual(['Kubernetes', 'gRPC']);
	});

	it('returns an empty list when none is selected or the profile is gone', () => {
		expect(
			resolveDictionaryTermList({
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: '',
			}),
		).toEqual([]);
		expect(
			resolveDictionaryTermList({
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: 'gone',
			}),
		).toEqual([]);
	});

	it('returns an empty list when the advanced settings are off', () => {
		// The dictionary lives under the advanced master switch, so a plain run
		// applies no terms even with a profile selected.
		expect(
			resolveDictionaryTermList({
				transcriptionAdvancedSettingsEnabled: false,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: 'a',
			}),
		).toEqual([]);
	});
});
