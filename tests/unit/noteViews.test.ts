/**
 * Tests the one lookup of the open view showing a note, and of the editor a
 * note can be written through. Transcript output, the note inserter and
 * profile notes all target a note they captured earlier, so the lookup must
 * answer by path and never by what is active, and must never hand out the
 * hidden editor of a view in Reading view, where a write is silently lost.
 * @module tests/unit/noteViews.test
 */

import type { App } from 'obsidian';
import {
	activeNote,
	editorOf,
	findNoteEditor,
	findNoteView,
} from 'src/utils/noteViews';
import {
	createFile,
	createMarkdownView,
	createMockApp,
} from '../helpers/createApp';

/**
 * An App whose Markdown leaves hold the given views.
 * @param views - The views of the open Markdown leaves, in pane order
 */
const appWithLeaves = (views: unknown[]): App =>
	createMockApp({
		workspace: {
			getLeavesOfType: jest
				.fn()
				.mockReturnValue(views.map((view) => ({ view }))),
		},
	}).app;

describe('findNoteView', () => {
	it('finds the note by its path, whichever pane it is in', () => {
		// A transcription or a dictation finishes after the user moved on; the
		// text still belongs to the note it was started for.
		const other = createMarkdownView({ file: createFile('other.md') });
		const target = createMarkdownView({ file: createFile('notes/a.md') });

		const found = findNoteView(
			appWithLeaves([other, target]),
			'notes/a.md',
		);

		expect(found).toBe(target);
	});

	it('answers null when the note is not open in any pane', () => {
		const other = createMarkdownView({ file: createFile('other.md') });

		expect(findNoteView(appWithLeaves([other]), 'notes/a.md')).toBeNull();
	});

	it('skips a leaf whose view is not a Markdown view', () => {
		// A leaf of type markdown can still hold a placeholder view while it
		// loads; it has no editor to write into.
		const placeholder = { file: createFile('notes/a.md') };

		expect(
			findNoteView(appWithLeaves([placeholder]), 'notes/a.md'),
		).toBeNull();
	});

	it('answers null for an empty path rather than matching a pathless view', () => {
		// No captured note is an empty path, and it must never be read as
		// whichever open view happens to report an empty path too.
		const pathless = createMarkdownView({ file: createFile('') });

		expect(findNoteView(appWithLeaves([pathless]), '')).toBeNull();
	});
});

describe('editorOf', () => {
	it('is the editor of a view being edited', () => {
		const view = createMarkdownView({ file: createFile('a.md') });

		expect(editorOf(view)).toBe(view.editor);
	});

	it('is nothing in Reading view, though the view still holds an editor', () => {
		// Regression (#177): that editor is hidden; it takes a write without
		// an error and the note never receives it.
		const view = createMarkdownView({
			file: createFile('a.md'),
			mode: 'preview',
		});

		expect(view.editor).toBeDefined();
		expect(editorOf(view)).toBeNull();
	});
});

describe('findNoteEditor', () => {
	it('finds the editor of the note, whichever pane it is in', () => {
		const other = createMarkdownView({ file: createFile('other.md') });
		const target = createMarkdownView({ file: createFile('notes/a.md') });

		expect(
			findNoteEditor(appWithLeaves([other, target]), 'notes/a.md'),
		).toBe(target.editor);
	});

	it('answers null for a note open in Reading view only', () => {
		const reading = createMarkdownView({
			file: createFile('notes/a.md'),
			mode: 'preview',
		});

		expect(
			findNoteEditor(appWithLeaves([reading]), 'notes/a.md'),
		).toBeNull();
	});

	it('takes the pane editing the note over one showing it in Reading view', () => {
		// What is typed in the editor is not on disk yet, so a write must
		// join it there rather than go around it through the file.
		const reading = createMarkdownView({
			file: createFile('notes/a.md'),
			mode: 'preview',
		});
		const editing = createMarkdownView({ file: createFile('notes/a.md') });

		expect(
			findNoteEditor(appWithLeaves([reading, editing]), 'notes/a.md'),
		).toBe(editing.editor);
	});

	it('answers null when the note is not open', () => {
		expect(findNoteEditor(appWithLeaves([]), 'notes/a.md')).toBeNull();
	});
});

describe('activeNote', () => {
	/**
	 * An App whose active Markdown view is the given one.
	 * @param view - The active view, or null when none is a Markdown view
	 */
	const appWithActive = (view: unknown): App =>
		createMockApp({
			workspace: {
				getActiveViewOfType: jest.fn().mockReturnValue(view),
			},
		}).app;

	it('is the active note with the editor it is being edited in', () => {
		const file = createFile('notes/a.md');
		const view = createMarkdownView({ file });

		expect(activeNote(appWithActive(view))).toEqual({
			view,
			file,
			editor: view.editor,
		});
	});

	it('names the note but no editor in Reading view', () => {
		const file = createFile('notes/a.md');
		const view = createMarkdownView({ file, mode: 'preview' });

		expect(activeNote(appWithActive(view))).toEqual({
			view,
			file,
			editor: null,
		});
	});

	it('is nothing when the active view is not a Markdown one', () => {
		expect(activeNote(appWithActive(null))).toBeNull();
	});
});
