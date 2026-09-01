/**
 * Tests the profile kinds as one mechanism. A glossary, a chapter-guidance
 * prompt, a roster and a post-processing prompt are the same thing over and
 * over, so the suite states each rule once and walks every kind through it: a
 * kind that drifts fails here rather than in the one place someone happened to
 * open.
 * @module tests/unit/profileKinds.test
 */

import { PROFILE_KINDS } from 'src/settings/profileKinds';
import {
	createProfile,
	freeProfileName,
	PROFILE_KIND_IDS,
	NEW_PROFILE_NAME,
} from 'src/settings/profiles';

describe.each(PROFILE_KINDS.map((kind) => [kind.heading, kind] as const))(
	'%s',
	(_heading, kind) => {
		it('names a kind, a body, and the keys both bind to', () => {
			// The settings build every catalogue from these, so a kind missing
			// one of them would show a row with no label or no binding.
			expect(kind.heading).not.toBe('');
			expect(kind.selectionName).not.toBe('');
			expect(kind.selectionDesc).not.toBe('');
			expect(kind.bodyName).not.toBe('');
			expect(kind.bodyDesc).not.toBe('');
			expect(kind.catalogueDesc).not.toBe('');
		});

		it('derives its control keys from its id, so two kinds cannot collide', () => {
			expect(kind.selectionKey).toBe(`profile.${kind.id}.selection`);
			expect(kind.bodyKey).toBe(`profile.${kind.id}.body`);
		});

		it('says what a profile holds, and says so when it holds nothing', () => {
			const empty = createProfile(kind.id, 'Empty');

			expect(kind.summary(empty)).toMatch(/^No /);
			expect(
				kind.summary(createProfile(kind.id, 'Full', 'Alex')),
			).not.toBe(kind.summary(empty));
		});

		it('numbers a second profile rather than repeating a name', () => {
			// A profile's page is addressed by its name, so two of a kind
			// cannot share one.
			const first = createProfile(kind.id, NEW_PROFILE_NAME);

			expect(freeProfileName([first], NEW_PROFILE_NAME)).toBe(
				`${NEW_PROFILE_NAME} 2`,
			);
		});

		it('belongs to exactly one block of the settings, under its own heading', () => {
			expect(
				PROFILE_KINDS.filter((other) => other.section === kind.section),
			).toContain(kind);
			expect(
				PROFILE_KINDS.filter(
					(other) => other !== kind && other.heading === kind.heading,
				),
			).toEqual([]);
		});
	},
);

describe('the profile kinds together', () => {
	it('keeps every kind on control keys of its own', () => {
		// One kind writing another's rows is the failure this registry exists
		// to prevent, and it would look like a roster turning into a glossary.
		const selectionKeys = PROFILE_KINDS.map((kind) => kind.selectionKey);
		const bodyKeys = PROFILE_KINDS.map((kind) => kind.bodyKey);

		expect(new Set(selectionKeys).size).toBe(selectionKeys.length);
		expect(new Set(bodyKeys).size).toBe(bodyKeys.length);
		expect(new Set([...selectionKeys, ...bodyKeys]).size).toBe(
			selectionKeys.length + bodyKeys.length,
		);
	});

	it('describes every kind the model stores, and only those', () => {
		// A kind the model knows but the settings never describe is a stored
		// profile with no editor; the reverse is a catalogue over nothing.
		expect(PROFILE_KINDS.map((kind) => kind.id).sort()).toEqual(
			[...PROFILE_KIND_IDS].sort(),
		);
	});

	it.each(['participants', 'dictionary'] as const)(
		'counts what a %s body holds, in the singular and the plural',
		(id) => {
			// The entry is read at a glance, so "1 term" beside "2 terms" is
			// the difference between a summary and a formula.
			const kind = PROFILE_KINDS.find((entry) => entry.id === id);
			const one = kind?.summary(createProfile(id, 'One', 'Alex'));
			const two = kind?.summary(createProfile(id, 'Two', 'Alex\nMaria'));

			expect(one).toMatch(/^1 /);
			expect(two).toMatch(/^2 /);
		},
	);

	it('gives each post-processing task a catalogue of its own', () => {
		const promptKinds = PROFILE_KINDS.filter(
			(kind) => kind.section === 'llm',
		);
		expect(promptKinds.map((kind) => kind.id)).toEqual([
			'llmCleanup',
			'llmSummary',
			'llmTranslate',
			'llmCustom',
		]);
	});
});
