/**
 * Tests for the shared participant-name normalization: trimming, blanks,
 * duplicates, order, untyped values from disk, and the merge that grows a
 * roster without reordering the names already in it.
 */

import {
	mergeParticipantNames,
	normalizeParticipantNames,
	parseParticipantBody,
} from 'src/speakers/participantRoster';

describe('parseParticipantBody', () => {
	it('reads a roster written as a Markdown list under a heading', () => {
		expect(
			parseParticipantBody(
				'## Team\n- Alex\n* Bob\n\n1. Cleo\n- [ ] Dana',
			),
		).toEqual(['Alex', 'Bob', 'Cleo', 'Dana']);
	});

	it('reads plain lines exactly as before', () => {
		expect(parseParticipantBody('Alex\r\n  Bob \n\nAlex')).toEqual([
			'Alex',
			'Bob',
		]);
	});
});

describe('normalizeParticipantNames', () => {
	it('trims, drops blanks, and keeps the first of a duplicate in order', () => {
		expect(
			normalizeParticipantNames([
				'  Alex ',
				'',
				'Bob',
				'   ',
				'Alex',
				'\tCleo\n',
			]),
		).toEqual(['Alex', 'Bob', 'Cleo']);
	});

	it('drops non-string entries rather than poisoning the roster', () => {
		// A hand-edited sidecar or data.json is untyped; a number where a name
		// belongs must shorten the list, never reach a suggestion popover.
		expect(
			normalizeParticipantNames([
				'Alex',
				42,
				null,
				undefined,
				{ name: 'Bob' },
				['Cleo'],
				'Bob',
			]),
		).toEqual(['Alex', 'Bob']);
	});

	it('treats names differing only by surrounding space as one', () => {
		expect(normalizeParticipantNames(['Alex', ' Alex', 'Alex '])).toEqual([
			'Alex',
		]);
	});

	it('is case-sensitive: two spellings are two people until told otherwise', () => {
		// Deliberate: "alex" may be a different participant from "Alex", and
		// silently merging them would assign one speaker another's name.
		expect(normalizeParticipantNames(['Alex', 'alex'])).toEqual([
			'Alex',
			'alex',
		]);
	});

	it('returns an empty list for an empty input', () => {
		expect(normalizeParticipantNames([])).toEqual([]);
	});
});

describe('mergeParticipantNames', () => {
	it('appends only what is new, keeping the existing order', () => {
		expect(mergeParticipantNames(['Alex', 'Bob'], ['Bob', 'Cleo'])).toEqual(
			['Alex', 'Bob', 'Cleo'],
		);
	});

	it('normalizes both sides in one pass', () => {
		expect(
			mergeParticipantNames(['  Alex  ', ''], [' Alex', 'Bob ']),
		).toEqual(['Alex', 'Bob']);
	});

	it('never mutates the roster it was given', () => {
		const current = ['Alex'];
		const merged = mergeParticipantNames(current, ['Bob']);
		expect(current).toEqual(['Alex']);
		expect(merged).toEqual(['Alex', 'Bob']);
	});
});
