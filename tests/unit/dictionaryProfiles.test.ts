/**
 * Tests what is specific to the dictionary profile kind: building a profile and
 * resolving the selected one's terms for a run, raw and parsed. Resolving must
 * return nothing for None, a removed profile, an empty list, or an advanced
 * master switch that is off, since that is the single guard keeping the
 * downstream bias pipeline safe. The shared list mechanics are covered in
 * profiles.test.
 * @module tests/unit/dictionaryProfiles.test
 */

import {
	DICTIONARY_PROFILES,
	createDictionaryProfile,
	resolveDictionaryTerms,
	resolveDictionaryTermList,
} from 'src/settings/dictionaryProfiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { DictionaryProfile } from 'src/settings/settingsSchema';

describe('createDictionaryProfile', () => {
	it('assigns a fresh id, trims the name, and starts with empty terms', () => {
		const profile = createDictionaryProfile('  Standup  ');
		expect(profile.name).toBe('Standup');
		expect(profile.terms).toBe('');
		expect(profile.id).toMatch(/[0-9a-f-]{36}/);
	});
});

describe('resolveDictionaryTerms', () => {
	const profiles: DictionaryProfile[] = [
		{ id: 'a', name: 'A', terms: 'Kubernetes\ngRPC' },
	];

	/** Settings holding the given profiles and selection. */
	const withSelection = (id: string, list = profiles) =>
		mergeSettings({
			transcriptionDictionaryProfiles: list,
			transcriptionDictionaryProfileId: id,
		});

	it('returns the selected profile terms', () => {
		expect(resolveDictionaryTerms(withSelection('a'))).toBe(
			'Kubernetes\ngRPC',
		);
	});

	it('returns an empty string when None is selected', () => {
		expect(resolveDictionaryTerms(withSelection(''))).toBe('');
	});

	it('returns an empty string when the selected profile was removed', () => {
		expect(resolveDictionaryTerms(withSelection('gone'))).toBe('');
	});

	it('returns an empty string for an empty profile list', () => {
		expect(resolveDictionaryTerms(withSelection('a', []))).toBe('');
	});

	it('is bound to the settings fields the descriptor names', () => {
		const settings = withSelection('a');
		expect(DICTIONARY_PROFILES.get(settings)).toEqual(profiles);
		expect(DICTIONARY_PROFILES.selectedId(settings)).toBe('a');
	});
});

describe('resolveDictionaryTermList', () => {
	const profiles: DictionaryProfile[] = [
		{ id: 'a', name: 'A', terms: 'Kubernetes\ngRPC\n\nkubernetes\n' },
	];

	/** Settings with the advanced switch in the given state. */
	const withAdvanced = (advanced: boolean, id: string) =>
		mergeSettings({
			transcriptionAdvancedSettingsEnabled: advanced,
			transcriptionDictionaryProfiles: profiles,
			transcriptionDictionaryProfileId: id,
		});

	it('parses the selected profile terms into a de-duplicated list', () => {
		// The single source every term-aware stage reads: the same profile that
		// biases the single pass also feeds the advanced context candidates and
		// the cleanup hint, with blanks and case-insensitive duplicates dropped.
		expect(resolveDictionaryTermList(withAdvanced(true, 'a'))).toEqual([
			'Kubernetes',
			'gRPC',
		]);
	});

	it('returns an empty list when none is selected or the profile is gone', () => {
		expect(resolveDictionaryTermList(withAdvanced(true, ''))).toEqual([]);
		expect(resolveDictionaryTermList(withAdvanced(true, 'gone'))).toEqual(
			[],
		);
	});

	it('returns an empty list when the advanced settings are off', () => {
		// The dictionary lives under the advanced master switch, so a plain run
		// applies no terms even with a profile selected.
		expect(resolveDictionaryTermList(withAdvanced(false, 'a'))).toEqual([]);
	});
});
