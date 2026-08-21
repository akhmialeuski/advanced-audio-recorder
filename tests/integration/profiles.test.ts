/**
 * Tests the shared profile machinery once, and then runs the same behavioural
 * contract against every kind of profile the plugin keeps. The kinds used to
 * carry a copy of this logic each, with a naming convention each; these tests
 * are what keep them on one implementation, and what makes a kind added to the
 * registry arrive with the same rules as the rest.
 * @module tests/integration/profiles.test
 */

import {
	addAndSelectProfile,
	addProfile,
	createProfile,
	editingProfileId,
	effectiveProfileId,
	findProfile,
	freeProfileName,
	moveProfile,
	profileNameRejection,
	profilesOfKind,
	removeAndReselectProfile,
	removeProfile,
	selectedProfile,
	selectedProfileId,
	setSelectedProfileId,
	PROFILE_KIND_IDS,
	type Profile,
	type ProfileKindId,
} from 'src/settings/profiles';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** A profile of the kind under test, so the helpers are exercised on their own. */
const simple = (
	id: string,
	name: string,
	kind: ProfileKindId = 'dictionary',
): Profile => ({ id, kind, name, body: '' });

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

	describe('profilesOfKind', () => {
		it('returns one kind in stored order, and nothing of another', () => {
			const profiles = [
				simple('a', 'A'),
				simple('p', 'P', 'participants'),
				simple('b', 'B'),
			];
			expect(
				profilesOfKind(profiles, 'dictionary').map((p) => p.id),
			).toEqual(['a', 'b']);
			expect(profilesOfKind(profiles, 'llmCleanup')).toEqual([]);
		});
	});

	describe('moveProfile', () => {
		const profiles = [simple('a', 'A'), simple('b', 'B'), simple('c', 'C')];

		it('moves a profile down to the dropped position', () => {
			expect(
				moveProfile(profiles, 'dictionary', 0, 2).map((p) => p.id),
			).toEqual(['b', 'c', 'a']);
		});

		it('moves a profile up to the dropped position', () => {
			expect(
				moveProfile(profiles, 'dictionary', 2, 0).map((p) => p.id),
			).toEqual(['c', 'a', 'b']);
		});

		it('leaves the order alone for a drop on the same position', () => {
			expect(
				moveProfile(profiles, 'dictionary', 1, 1).map((p) => p.id),
			).toEqual(['a', 'b', 'c']);
		});

		it.each([
			['a source outside the list', 3, 0],
			['a target outside the list', 0, 3],
			['a negative index', -1, 0],
		])('leaves the order alone for %s', (_case, from, to) => {
			expect(
				moveProfile(profiles, 'dictionary', from, to).map((p) => p.id),
			).toEqual(['a', 'b', 'c']);
		});

		it('reorders one kind without disturbing another', () => {
			// Every kind shares one stored list now, so a catalogue the user
			// rearranges must rewrite only the slots its own profiles hold.
			const mixed = [
				simple('a', 'A'),
				simple('p1', 'P1', 'participants'),
				simple('b', 'B'),
				simple('p2', 'P2', 'participants'),
			];
			const moved = moveProfile(mixed, 'participants', 0, 1);
			expect(
				moved
					.filter((profile) => profile.kind === 'participants')
					.map((profile) => profile.id),
			).toEqual(['p2', 'p1']);
			expect(
				moved
					.filter((profile) => profile.kind === 'dictionary')
					.map((profile) => profile.id),
			).toEqual(['a', 'b']);
		});

		it('returns a copy rather than reordering in place', () => {
			const next = moveProfile(profiles, 'dictionary', 0, 1);
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

	describe('freeProfileName', () => {
		it('keeps counting until it finds a name no profile holds', () => {
			const taken = [
				simple('a', 'New profile'),
				simple('b', 'New profile 2'),
			];

			expect(freeProfileName(taken, 'New profile')).toBe('New profile 3');
			expect(freeProfileName([], 'New profile')).toBe('New profile');
		});
	});

	describe('createProfile', () => {
		it('creates profiles of the kind asked for, with distinct ids and a trimmed name', () => {
			const a = createProfile('llmSummary', '  Legal  ');
			const b = createProfile('llmSummary', 'Legal');
			expect(a.name).toBe('Legal');
			expect(a.kind).toBe('llmSummary');
			expect(a.body).toBe('');
			expect(a.id).toMatch(/[0-9a-f-]{36}/);
			expect(a.id).not.toBe(b.id);
		});
	});
});

describe('profileNameRejection', () => {
	const profiles = [
		simple('a', 'Legal'),
		simple('p', 'Legal', 'participants'),
	];

	it('accepts a name free within the kind, whatever another kind uses', () => {
		// Pages are addressed per catalogue, so a roster and a glossary may
		// share a name; two glossaries may not.
		expect(
			profileNameRejection(profiles, 'dictionary', '', 'Medical'),
		).toBeUndefined();
		expect(
			profileNameRejection(profiles, 'participants', '', 'Legal'),
		).toBe('Another profile already uses this name.');
	});

	it('refuses a name another profile of the kind already holds', () => {
		expect(profileNameRejection(profiles, 'dictionary', '', 'Legal')).toBe(
			'Another profile already uses this name.',
		);
		// Trimmed before comparing, so a stray space cannot smuggle a
		// duplicate past the rule.
		expect(
			profileNameRejection(profiles, 'dictionary', '', '  Legal  '),
		).toBe('Another profile already uses this name.');
	});

	it('lets a profile keep the name it already has', () => {
		expect(
			profileNameRejection(profiles, 'dictionary', 'a', 'Legal'),
		).toBeUndefined();
	});

	it('refuses a name that is blank or only spaces', () => {
		expect(profileNameRejection(profiles, 'dictionary', '', '')).toBe(
			'Give the profile a name.',
		);
		expect(profileNameRejection(profiles, 'dictionary', '', '   ')).toBe(
			'Give the profile a name.',
		);
	});
});

describe.each(PROFILE_KIND_IDS.map((kind) => [kind, kind] as const))(
	'%s profiles',
	(_name, kind) => {
		let settings: AudioRecorderSettings;

		beforeEach(() => {
			settings = mergeSettings();
			// The seeded profiles are what a fresh install ships; the contract
			// below is about a catalogue the user builds, so it starts empty.
			settings.profiles = [];
			setSelectedProfileId(settings, kind, '');
		});

		it('adds a profile and selects it', () => {
			const created = addAndSelectProfile(settings, kind, 'Standup');
			expect(created?.name).toBe('Standup');
			expect(created?.kind).toBe(kind);
			expect(profilesOfKind(settings.profiles, kind)).toHaveLength(1);
			expect(selectedProfileId(settings, kind)).toBe(created?.id);
			expect(selectedProfile(settings, kind)).toEqual(created);
		});

		it('refuses a blank name and leaves the list untouched', () => {
			expect(addAndSelectProfile(settings, kind, '   ')).toBeUndefined();
			expect(settings.profiles).toEqual([]);
			expect(selectedProfileId(settings, kind)).toBe('');
		});

		it('reselects the first remaining profile after a removal', () => {
			const first = addAndSelectProfile(settings, kind, 'First');
			const second = addAndSelectProfile(settings, kind, 'Second');
			removeAndReselectProfile(settings, kind, second?.id ?? '');
			expect(profilesOfKind(settings.profiles, kind)).toHaveLength(1);
			expect(selectedProfileId(settings, kind)).toBe(first?.id);
		});

		it('leaves the selection alone when the profile removed was not in use', () => {
			// Tidying a catalogue is not a decision about which profile a run
			// applies; moving the selection here would change what the next
			// run does behind the user's back. The deleted profile is neither
			// the one in use nor the first of the list, so a reselection would
			// land somewhere visibly wrong rather than back where it started.
			const first = addAndSelectProfile(settings, kind, 'First');
			const inUse = addAndSelectProfile(settings, kind, 'In use');
			const spare = addAndSelectProfile(settings, kind, 'Spare');
			setSelectedProfileId(settings, kind, inUse?.id ?? '');

			removeAndReselectProfile(settings, kind, spare?.id ?? '');

			expect(selectedProfileId(settings, kind)).toBe(inUse?.id);
			expect(
				profilesOfKind(settings.profiles, kind).map(
					(profile) => profile.id,
				),
			).toEqual([first?.id, inUse?.id]);
		});

		it('falls back to no selection when the last profile is removed', () => {
			const only = addAndSelectProfile(settings, kind, 'Only');
			removeAndReselectProfile(settings, kind, only?.id ?? '');
			expect(settings.profiles).toEqual([]);
			expect(selectedProfileId(settings, kind)).toBe('');
			expect(selectedProfile(settings, kind)).toBeUndefined();
		});

		it('resolves no profile for a selection pointing at a removed one', () => {
			const created = addAndSelectProfile(settings, kind, 'Gone');
			settings.profiles = removeProfile(
				settings.profiles,
				created?.id ?? '',
			);
			// The id is still stored; the resolver must treat it as no
			// selection rather than as an error.
			expect(settings.selectedProfileIds[kind]).toBe(created?.id);
			expect(selectedProfile(settings, kind)).toBeUndefined();
		});

		it('leaves every other kind alone while its own is edited', () => {
			// One stored list serves them all, so an edit to one catalogue must
			// be invisible to the others.
			const others = PROFILE_KIND_IDS.filter((other) => other !== kind);
			for (const other of others) {
				addAndSelectProfile(settings, other, `${other} profile`);
			}
			const created = addAndSelectProfile(settings, kind, 'Mine');
			removeAndReselectProfile(settings, kind, created?.id ?? '');
			for (const other of others) {
				expect(profilesOfKind(settings.profiles, other)).toHaveLength(
					1,
				);
				expect(selectedProfileId(settings, other)).not.toBe('');
			}
		});
	},
);
