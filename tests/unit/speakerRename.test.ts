/**
 * Tests for the pure speaker-rename model: rejecting a name equal to another
 * entry's engine label, grouping the labels a deliberate merge gives one name
 * to and telling a new merge from one already stored, and the shared rename
 * plan - change detection against the stored roster, the self-healing
 * replacement rules that also target the engine label, the texts a merge
 * leaves too ambiguous to rewrite, whether a plan has work left in either of
 * the two places a rename reaches, the next roster and history mapping, and
 * prototype-safe label handling.
 */

import {
	addedMerges,
	labelCollisionNames,
	planHasWork,
	planSpeakerRename,
	speakerMerges,
	type SpeakerNameEntry,
} from 'src/speakers/speakerRename';

describe('speakerRename', () => {
	describe('labelCollisionNames', () => {
		it('allows one name given to two distinct labels', () => {
			// The merge the feature exists for: diarization split one person
			// into two labels and the user names both of them.
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: ' Alex ' },
			];

			expect(labelCollisionNames(entries)).toEqual([]);
		});

		it('is empty when every assigned name is unique', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bob' },
				{ label: 'Speaker 3', name: '' },
			];

			expect(labelCollisionNames(entries)).toEqual([]);
		});

		it('rejects a name equal to the label of a speaker left blank', () => {
			// "Alex" is left blank (keeps the label "Alex"), while "Speaker 2"
			// is renamed to "Alex": the roster would then hold a name equal to
			// another entry's label, which no later pass can attribute.
			const entries: SpeakerNameEntry[] = [
				{ label: 'Alex', name: '' },
				{ label: 'Speaker 2', name: 'Alex' },
			];

			expect(labelCollisionNames(entries)).toEqual(['Alex']);
		});

		it("rejects a name equal to another speaker's label even when that one is renamed", () => {
			// Naming Speaker 1 "Speaker 2" makes its lines indistinguishable
			// from Speaker 2's unrenamed occurrences in already-written text,
			// regardless of Speaker 2 getting its own new name.
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Speaker 2' },
				{ label: 'Speaker 2', name: 'Bob' },
			];

			expect(labelCollisionNames(entries)).toEqual(['Speaker 2']);
		});

		it('is empty when all fields are left blank', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: '' },
				{ label: 'Speaker 2', name: '' },
			];

			expect(labelCollisionNames(entries)).toEqual([]);
		});
	});

	describe('speakerMerges', () => {
		it('groups the labels a shared name is given to', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bob' },
				{ label: 'Speaker 3', name: ' Alex ' },
			];

			expect(speakerMerges(entries)).toEqual([
				{ name: 'Alex', labels: ['Speaker 1', 'Speaker 3'] },
			]);
		});

		it('groups three labels under one name', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Alex' },
				{ label: 'Speaker 3', name: 'Alex' },
			];

			expect(speakerMerges(entries)).toEqual([
				{
					name: 'Alex',
					labels: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
				},
			]);
		});

		it('is empty when every speaker keeps a name of its own', () => {
			const entries: SpeakerNameEntry[] = [
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: '' },
			];

			expect(speakerMerges(entries)).toEqual([]);
		});
	});

	describe('addedMerges', () => {
		it('reports a merge the stored roster does not carry', () => {
			const target = [
				{ name: 'Alex', labels: ['Speaker 1', 'Speaker 2'] },
			];

			expect(addedMerges([], target)).toEqual(target);
		});

		it('reports a stored merge that gained another label', () => {
			// The third label is a fresh irreversible step even though the
			// name was already merged over the first two.
			const target = [
				{
					name: 'Alex',
					labels: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
				},
			];

			expect(
				addedMerges(
					[{ name: 'Alex', labels: ['Speaker 1', 'Speaker 2'] }],
					target,
				),
			).toEqual(target);
		});

		it('is empty for a merge already stored, so a repeat never asks again', () => {
			const stored = [
				{ name: 'Alex', labels: ['Speaker 1', 'Speaker 2'] },
			];

			expect(addedMerges(stored, stored)).toEqual([]);
		});

		it('is empty when an already-merged pair is only renamed', () => {
			// Nobody is newly merged by giving the merged speaker another
			// name, so the confirmation must not come back for it.
			expect(
				addedMerges(
					[{ name: 'Alex', labels: ['Speaker 1', 'Speaker 2'] }],
					[{ name: 'Alexander', labels: ['Speaker 1', 'Speaker 2'] }],
				),
			).toEqual([]);
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

		it('never emits two rules for the same source text (legacy collision roster)', () => {
			// A legacy sidecar can hold a stored name equal to another
			// entry's engine label. Both entries then claim the text
			// "Speaker 2"; letting both rules through would make the rewrite
			// outcome depend on rule order (last-write-wins in the rename
			// map) and silently merge the speakers. The label-owner keeps
			// the rule; the stale-name healing rule is dropped.
			const plan = planSpeakerRename(
				[
					{ label: 'Speaker 1', name: 'Speaker 2' },
					{ label: 'Speaker 2' },
				],
				(label) => (label === 'Speaker 1' ? 'Alice' : 'Bob'),
			);

			const froms = plan.renames.map((rename) => rename.from);
			expect(new Set(froms).size).toBe(froms.length);
			expect(plan.renames).toEqual([
				{ from: 'Speaker 1', to: 'Alice' },
				{ from: 'Speaker 2', to: 'Bob' },
			]);
			expect(plan.nextEntries).toEqual([
				{ label: 'Speaker 1', name: 'Alice' },
				{ label: 'Speaker 2', name: 'Bob' },
			]);
		});

		it("keeps the label owner's rule when the owner comes first in the roster", () => {
			// The same legacy collision the other way round: whichever order
			// the roster puts them in, the speaker whose engine label the text
			// IS keeps the rule, and the stale claim neither overrides it nor
			// makes the text ambiguous.
			const plan = planSpeakerRename(
				[
					{ label: 'Speaker 2' },
					{ label: 'Speaker 1', name: 'Speaker 2' },
				],
				(label) => (label === 'Speaker 1' ? 'Alice' : 'Bob'),
			);

			expect(plan.renames).toEqual([
				{ from: 'Speaker 2', to: 'Bob' },
				{ from: 'Speaker 1', to: 'Alice' },
			]);
			expect(plan.ambiguous).toEqual([]);
		});

		it('plans one rule per label when two speakers are merged', () => {
			const plan = planSpeakerRename(
				[{ label: 'Speaker 3' }, { label: 'Speaker 5' }],
				() => 'Alex',
			);

			expect(plan.renames).toEqual([
				{ from: 'Speaker 3', to: 'Alex' },
				{ from: 'Speaker 5', to: 'Alex' },
			]);
			expect(plan.ambiguous).toEqual([]);
			expect(plan.nextNames).toEqual({
				'Speaker 3': 'Alex',
				'Speaker 5': 'Alex',
			});
		});

		it('heals a merged name both speakers already share', () => {
			// Both entries claim the shared text "Alex" and both want it to
			// become "Alexander", so rewriting it is unambiguous.
			const plan = planSpeakerRename(
				[
					{ label: 'Speaker 3', name: 'Alex' },
					{ label: 'Speaker 5', name: 'Alex' },
				],
				() => 'Alexander',
			);

			expect(plan.renames).toEqual([
				{ from: 'Speaker 3', to: 'Alexander' },
				{ from: 'Alex', to: 'Alexander' },
				{ from: 'Speaker 5', to: 'Alexander' },
			]);
			expect(plan.ambiguous).toEqual([]);
		});

		it('leaves a merged name alone when the speakers are split again', () => {
			// Every written "Alex" belongs to one of the two speakers and the
			// text says which; rewriting it would drag the other speaker's
			// lines along, so it is reported rather than rewritten.
			const plan = planSpeakerRename(
				[
					{ label: 'Speaker 3', name: 'Alex' },
					{ label: 'Speaker 5', name: 'Alex' },
				],
				(label) => (label === 'Speaker 3' ? 'Alex' : 'Bob'),
			);

			// The label rules survive: an output that missed the merge still
			// shows the engine labels and is healed toward the split names.
			expect(plan.renames).toEqual([
				{ from: 'Speaker 3', to: 'Alex' },
				{ from: 'Speaker 5', to: 'Bob' },
			]);
			expect(plan.ambiguous).toEqual(['Alex']);
			expect(plan.nextEntries).toEqual([
				{ label: 'Speaker 3', name: 'Alex' },
				{ label: 'Speaker 5', name: 'Bob' },
			]);
		});

		it('leaves a merged name alone when an undo reverts it to the labels', () => {
			const plan = planSpeakerRename(
				[
					{ label: 'Speaker 3', name: 'Alex' },
					{ label: 'Speaker 5', name: 'Alex' },
				],
				() => '',
			);

			expect(plan.changed).toBe(true);
			expect(plan.renames).toEqual([]);
			expect(plan.ambiguous).toEqual(['Alex']);
		});

		it('carries the first-turn offsets into the next roster', () => {
			// The offsets are what the dialog previews from; rebuilding the
			// entry as { label, name } would silently cost the user their
			// preview button on the first rename.
			const plan = planSpeakerRename(
				[
					{
						label: 'Speaker 1',
						name: 'Alex',
						firstStart: 3,
						firstEnd: 9,
					},
					{ label: 'Speaker 2', firstStart: 12 },
				],
				(label) => (label === 'Speaker 1' ? 'Bob' : ''),
			);

			expect(plan.nextEntries).toEqual([
				{
					label: 'Speaker 1',
					name: 'Bob',
					firstStart: 3,
					firstEnd: 9,
				},
				{ label: 'Speaker 2', firstStart: 12 },
			]);
		});

		it('keeps the offsets when a name is cleared back to the label', () => {
			const plan = planSpeakerRename(
				[
					{
						label: 'Speaker 1',
						name: 'Alex',
						firstStart: 3,
						firstEnd: 9,
					},
				],
				() => '',
			);

			expect(plan.changed).toBe(true);
			expect(plan.nextEntries).toEqual([
				{ label: 'Speaker 1', firstStart: 3, firstEnd: 9 },
			]);
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

	describe('planHasWork', () => {
		it('is true for a roster that already holds the target names', () => {
			// Nothing to store, but the healing rule that reaches an output
			// still showing the engine label survives - and gating an apply on
			// `changed` alone is what strands such an output forever.
			const plan = planSpeakerRename(
				[{ label: 'Speaker 1', name: 'Alex' }],
				() => 'Alex',
			);
			expect(plan.changed).toBe(false);
			expect(plan.renames).toEqual([{ from: 'Speaker 1', to: 'Alex' }]);
			expect(planHasWork(plan)).toBe(true);
		});

		it('is false for an unnamed roster left unnamed', () => {
			const plan = planSpeakerRename(
				[{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
				() => '',
			);
			expect(plan.changed).toBe(false);
			expect(plan.renames).toEqual([]);
			expect(planHasWork(plan)).toBe(false);
		});

		it('is true whenever the roster itself changes', () => {
			const plan = planSpeakerRename(
				[{ label: 'Speaker 1' }],
				() => 'Alex',
			);
			expect(plan.changed).toBe(true);
			expect(planHasWork(plan)).toBe(true);
		});
	});
});
