/**
 * Tests the vault-path helpers several features read paths through. They
 * answer for paths with no TFile behind them, so they have to read a path the
 * way Obsidian's own `TFile.parent` and `TFile.basename` do.
 * @module tests/unit/paths.test
 */

import { directoryOf, fileStemOf } from 'src/utils/paths';

describe('directoryOf', () => {
	it.each([
		{ path: 'Recordings/2026/take.webm', expected: 'Recordings/2026' },
		{ path: 'take.webm', expected: '' },
	])('answers "$expected" for $path', ({ path, expected }) => {
		expect(directoryOf(path)).toBe(expected);
	});
});

describe('fileStemOf', () => {
	it.each([
		{ path: 'Recordings/2026/take.webm', expected: 'take' },
		{ path: 'take.webm', expected: 'take' },
		{ path: 'Recordings/meeting.part1.ogg', expected: 'meeting.part1' },
		{ path: 'Recordings/notes', expected: 'notes' },
		// A leading dot starts the name, as it does in TFile.basename.
		{ path: 'Recordings/.hidden', expected: '.hidden' },
	])('answers "$expected" for $path', ({ path, expected }) => {
		expect(fileStemOf(path)).toBe(expected);
	});
});
