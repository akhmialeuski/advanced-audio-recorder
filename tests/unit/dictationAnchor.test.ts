/**
 * The dictation anchor on a real CodeMirror editor: the field that maps the
 * start position through edits, and the fallbacks once that editor is gone.
 * @module tests/unit/dictationAnchor.test
 */

import { StateEffect } from '@codemirror/state';
import type { App, MarkdownView } from 'obsidian';
import {
	DictationAnchor,
	dictationAnchorField,
} from 'src/quicknotes/dictationAnchor';
import { createFile, createMockApp } from '../helpers/createApp';
import {
	mountLiveMarkdownView,
	type LiveMarkdownView,
} from '../helpers/liveEditor';

const PATH = 'Notes/today.md';

/**
 * Mounts a note whose editor carries the anchor field.
 * @param doc - The note's source
 * @param cursor - Where its cursor stands
 * @param anchored - Whether the plugin's field is in the editor
 */
function note(doc: string, cursor: number, anchored = true): LiveMarkdownView {
	return mountLiveMarkdownView({
		doc,
		cursor,
		file: createFile(PATH),
		extensions: anchored ? [dictationAnchorField] : [],
	});
}

/**
 * Places an anchor in a view, inserts after the given edit, and returns the
 * note's text.
 * @param live - The mounted note
 * @param view - The view the workspace shows for it
 * @param edit - What happens while the dictation records
 */
async function dictateInto(
	live: LiveMarkdownView,
	view: MarkdownView,
	edit: () => void,
): Promise<string> {
	const app = appShowing([view]);
	const anchor = DictationAnchor.place(app);
	edit();
	await anchor?.insert(app, 'X');
	return live.text();
}

/** Puts a line at the top of the note. */
function typeAbove(live: LiveMarkdownView): () => void {
	return () => {
		live.view.dispatch({ changes: { from: 0, insert: 'top ' } });
	};
}

/**
 * An app whose workspace shows the given views, the first one active.
 * @param views - The open Markdown views
 */
function appShowing(views: MarkdownView[]): App {
	return createMockApp({
		workspace: {
			getActiveViewOfType: jest.fn(() => views[0] ?? null),
			getLeavesOfType: jest.fn(() => views.map((view) => ({ view }))),
		},
	}).app;
}

describe('DictationAnchor', () => {
	it('anchors nothing when no Markdown note is active', () => {
		expect(DictationAnchor.place(appShowing([]))).toBeNull();
	});

	it('drops the anchor when the whole document is replaced, and uses the start offset', async () => {
		const live = note('abc def', 4);
		const app = appShowing([live.markdownView]);
		const anchor = DictationAnchor.place(app);
		// A reload swaps the content in one change over the whole document.
		live.view.dispatch({
			changes: { from: 0, to: live.text().length, insert: 'xyz uvw' },
		});

		expect(live.view.state.field(dictationAnchorField)).toBeNull();
		await expect(anchor?.insert(app, 'X')).resolves.toBe(PATH);
		expect(live.text()).toBe('xyz Xuvw');
	});

	it('inserts at the start offset into the note open in another editor', async () => {
		const first = note('one two', 4);
		const app = appShowing([first.markdownView]);
		const anchor = DictationAnchor.place(app);
		first.view.destroy();
		const reopened = note('one two', 0);
		jest.mocked(app.workspace.getLeavesOfType).mockReturnValue([
			{ view: reopened.markdownView },
		] as never);

		await expect(anchor?.insert(app, 'X')).resolves.toBe(PATH);
		expect(reopened.text()).toBe('one Xtwo');
	});

	it('reports that no note took the text when the note was deleted', async () => {
		const live = note('one', 0);
		const app = appShowing([live.markdownView]);
		const anchor = DictationAnchor.place(app);
		live.view.destroy();
		jest.mocked(app.workspace.getLeavesOfType).mockReturnValue([]);

		await expect(anchor?.insert(app, 'X')).resolves.toBeNull();
	});

	it('keeps mapping the anchor through a transaction carrying another effect', async () => {
		const live = note('one two', 4);
		const other = StateEffect.define<null>();

		const text = await dictateInto(live, live.markdownView, () => {
			live.view.dispatch({
				changes: { from: 0, insert: 'top ' },
				effects: other.of(null),
			});
		});

		expect(text).toBe('top one Xtwo');
	});

	// Without an editor that tracks it, the start offset is all that is left,
	// so an edit above it moves the text off the spot.
	it('uses the start offset in an editor the plugin did not add the field to', async () => {
		const live = note('one two', 4, false);

		const text = await dictateInto(
			live,
			live.markdownView,
			typeAbove(live),
		);

		expect(text).toBe('top Xone two');
	});

	it('uses the start offset when the view holds no editor element', async () => {
		const live = note('one two', 4);
		const bare = Object.assign(
			Object.create(live.markdownView) as MarkdownView,
			{
				contentEl: document.createElement('div'),
			},
		);

		const text = await dictateInto(live, bare, typeAbove(live));

		expect(text).toBe('top Xone two');
	});

	it('does not take an editor that Obsidian names for another view', async () => {
		const live = note('one two', 4);
		const foreign = Object.assign(
			Object.create(live.markdownView) as MarkdownView,
			{
				editor: { ...live.editor },
			},
		);

		const text = await dictateInto(live, foreign, typeAbove(live));

		expect(live.view.state.field(dictationAnchorField)).toBeNull();
		expect(text).toBe('top Xone two');
	});

	it('clears the anchor it set when released', () => {
		const live = note('one', 1);
		const anchor = DictationAnchor.place(appShowing([live.markdownView]));
		expect(live.view.state.field(dictationAnchorField)).toBe(1);

		anchor?.release();

		expect(live.view.state.field(dictationAnchorField)).toBeNull();
	});
});
