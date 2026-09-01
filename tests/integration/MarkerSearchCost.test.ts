/**
 * What the vault-wide marker search costs on a phone, measured rather than
 * asserted from the design. A hundred recordings with markers are put in a
 * vault behind an adapter that counts reads, the index is built through the
 * real sidecar store, and then the search is typed into. The build is allowed
 * one read per sidecar; typing must read nothing at all, because a search
 * that hits the disk on every keystroke is unusable on a phone.
 */

import { App } from 'obsidian';
import { MarkerSearchIndex } from 'src/markers/MarkerSearchIndex';
import { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import { MarkerSearchModal } from 'src/ui/MarkerSearchModal';
import { createMockApp, fakeVaultFiles } from '../helpers/createApp';

/** How many recordings the measured vault holds. */
const RECORDINGS = 100;

/** How many markers each of them carries. */
const MARKERS_PER_RECORDING = 5;

/** A vault of recordings with markers, behind a read-counting adapter. */
function measuredVault(): {
	index: MarkerSearchIndex;
	reads: () => number;
} {
	const { files, adapter } = fakeVaultFiles();
	for (let recording = 0; recording < RECORDINGS; recording++) {
		const markers = Array.from(
			{ length: MARKERS_PER_RECORDING },
			(_, marker) => ({
				id: `m${String(recording)}-${String(marker)}`,
				time: marker * 60,
				label: `Topic ${String(marker)} of talk ${String(recording)}`,
				kind: marker === 0 ? 'chapter' : 'bookmark',
			}),
		);
		files.set(
			`Recordings/talk-${String(recording)}.webm.markers.json`,
			JSON.stringify({ version: 2, markers }),
		);
	}
	let reads = 0;
	const counted = {
		...adapter,
		read: (path: string): Promise<string> => {
			reads++;
			return adapter.read(path);
		},
	};
	const app = createMockApp({
		vault: {
			adapter: counted,
			getFiles: () => [...files.keys()].map((path) => ({ path })),
		},
	}).app;
	return {
		index: new MarkerSearchIndex(new RecordingSidecarStore(app)),
		reads: () => reads,
	};
}

describe('what a vault-wide marker search costs', () => {
	it('reads each sidecar once to build the index, and no more', async () => {
		const { index, reads } = measuredVault();

		await index.all();
		const afterBuild = reads();
		await index.all();

		expect(afterBuild).toBe(RECORDINGS);
		expect(reads()).toBe(RECORDINGS);
	});

	it('reads nothing from the disk while the search is typed into', async () => {
		const { index, reads } = measuredVault();
		const modal = new MarkerSearchModal(
			new App(),
			await index.all(),
			() => {
				// The cost of the query is what is measured, not the choice.
			},
		);
		modal.open();
		const afterBuild = reads();

		for (const query of ['t', 'to', 'top', 'topi', 'topic 3']) {
			modal.getSuggestions(query);
		}

		expect(reads()).toBe(afterBuild);
	});

	it('offers every marker in the vault to the search', async () => {
		const { index } = measuredVault();

		expect(await index.all()).toHaveLength(
			RECORDINGS * MARKERS_PER_RECORDING,
		);
	});

	it('narrows a hundred recordings to the one talk that was asked for', async () => {
		const { index } = measuredVault();
		const modal = new MarkerSearchModal(
			new App(),
			await index.all(),
			() => {
				// Matching is what is measured here.
			},
		);

		expect(modal.getSuggestions('talk 42')).toHaveLength(
			MARKERS_PER_RECORDING,
		);
	});
});
