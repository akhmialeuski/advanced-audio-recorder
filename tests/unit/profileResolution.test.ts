/**
 * Tests what a run makes of the profile it is pointed at, for every kind.
 *
 * Each resolver answers three questions the same way - a selection that
 * resolves, one that names nothing, and one that names a profile since removed
 * - because that shared answer is the single guard keeping every downstream
 * stage safe: an empty glossary applies no bias, empty guidance appends no
 * clause, an empty prompt falls back to the built-in one, and an empty roster
 * records no participants. The list mechanics themselves are covered in
 * profiles.test.
 * @module tests/unit/profileResolution.test
 */

import {
	addParticipantsToProfile,
	participantsOf,
	resolveChapterGuidance,
	resolveDictionaryTermList,
	resolveLlmPrompt,
	resolveRunParticipants,
} from 'src/settings/profileResolution';
import type { Profile, ProfileKindId } from 'src/settings/profiles';
import { mergeSettings } from 'src/settings/settingsSerialization';

/** One profile of a kind, with the body under test. */
const profile = (id: string, kind: ProfileKindId, body: string): Profile => ({
	id,
	kind,
	name: id,
	body,
});

/** Settings holding the given profiles, with one of them selected. */
const withSelection = (
	kind: ProfileKindId,
	id: string,
	profiles: Profile[],
	extra: Record<string, unknown> = {},
) =>
	mergeSettings({
		profiles,
		selectedProfileIds: { [kind]: id },
		...extra,
	});

