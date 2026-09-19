/**
 * Unit tests for the release notes catalogue and the selection over it.
 * @module tests/unit/releaseNotes.test
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
	MAX_SHOWN_VERSIONS,
	RELEASE_NOTES,
	releaseNotesSince,
} from 'src/release/releaseNotes';

/**
 * A catalogue whose entries name themselves, so an assertion reads which
 * version a section came from without quoting release prose.
 * @param versions - The versions the catalogue holds
 * @returns The catalogue, each entry holding `notes of <version>`
 */
function catalogue(versions: string[]): Record<string, string> {
	return Object.fromEntries(
		versions.map((version) => [version, `notes of ${version}`]),
	);
}

/**
 * The versions a selection returned, read back from the headings it wrote.
 * @param markdown - What the selection answered
 * @returns The versions, in the order they appear
 */
function headings(markdown: string): string[] {
	return [...markdown.matchAll(/^# (.+)$/gm)].map((match) => match[1] ?? '');
}

describe('releaseNotesSince', () => {
	it('answers nothing when the catalogue holds no newer version', () => {
		const notes = catalogue(['2.3.0', '2.2.3']);

		expect(releaseNotesSince('2.3.0', notes)).toBe('');
	});

	it('leaves out the version that was already announced', () => {
		const notes = catalogue(['2.3.2', '2.3.1', '2.3.0']);

		expect(headings(releaseNotesSince('2.3.1', notes))).toEqual(['2.3.2']);
	});

	it('answers every newer version, newest first', () => {
		const notes = catalogue(['2.3.0', '2.3.2', '2.3.1']);

		expect(headings(releaseNotesSince('2.2.3', notes))).toEqual([
			'2.3.2',
			'2.3.1',
			'2.3.0',
		]);
	});

	it('heads each section with its own version and its own notes', () => {
		const notes = catalogue(['2.3.2', '2.3.1']);

		expect(releaseNotesSince('2.3.0', notes)).toBe(
			'# 2.3.2\nnotes of 2.3.2\n\n# 2.3.1\nnotes of 2.3.1',
		);
	});

	it.each([
		// String order would put 2.10.0 before 2.9.0 and 2.3.10 before 2.3.9,
		// which is the whole reason the comparison reads the numbers.
		{ previous: '2.9.0', newer: '2.10.0' },
		{ previous: '2.3.9', newer: '2.3.10' },
		{ previous: '9.0.0', newer: '10.0.0' },
	])(
		'reads $newer as newer than $previous by number, not by string',
		({ previous, newer }) => {
			const notes = catalogue([newer, previous]);

			expect(headings(releaseNotesSince(previous, notes))).toEqual([
				newer,
			]);
		},
	);

	it('shows the newest versions only when an upgrade spans more', () => {
		const versions = Array.from(
			{ length: MAX_SHOWN_VERSIONS + 3 },
			(_unused, index) => `1.0.${String(index)}`,
		);

		const shown = headings(releaseNotesSince('0.9.0', catalogue(versions)));

		expect(shown).toHaveLength(MAX_SHOWN_VERSIONS);
		expect(shown[0]).toBe(`1.0.${String(versions.length - 1)}`);
	});

	it.each([
		// data.json is a file a sync conflict or a hand edit can leave holding
		// anything, so a value that is not a version falls into the order
		// somewhere rather than failing the load. Empty is also what the
		// palette command passes to mean everything on record.
		{ name: 'an empty string', previous: '', shown: ['2.3.2', '2.3.1'] },
		{
			name: 'a version missing its patch number',
			previous: '2.3',
			shown: ['2.3.2', '2.3.1'],
		},
		{ name: 'a word', previous: 'unknown', shown: [] },
	])('orders $name rather than failing on it', ({ previous, shown }) => {
		const notes = catalogue(['2.3.2', '2.3.1']);

		expect(headings(releaseNotesSince(previous, notes))).toEqual(shown);
	});

	it('reads the bundled catalogue when none is given', () => {
		const shown = headings(releaseNotesSince(''));

		expect(shown.length).toBeGreaterThan(0);
		expect(shown.filter((version) => !(version in RELEASE_NOTES))).toEqual(
			[],
		);
	});
});

describe('RELEASE_NOTES', () => {
	it('keys every entry by the tag the release carries', () => {
		const unversioned = Object.keys(RELEASE_NOTES).filter(
			(version) => !/^\d+\.\d+\.\d+$/.test(version),
		);

		expect(unversioned).toEqual([]);
	});

	it('holds the versions newest first, as the dialog shows them', () => {
		const stored = Object.keys(RELEASE_NOTES);

		// Compared against what the dialog shows, which is capped: the size of
		// the catalogue is the test below, and asking it here would report an
		// entry too many as a heading in the wrong order.
		expect(stored.slice(0, MAX_SHOWN_VERSIONS)).toEqual(
			headings(releaseNotesSince('')),
		);
	});

	it('keeps no more versions than one dialog shows', () => {
		// Every entry is bytes in main.js that every install carries. Past the
		// tenth an entry can no longer be reached by an update, which is the
		// way most readers ever meet this text, so the oldest are pruned as
		// new ones are added rather than kept for the palette command alone.
		expect(Object.keys(RELEASE_NOTES).length).toBeLessThanOrEqual(
			MAX_SHOWN_VERSIONS,
		);
	});

	it('gives every version notes to show', () => {
		const empty = Object.entries(RELEASE_NOTES)
			.filter(([, notes]) => notes.trim() === '')
			.map(([version]) => version);

		expect(empty).toEqual([]);
	});
});

describe('the catalogue against the manifest', () => {
	it('carries notes for the version this build ships', () => {
		// The dialog reads this map and nothing else, so a version released
		// without its entry ships a plugin that cannot say what it changed and
		// announces itself to nobody. scripts/release.mjs refuses such a
		// version at the tag. This asks the same question on every pull
		// request, which is where the entry is actually written.
		const manifest = JSON.parse(
			readFileSync(join(__dirname, '../..', 'manifest.json'), 'utf8'),
		) as { version: string };

		expect(Object.keys(RELEASE_NOTES)).toContain(manifest.version);
	});
});
