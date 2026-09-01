/**
 * Tests for the vault-wide marker index: what one scan of the vault costs,
 * that typing into a search costs nothing after it, and that a rename, a
 * delete, and a sidecar written outside a player keep it current instead of
 * leaving it stale until the session ends.
 */

import { MarkerSearchIndex } from 'src/markers/MarkerSearchIndex';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { PlayerMarker } from 'src/markers/markerModel';
import {
	emptyRecordingSidecar,
	type RecordingSidecar,
} from 'src/sidecar/recordingSidecarModel';
import { partial } from '../helpers/doubles';

/** Builds a sidecar document holding the given markers. */
function withMarkers(markers: PlayerMarker[]): RecordingSidecar {
	return { ...emptyRecordingSidecar(), markers };
}

/** A store double counting how often the vault was scanned. */
function createSut(data: Record<string, PlayerMarker[]> = {}): {
	index: MarkerSearchIndex;
	scans: jest.Mock;
	reads: jest.Mock;
	set: (path: string, markers: PlayerMarker[]) => void;
} {
	const vault = new Map(Object.entries(data));
	const scans = jest.fn(() =>
		Promise.resolve(
			[...vault].map(([path, markers]) => ({
				path,
				sidecar: withMarkers(markers),
			})),
		),
	);
	const reads = jest.fn((path: string) =>
		Promise.resolve([...(vault.get(path) ?? [])]),
	);
	const store = partial<RecordingSidecarStore>({
		allRecordings: scans,
		getMarkers: reads,
	});
	return {
		index: new MarkerSearchIndex(store),
		scans,
		reads,
		set: (path, markers) => {
			vault.set(path, markers);
		},
	};
}

const INTRO: PlayerMarker = {
	id: 'a',
	time: 60,
	label: 'Intro',
	kind: 'chapter',
};

const QUESTION: PlayerMarker = {
	id: 'b',
	time: 10,
	label: 'Question',
	kind: 'bookmark',
	note: 'Ask again later',
};

describe('indexing the markers of a vault', () => {
	it('returns every marker with the recording that carries it', async () => {
		const { index } = createSut({
			'Recordings/lecture.webm': [INTRO, QUESTION],
		});

		expect(await index.all()).toEqual([
			{
				recordingPath: 'Recordings/lecture.webm',
				recordingName: 'lecture',
				id: 'b',
				time: 10,
				label: 'Question',
				kind: 'bookmark',
				note: 'Ask again later',
			},
			{
				recordingPath: 'Recordings/lecture.webm',
				recordingName: 'lecture',
				id: 'a',
				time: 60,
				label: 'Intro',
				kind: 'chapter',
				note: '',
			},
		]);
	});

	it('orders by recording, then by position within it', async () => {
		const { index } = createSut({
			'b.webm': [INTRO],
			'a.webm': [QUESTION, INTRO],
		});

		expect((await index.all()).map((hit) => hit.recordingPath)).toEqual([
			'a.webm',
			'a.webm',
			'b.webm',
		]);
	});

	it('leaves out a recording that carries no markers', async () => {
		const { index } = createSut({ 'a.webm': [], 'b.webm': [INTRO] });

		expect((await index.all()).map((hit) => hit.recordingPath)).toEqual([
			'b.webm',
		]);
	});

	it('scans the vault once, so typing into a search reads nothing', async () => {
		const { index, scans } = createSut({ 'a.webm': [INTRO] });

		await index.all();
		await index.all();
		await index.all();

		expect(scans).toHaveBeenCalledTimes(1);
	});

	it('shares one scan between searches opened at the same moment', async () => {
		const { index, scans } = createSut({ 'a.webm': [INTRO] });

		await Promise.all([index.all(), index.all()]);

		expect(scans).toHaveBeenCalledTimes(1);
	});

	it('reports nothing and warns when the vault cannot be scanned', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The empty result is the assertion.
		});
		const store = partial<RecordingSidecarStore>({
			allRecordings: jest.fn(() =>
				Promise.reject(new Error('unreadable')),
			),
		});

		expect(await new MarkerSearchIndex(store).all()).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("index the vault's markers"),
			expect.any(Error),
		);
		warn.mockRestore();
	});
});

describe('keeping the index current', () => {
	it('re-reads a recording whose sidecar was written outside a player', async () => {
		const { index, set } = createSut({ 'a.webm': [INTRO] });
		await index.all();

		set('a.webm', [INTRO, QUESTION]);
		await index.refresh('a.webm');

		expect((await index.all()).map((hit) => hit.label)).toEqual([
			'Question',
			'Intro',
		]);
	});

	it('drops a recording whose markers were all removed', async () => {
		const { index, set } = createSut({ 'a.webm': [INTRO] });
		await index.all();

		set('a.webm', []);
		await index.refresh('a.webm');

		expect(await index.all()).toEqual([]);
	});

	it('reads nothing for a recording before the vault was ever scanned', async () => {
		const { index, reads } = createSut({ 'a.webm': [INTRO] });

		await index.refresh('a.webm');

		// The first search reads it anyway, so a write before then is not
		// worth a round-trip
		expect(reads).not.toHaveBeenCalled();
	});

	it('warns and keeps the rest when one recording cannot be re-read', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
			// The surviving entry is the assertion.
		});
		const store = partial<RecordingSidecarStore>({
			allRecordings: jest.fn(() =>
				Promise.resolve([
					{ path: 'a.webm', sidecar: withMarkers([INTRO]) },
				]),
			),
			getMarkers: jest.fn(() => Promise.reject(new Error('unreadable'))),
		});
		const index = new MarkerSearchIndex(store);
		await index.all();

		await index.refresh('a.webm');

		expect((await index.all()).map((hit) => hit.label)).toEqual(['Intro']);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('a.webm'),
			expect.any(Error),
		);
		warn.mockRestore();
	});

	it('carries a renamed recording over under its new name', async () => {
		const { index } = createSut({ 'old.webm': [INTRO] });
		await index.all();

		index.rename('old.webm', 'Recordings/new.webm');

		expect(await index.all()).toEqual([
			expect.objectContaining({
				recordingPath: 'Recordings/new.webm',
				recordingName: 'new',
			}),
		]);
	});

	it('ignores a rename of a recording that has no markers', async () => {
		const { index } = createSut({ 'a.webm': [INTRO] });
		await index.all();

		index.rename('other.webm', 'moved.webm');

		expect((await index.all()).map((hit) => hit.recordingPath)).toEqual([
			'a.webm',
		]);
	});

	it('drops a deleted recording', async () => {
		const { index } = createSut({ 'a.webm': [INTRO], 'b.webm': [INTRO] });
		await index.all();

		index.remove('a.webm');

		expect((await index.all()).map((hit) => hit.recordingPath)).toEqual([
			'b.webm',
		]);
	});

	it('scans again after the plugin drops what it held', async () => {
		const { index, scans } = createSut({ 'a.webm': [INTRO] });
		await index.all();

		index.clear();
		await index.all();

		expect(scans).toHaveBeenCalledTimes(2);
	});
});
