/**
 * Tests for the vault-wide marker search dialog: what a query is matched
 * against, what each row shows a reader who has never seen the recording,
 * and that choosing one hands back the marker rather than acting on playback
 * itself.
 * @jest-environment jsdom
 */

import { App } from 'obsidian';
import { MarkerSearchModal } from 'src/ui/MarkerSearchModal';
import type { MarkerHit } from 'src/markers/MarkerSearchIndex';
import { el, textsOf } from '../helpers/dom';
import { defined } from '../helpers/assertions';
import { MARKER } from '../helpers/selectors';

const LECTURE: MarkerHit = {
	recordingPath: 'Recordings/lecture.webm',
	recordingName: 'lecture',
	id: 'a',
	time: 3725,
	label: 'Second half',
	kind: 'chapter',
	note: '',
};

const STANDUP: MarkerHit = {
	recordingPath: 'standup.mp3',
	recordingName: 'standup',
	id: 'b',
	time: 42,
	label: 'Blocker',
	kind: 'bookmark',
	note: 'Ask the platform team',
};

interface Sut {
	modal: MarkerSearchModal;
	chosen: jest.Mock<void, [MarkerHit]>;
}

/**
 * Opens the search over the given markers.
 * @param hits - Markers the search runs over
 * @returns The open modal and what it reports as chosen
 */
function createSut(hits: MarkerHit[] = [LECTURE, STANDUP]): Sut {
	const chosen = jest.fn<void, [MarkerHit]>();
	const modal = new MarkerSearchModal(new App(), hits, chosen);
	modal.open();
	return { modal, chosen };
}

describe('what the search matches a query against', () => {
	it.each([
		{ by: 'the marker name', query: 'second', expected: 'Second half' },
		{ by: 'the recording name', query: 'standup', expected: 'Blocker' },
		{ by: 'the note on it', query: 'platform', expected: 'Blocker' },
	])('finds a marker by $by', ({ query, expected }) => {
		const { modal } = createSut();

		expect(
			modal.getSuggestions(query).map((match) => match.item.label),
		).toEqual([expected]);
	});

	it('finds nothing for a query no marker carries', () => {
		const { modal } = createSut();

		expect(modal.getSuggestions('nothing here')).toEqual([]);
	});

	it('offers every marker before anything is typed', () => {
		const { modal } = createSut();

		expect(modal.getItems()).toHaveLength(2);
	});

	it('leaves a missing note out of what is matched', () => {
		const { modal } = createSut([LECTURE]);

		// A trailing separator would make every markerless-note marker match
		// a query of one space
		expect(modal.getItemText(LECTURE)).toBe('Second half lecture');
	});
});

describe('what a result row shows', () => {
	it('names the marker, its recording, its kind, and its position', () => {
		const { modal } = createSut([LECTURE]);

		expect(textsOf(modal.resultContainerEl, MARKER.searchTitle)).toEqual([
			'Second half',
		]);
		expect(el(modal.resultContainerEl, MARKER.searchMeta).textContent).toBe(
			'Chapter in lecture at 1:02:05',
		);
	});

	it('shows the note a marker carries after where it is', () => {
		const { modal } = createSut([STANDUP]);

		expect(el(modal.resultContainerEl, MARKER.searchMeta).textContent).toBe(
			'Bookmark in standup at 0:42 - Ask the platform team',
		);
	});

	it('redraws the rows as the query narrows them', () => {
		const { modal } = createSut();

		modal.getSuggestions('blocker');

		expect(textsOf(modal.resultContainerEl, MARKER.searchTitle)).toEqual([
			'Blocker',
		]);
	});
});

describe('choosing a result', () => {
	it('hands back the marker that was chosen', () => {
		const { modal, chosen } = createSut();
		const [match] = modal.getSuggestions('blocker');

		modal.onChooseSuggestion(defined(match), new KeyboardEvent('keydown'));

		expect(chosen).toHaveBeenCalledWith(STANDUP);
	});
});
