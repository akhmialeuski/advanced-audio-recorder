/**
 * Tests the shared suggestion popover used by every suggesting text field
 * (the save-folder setting, the participant names in the speaker rename
 * dialog). The behavior that matters is the filtering contract and the
 * write-back: picking a suggestion has to reach the field's own listener,
 * which is what persists the setting or records the edited name.
 * @module tests/unit/TextInputSuggest.test
 */

import { TextInputSuggest } from 'src/ui/TextInputSuggest';
import { partialApp } from '../helpers/obsidianMock';
import { internalsOf } from '../helpers/doubles';

/** Exposes the protected query hook the popover calls as the user types. */
interface SuggestInternals {
	getSuggestions(query: string): string[];
}

/** Builds a suggest bound to a fresh input and a mutable candidate list. */
function makeSuggest(candidates: string[]): {
	suggest: TextInputSuggest;
	query: (text: string) => string[];
	input: HTMLInputElement;
	pool: string[];
} {
	const pool = [...candidates];
	const input = document.createElement('input');
	const suggest = new TextInputSuggest(partialApp({}), input, () => pool);
	return {
		suggest,
		query: (text) =>
			internalsOf<SuggestInternals>(suggest).getSuggestions(text),
		input,
		pool,
	};
}

describe('TextInputSuggest', () => {
	it('offers every candidate for an empty query', () => {
		const { query } = makeSuggest(['Recordings', 'Notes/Audio']);

		expect(query('')).toEqual(['Recordings', 'Notes/Audio']);
	});

	it('matches anywhere in the candidate, not only at the start', () => {
		const { query } = makeSuggest(['Notes/Audio', 'Recordings']);

		// A nested folder is usually found by its leaf name, so a prefix-only
		// match would hide the entry the user is actually looking for.
		expect(query('audio')).toEqual(['Notes/Audio']);
	});

	it('ignores case in both the query and the candidates', () => {
		const { query } = makeSuggest(['Alice Smith', 'BOB']);

		expect(query('ALICE')).toEqual(['Alice Smith']);
		expect(query('bo')).toEqual(['BOB']);
	});

	it('returns nothing when no candidate matches', () => {
		const { query } = makeSuggest(['Recordings']);

		expect(query('archive')).toEqual([]);
	});

	it('reads the candidates per query, so a value added while open appears', () => {
		const { query, pool } = makeSuggest(['Alice']);

		expect(query('bo')).toEqual([]);
		pool.push('Bob');

		// A snapshot taken in the constructor would keep offering the stale
		// list for the rest of the dialog's life.
		expect(query('bo')).toEqual(['Bob']);
	});

	it('writes the picked value back and notifies the field listener', () => {
		const { suggest, input } = makeSuggest(['Recordings']);
		const seen: string[] = [];
		input.addEventListener('input', () => {
			seen.push(input.value);
		});

		suggest.selectSuggestion('Recordings');

		expect(input.value).toBe('Recordings');
		// Setting `value` alone fires no event, so without the dispatch the
		// setting is shown as picked but never saved.
		expect(seen).toEqual(['Recordings']);
	});

	it('closes the popover after a pick', () => {
		const { suggest } = makeSuggest(['Recordings']);
		const close = jest.spyOn(suggest, 'close');

		suggest.selectSuggestion('Recordings');

		expect(close).toHaveBeenCalled();
	});

	it('renders a suggestion as its plain text', () => {
		const { suggest } = makeSuggest(['Recordings']);
		const el = document.createElement('div');
		(el as unknown as { setText: (text: string) => void }).setText = (
			text,
		) => {
			el.textContent = text;
		};

		suggest.renderSuggestion('Recordings', el);

		expect(el.textContent).toBe('Recordings');
	});
});
