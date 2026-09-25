/**
 * Tests the one lookup of the open view showing a note. Transcript output,
 * the note inserter and profile notes all target a note they captured
 * earlier, so the lookup must answer by path and never by what is active.
 * @module tests/unit/noteViews.test
 */

import type { App } from 'obsidian';
import { findNoteView } from 'src/utils/noteViews';
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
