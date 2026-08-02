/**
 * Tests the profile kinds as one mechanism. A glossary, a chapter-guidance
 * prompt and a participant roster are the same thing three times over, so the
 * suite states each rule once and walks every kind through it: a kind that
 * drifts fails here rather than in the one place someone happened to open.
 * @module tests/unit/profileKinds.test
 */

import { PROFILE_KINDS, profileKindsOf } from 'src/settings/profileKinds';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import {
	addProfile,
	effectiveProfileId,
	findProfile,
	freeProfileName,
	NEW_PROFILE_NAME,
	removeAndReselectProfile,
} from 'src/settings/profiles';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** A settings object of its own, so one kind's edits cannot reach another. */
const freshSettings = (): AudioRecorderSettings => ({
	...DEFAULT_SETTINGS,
	transcriptionDictionaryProfiles: [],
	transcriptionChapterPromptProfiles: [],
	transcriptionSpeakerProfiles: [],
});

describe.each(PROFILE_KINDS.map((kind) => [kind.heading, kind] as const))(
	'%s',
	(_heading, kind) => {
		it('names a kind, a body, and where both live', () => {
			// The settings build every catalogue from these, so a kind missing
			// one of them would show a row with no label or no binding.
			expect(kind.heading).not.toBe('');
			expect(kind.selectionName).not.toBe('');
			expect(kind.bodyName).not.toBe('');
			expect(kind.selectionKey).not.toBe('');
			expect(kind.bodyKey).not.toBe('');
			expect(kind.selectionKey in DEFAULT_SETTINGS).toBe(true);
		});

		it('creates, reads back, and edits a profile through its own list', () => {
			const settings = freshSettings();
			const list = kind.list;

			const created = list.create('Standup');
			list.set(settings, addProfile(list.get(settings), created));
			kind.setBody(
				findProfile(list.get(settings), created.id) ?? created,
				'Kubernetes\nkubectl',
			);

			const stored = findProfile(list.get(settings), created.id);
			expect(stored?.name).toBe('Standup');
			expect(kind.body(stored ?? created)).toContain('Kubernetes');
		});

		it('says what a profile holds, and says so when it holds nothing', () => {
			const empty = kind.list.create('Empty');

			expect(kind.summary(empty)).toMatch(/^No /);
			expect(kind.summary(empty)).not.toBe('');
		});

		it('numbers a second profile rather than repeating a name', () => {
			// A profile's page is addressed by its name, so two of a kind
			// cannot share one.
			const settings = freshSettings();
			const list = kind.list;
			const first = list.create(NEW_PROFILE_NAME);
			list.set(settings, addProfile(list.get(settings), first));

			const name = freeProfileName(list.get(settings), NEW_PROFILE_NAME);

			expect(name).toBe(`${NEW_PROFILE_NAME} 2`);
		});

		it('moves the selection off a profile it removes', () => {
			const settings = freshSettings();
			const list = kind.list;
			const first = list.create('First');
			const second = list.create('Second');
			list.set(settings, [first, second]);
			list.setSelectedId(settings, first.id);

			removeAndReselectProfile(list, settings, first.id);

			expect(list.get(settings).map((p) => p.id)).toEqual([second.id]);
			expect(list.selectedId(settings)).toBe(second.id);
		});

		it('reads a selection that names nothing as none', () => {
			const settings = freshSettings();
			kind.list.setSelectedId(settings, 'gone');

			expect(effectiveProfileId(kind.list.get(settings), 'gone')).toBe(
				'',
			);
		});

		it('belongs to exactly one block of the settings', () => {
			expect(profileKindsOf(kind.section)).toContain(kind);
			expect(
				PROFILE_KINDS.filter(
					(other) => other !== kind && other.heading === kind.heading,
				),
			).toEqual([]);
		});
	},
);

describe('the profile kinds together', () => {
	it('keeps every kind on its own settings fields', () => {
		// One kind writing another's field is the failure this registry exists
		// to prevent, and it would look like a roster turning into a glossary.
		const selectionKeys = PROFILE_KINDS.map((kind) => kind.selectionKey);
		const bodyKeys = PROFILE_KINDS.map((kind) => kind.bodyKey);

		expect(new Set(selectionKeys).size).toBe(selectionKeys.length);
		expect(new Set(bodyKeys).size).toBe(bodyKeys.length);
	});

	it('covers the three kinds the plugin keeps', () => {
		expect(PROFILE_KINDS.map((kind) => kind.heading)).toEqual([
			'Participant profiles',
			'Dictionary profiles',
			'Chapter guidance profiles',
		]);
	});
});
