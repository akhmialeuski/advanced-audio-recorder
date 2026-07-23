/**
 * Tests for the pure speaker-rename model: rejecting a merge of two labels
 * into one name (including a name colliding with another entry's label), and
 * the shared rename plan - change detection against the stored roster, the
 * self-healing replacement rules that also target the engine label, the next
 * roster and history mapping, and prototype-safe label handling.
 */

import {
	duplicateAssignedNames,
	planSpeakerRename,
	type SpeakerNameEntry,
} from 'src/speakers/speakerRename';

describe('speakerRename', () => {
	describe('duplicateAssignedNames', () => {
		it('reports a name given to two distinct labels', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: ' Alex ' },
			];
			expect(duplicateAssignedNames(entries)).toEqual(['Alex']);
		});

		it('is empty when every assigned name is unique', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bob' },
				{ label: 'Speaker 3', name: '' },
			];
			expect(duplicateAssignedNames(entries)).toEqual([]);
		});

		it('detects a merge onto an existing label left blank', () => {
			// "Alex" is left blank (keeps the label "Alex"), while "Speaker 2"
			// is renamed to "Alex": applying would merge both into "Alex".
			const entries: SpeakerNameEntry[] = [
				{ label: 'Alex', name: '' },
				{ label: 'Speaker 2', name: 'Alex' },
			];
			expect(duplicateAssignedNames(entries)).toEqual(['Alex']);
		});

		it("rejects a name equal to another speaker's label even when that one is renamed", () => {
			// Naming Speaker 1 "Speaker 2" makes its lines indistinguishable
			// from Speaker 2's unrenamed occurrences in already-written text,
			// regardless of Speaker 2 getting its own new name.
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Speaker 2' },
				{ label: 'Speaker 2', name: 'Bob' },
			];
			expect(duplicateAssignedNames(entries)).toEqual(['Speaker 2']);
		});

		it('is empty when all fields are left blank', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: '' },
				{ label: 'Speaker 2', name: '' },
			];
			expect(duplicateAssignedNames(entries)).toEqual([]);
		});
	});

	describe('planSpeakerRename', () => {
		const roster = [
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		];

		it('plans self-healing rules from both the stored name and the label', () => {
			const targets: Record<string, string> = {
				'Speaker 1': 'Bob',
				'Speaker 2': ' Cleo ',
			};
			const plan = planSpeakerRename(
				roster,
				(label) => targets[label] ?? '',
			);

			expect(plan.changed).toBe(true);
			// "Alex" is what a rewritten output shows; "Speaker 1" is what an
			// output missed by an earlier rewrite still shows. Both rules run
			// simultaneously, so they can never chain.
			expect(plan.renames).toEqual([
				{ from: 'Speaker 1', to: 'Bob' },
				{ from: 'Alex', to: 'Bob' },
				{ from: 'Speaker 2', to: 'Cleo' },
			]);
			expect(plan.nextEntries).toEqual([
				{ label: 'Speaker 1', name: 'Bob' },
				{ label: 'Speaker 2', name: 'Cleo' },
			]);
			expect(plan.nextNames).toEqual({
				'Speaker 1': 'Bob',
				'Speaker 2': 'Cleo',
			});
		});

		it('emits a healing rule even for an unchanged assignment', () => {
			const plan = planSpeakerRename(roster, (label) =>
				label === 'Speaker 1' ? 'Alex' : '',
			);
			expect(plan.changed).toBe(false);
			expect(plan.renames).toEqual([{ from: 'Speaker 1', to: 'Alex' }]);
		});

		it('reverts a speaker to its label on an empty or label-equal target', () => {
			const emptied = planSpeakerRename(roster, () => '');
			expect(emptied.changed).toBe(true);
			expect(emptied.renames).toEqual([
				{ from: 'Alex', to: 'Speaker 1' },
			]);
			expect(emptied.nextEntries).toEqual([
				{ label: 'Speaker 1' },
				{ label: 'Speaker 2' },
			]);
			expect(emptied.nextNames).toEqual({});

			const labelEqual = planSpeakerRename(roster, (label) => label);
			expect(labelEqual.nextEntries).toEqual([
				{ label: 'Speaker 1' },
				{ label: 'Speaker 2' },
			]);
		});

		it('reports no change for an unnamed roster with blank targets', () => {
			const plan = planSpeakerRename([{ label: 'Speaker 1' }], () => '');
			expect(plan.changed).toBe(false);
			expect(plan.renames).toEqual([]);
		});

		it('keeps hostile labels as plain data in the next-names map', () => {
			const plan = planSpeakerRename(
				[{ label: '__proto__' }, { label: 'constructor' }],
				(label) => (label === '__proto__' ? 'Alex' : 'Bob'),
			);
			expect(plan.changed).toBe(true);
			// The mapping is a null-prototype object: assigning through a
			// "__proto__" key stores data instead of rewiring the prototype.
			expect(Object.hasOwn(plan.nextNames, '__proto__')).toBe(true);
			expect(plan.nextNames['__proto__']).toBe('Alex');
			expect(plan.nextNames.constructor).toBe('Bob');
			expect(Object.getPrototypeOf(plan.nextNames)).toBeNull();
			expect(({} as Record<string, unknown>).Alex).toBeUndefined();
		});
	});
});