describe('resolveDictionaryTermList', () => {
	const profiles = [
		profile('a', 'dictionary', 'Kubernetes\ngRPC\n\nkubernetes\n'),
	];

	/** Settings with the advanced switch in the given state. */
	const withAdvanced = (advanced: boolean, id: string) =>
		withSelection('dictionary', id, profiles, {
			transcriptionAdvancedSettingsEnabled: advanced,
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

	it('returns an empty list when none is selected, the profile is gone, or the catalogue is empty', () => {
		expect(resolveDictionaryTermList(withAdvanced(true, ''))).toEqual([]);
		expect(resolveDictionaryTermList(withAdvanced(true, 'gone'))).toEqual(
			[],
		);
		expect(
			resolveDictionaryTermList(
				withSelection('dictionary', 'a', [], {
					transcriptionAdvancedSettingsEnabled: true,
				}),
			),
		).toEqual([]);
	});

	it('reads only its own kind, whatever a hand-edited selection names', () => {
		// A selection pointing at another kind's profile is a config no editor
		// can produce, and it must not feed a chapter prompt to the glossary.
		const settings = withSelection(
			'dictionary',
			'c',
			[profile('c', 'chapterPrompt', 'Split by agenda item.')],
			{ transcriptionAdvancedSettingsEnabled: true },
		);

		expect(resolveDictionaryTermList(settings)).toEqual([]);
	});

	it('returns an empty list when the advanced settings are off', () => {
		// The dictionary lives under the advanced master switch, so a plain run
		// applies no terms even with a profile selected.
		expect(resolveDictionaryTermList(withAdvanced(false, 'a'))).toEqual([]);
	});
});

describe('resolveChapterGuidance', () => {
	const profiles = [profile('a', 'chapterPrompt', 'Split by agenda item.')];

	it("returns the selected profile's guidance", () => {
		expect(
			resolveChapterGuidance(
				withSelection('chapterPrompt', 'a', profiles),
			),
		).toBe('Split by agenda item.');
	});

	it('returns empty for None, a stale selection, or no profiles', () => {
		expect(
			resolveChapterGuidance(
				withSelection('chapterPrompt', '', profiles),
			),
		).toBe('');
		expect(
			resolveChapterGuidance(
				withSelection('chapterPrompt', 'gone', profiles),
			),
		).toBe('');
		expect(
			resolveChapterGuidance(withSelection('chapterPrompt', 'a', [])),
		).toBe('');
	});
});

describe('resolveLlmPrompt', () => {
	const profiles = [
		profile('clean', 'llmCleanup', 'Fix the punctuation.'),
		profile('sum', 'llmSummary', 'List the decisions.'),
		profile('own', 'llmCustom', 'Rewrite as a memo.'),
	];

	/** Settings selecting one profile per prompt kind. */
	const settings = () =>
		mergeSettings({
			profiles,
			selectedProfileIds: {
				llmCleanup: 'clean',
				llmSummary: 'sum',
				llmCustom: 'own',
			},
		});

	it('gives each task the prompt of its own kind', () => {
		// Three catalogues, not one: the task in hand decides which prompt runs,
		// so a summary can never be written with the cleanup instruction.
		expect(resolveLlmPrompt(settings(), 'cleanup')).toBe(
			'Fix the punctuation.',
		);
		expect(resolveLlmPrompt(settings(), 'summary')).toBe(
			'List the decisions.',
		);
		expect(resolveLlmPrompt(settings(), 'custom')).toBe(
			'Rewrite as a memo.',
		);
	});

	it('returns empty for None and for a selection that is gone', () => {
		// '' is what the prompt builder reads as "nothing was chosen": for
		// cleanup and summary it then runs the built-in prompt, and for the
		// custom task the neutral instruction, which is the behaviour the
		// catalogue's own description promises for each.
		const none = mergeSettings({
			profiles,
			selectedProfileIds: {
				llmCleanup: '',
				llmSummary: 'gone',
				llmCustom: '',
			},
		});
		expect(resolveLlmPrompt(none, 'cleanup')).toBe('');
		expect(resolveLlmPrompt(none, 'summary')).toBe('');
		expect(resolveLlmPrompt(none, 'custom')).toBe('');
	});
});

describe('resolveRunParticipants', () => {
	const profiles = [profile('p1', 'participants', 'Alex\n\n Maria \nAlex')];

	it('parses the selected roster, normalized the way every roster is', () => {
		expect(
			resolveRunParticipants(
				withSelection('participants', 'p1', profiles),
			),
		).toEqual(['Alex', 'Maria']);
	});

	it('returns nothing for None or a stale selection', () => {
		expect(
			resolveRunParticipants(withSelection('participants', '', profiles)),
		).toEqual([]);
		expect(
			resolveRunParticipants(
				withSelection('participants', 'gone', profiles),
			),
		).toEqual([]);
	});
});

describe('participantsOf', () => {
	const settings = () =>
		withSelection('participants', '', [
			profile('p1', 'participants', 'Alex\nMaria'),
			profile('c1', 'chapterPrompt', 'Split by agenda item.'),
		]);

	it("returns the named profile's participants", () => {
		expect(participantsOf(settings(), 'p1')).toEqual(['Alex', 'Maria']);
	});

	it('returns no suggestions for none, a removed profile, or another kind', () => {
		expect(participantsOf(settings(), '')).toEqual([]);
		expect(participantsOf(settings(), 'gone')).toEqual([]);
		expect(participantsOf(settings(), 'c1')).toEqual([]);
	});
});

describe('addParticipantsToProfile', () => {
	const base: Profile[] = [
		profile('p1', 'participants', 'Alex'),
		profile('p2', 'participants', ''),
		profile('c1', 'chapterPrompt', 'Split by agenda item.'),
	];

	it('adds only new, trimmed names to the target profile', () => {
		const next = addParticipantsToProfile(base, 'p1', [
			' Maria ',
			'Alex',
			'',
		]);
		expect(next?.[0]?.body).toBe('Alex\nMaria');
		expect(next?.[1]).toBe(base[1]);
		expect(next?.[2]).toBe(base[2]);
	});

	it('answers nothing when the roster did not grow', () => {
		// The caller's only question is whether there is something to save, and
		// a copy of the input cannot answer it: every profile in it compares
		// equal to the one it came from. Undefined says it plainly.
		expect(addParticipantsToProfile(base, 'p1', ['Alex'])).toBeUndefined();
	});

	it('answers nothing for an absent id or a profile of another kind', () => {
		expect(
			addParticipantsToProfile(base, 'missing', ['X']),
		).toBeUndefined();
		expect(addParticipantsToProfile(base, 'c1', ['X'])).toBeUndefined();
	});
});
