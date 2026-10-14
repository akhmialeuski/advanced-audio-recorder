/**
 * Contract tests for the simple search, the root folder and the folder
 * lookup of the Obsidian mock, which the command-line marker search and the
 * folder actions rely on.
 * @module tests/unit/mocks/obsidianSearch.test
 */

import { prepareSimpleSearch, TFolder, Vault } from '../../mocks/obsidian';

describe('the simple search double', () => {
	it.each([
		{ name: 'every word occurs', query: 'team call', hit: true },
		{
			name: 'the words come in another order',
			query: 'call team',
			hit: true,
		},
		{ name: 'the case differs', query: 'TEAM', hit: true },
		{ name: 'one word is missing', query: 'team budget', hit: false },
	])('answers $hit when $name', ({ query, hit }) => {
		const matches = prepareSimpleSearch(query);

		expect(matches('Weekly team call notes') !== null).toBe(hit);
	});

	it('matches anything with an empty query', () => {
		expect(prepareSimpleSearch('  ')('anything')).toEqual({
			score: 0,
			matches: [],
		});
	});

	it('reports where each word matched', () => {
		expect(prepareSimpleSearch('call')('team call')?.matches).toEqual([
			[5, 9],
		]);
	});
});

describe('the root folder double', () => {
	it.each([
		{ path: '', root: true },
		{ path: '/', root: true },
		{ path: 'Recordings', root: false },
	])('reads $path as root: $root', ({ path, root }) => {
		expect(new TFolder(path).isRoot()).toBe(root);
	});
});

describe('looking a folder up by its path', () => {
	it('finds a folder a seeded file lives in', () => {
		const vault = new Vault();
		vault.seed([{ path: 'Recordings/2026/standup.webm' }]);

		expect(vault.getAbstractFileByPath('Recordings/2026')).toBeInstanceOf(
			TFolder,
		);
	});
});
