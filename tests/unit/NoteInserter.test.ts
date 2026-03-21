/**
 * Unit tests for NoteInserter module.
 * Tests cursor context capture and audio link insertion into notes.
 * @module tests/unit/NoteInserter.test
 */
/** @jest-environment jsdom */

import type { InsertionContext } from '../../src/types';
import type { App } from 'obsidian';

// Mock MarkdownView class used for instanceof checks
class MockMarkdownView {
	file: { path: string } | null = null;
	editor: {
		getCursor: jest.Mock;
		replaceRange: jest.Mock;
		replaceSelection: jest.Mock;
	} | null = null;
}

jest.mock('obsidian', () => ({
	MarkdownView: MockMarkdownView,
}));

import {
	captureInsertionContext,
	insertFileLinks,
} from '../../src/recording/NoteInserter';

// DebugLogger mock
function createMockDebugLogger(): { log: jest.Mock } {
	return { log: jest.fn() };
}

// Helper to create a mock App with workspace methods
function createMockApp(overrides?: {
	activeView?: MockMarkdownView | null;
	leaves?: Array<{ view: MockMarkdownView }>;
}): App {
	const activeView = overrides?.activeView ?? null;
	const leaves = overrides?.leaves ?? [];

	return {
		workspace: {
			getActiveViewOfType: jest.fn().mockReturnValue(activeView),
			getLeavesOfType: jest.fn().mockReturnValue(leaves),
		},
	} as unknown as App;
}

// Helper to create a MockMarkdownView with file and editor
function createMockView(
	filePath: string | null,
	cursorLine?: number,
	cursorCh?: number,
): MockMarkdownView {
	const view = new MockMarkdownView();
	view.file = filePath ? { path: filePath } : null;
	if (cursorLine !== undefined && cursorCh !== undefined) {
		view.editor = {
			getCursor: jest
				.fn()
				.mockReturnValue({ line: cursorLine, ch: cursorCh }),
			replaceRange: jest.fn(),
			replaceSelection: jest.fn(),
		};
	}
	return view;
}

describe('NoteInserter', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('captureInsertionContext', () => {
		it('returns null when insertAtOriginalPosition is false', () => {
			const app = createMockApp();
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, false, logger);

			expect(result).toBeNull();
			// Should not attempt to access workspace at all
			expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();
		});

		it('returns InsertionContext when active MarkdownView has file and cursor', () => {
			const view = createMockView('notes/test.md', 10, 5);
			const app = createMockApp({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toEqual({
				filePath: 'notes/test.md',
				line: 10,
				ch: 5,
			});
			expect(logger.log).not.toHaveBeenCalled();
		});

		it('returns null and logs when no active MarkdownView', () => {
			const app = createMockApp({ activeView: null });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toBeNull();
			expect(logger.log).toHaveBeenCalledWith(
				'Could not capture insertion context: no active Markdown view',
			);
		});

		it('returns null and logs when view has no file', () => {
			const view = createMockView(null, 3, 0);
			const app = createMockApp({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toBeNull();
			expect(logger.log).toHaveBeenCalledWith(
				'Could not capture insertion context: no active Markdown view',
			);
		});

		it('returns null and logs when view has no editor (no cursor)', () => {
			// View with file but no editor
			const view = new MockMarkdownView();
			view.file = { path: 'notes/test.md' };
			view.editor = null;
			const app = createMockApp({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toBeNull();
			expect(logger.log).toHaveBeenCalledWith(
				'Could not capture insertion context: no active Markdown view',
			);
		});

		it('captures cursor at line 0 ch 0 correctly', () => {
			const view = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toEqual({
				filePath: 'notes/test.md',
				line: 0,
				ch: 0,
			});
		});
	});

	describe('insertFileLinks', () => {
		it('inserts at insertion context position when context and matching leaf exist', () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const leaf = { view };
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
				ch: 3,
			};
			const app = createMockApp({ leaves: [leaf] });

			insertFileLinks(['recordings/audio.webm'], context, app);

			expect(app.workspace.getLeavesOfType).toHaveBeenCalledWith(
				'markdown',
			);

			expect(view.editor!.replaceRange).toHaveBeenCalledWith(
				'![[audio.webm]]\n',
				{ line: 8, ch: 0 },
			);
			// Should not fall back to active editor
			expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();
		});

		it('falls back to active editor when insertion context leaf not found', () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
				ch: 3,
			};
			// No leaves match the context filePath
			const app = createMockApp({ activeView, leaves: [] });

			insertFileLinks(['recordings/audio.webm'], context, app);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[audio.webm]]',
			);
		});

		it('falls back to active editor when insertionContext is null', () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const app = createMockApp({ activeView });

			insertFileLinks(['recordings/audio.webm'], null, app);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[audio.webm]]',
			);
		});

		it('does nothing when no editor is available and no context match', () => {
			const app = createMockApp({ activeView: null, leaves: [] });
			const context: InsertionContext = {
				filePath: 'notes/missing.md',
				line: 0,
				ch: 0,
			};

			// Should not throw
			expect(() =>
				insertFileLinks(['recordings/audio.webm'], context, app),
			).not.toThrow();
		});

		it('does nothing when no editor is available and context is null', () => {
			const app = createMockApp({ activeView: null });

			// Should not throw
			expect(() =>
				insertFileLinks(['recordings/audio.webm'], null, app),
			).not.toThrow();
		});

		it('formats links correctly as ![[filename]]', () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView });

			insertFileLinks(
				['path/to/deep/folder/my-recording.mp3'],
				null,
				app,
			);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[my-recording.mp3]]',
			);
		});

		it('handles multiple file links joined with newlines', () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView });

			insertFileLinks(
				[
					'recordings/audio1.webm',
					'recordings/audio2.mp3',
					'recordings/audio3.wav',
				],
				null,
				app,
			);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[audio1.webm]]\n![[audio2.mp3]]\n![[audio3.wav]]',
			);
		});

		it('handles multiple file links at insertion context with newline suffix', () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const leaf = { view };
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 3,
				ch: 0,
			};
			const app = createMockApp({ leaves: [leaf] });

			insertFileLinks(
				['recordings/audio1.webm', 'recordings/audio2.mp3'],
				context,
				app,
			);

			expect(view.editor!.replaceRange).toHaveBeenCalledWith(
				'![[audio1.webm]]\n![[audio2.mp3]]\n',
				{ line: 4, ch: 0 },
			);
		});

		it('uses filename only, stripping directory path', () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView });

			insertFileLinks(['a/b/c/d/recording.flac'], null, app);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[recording.flac]]',
			);
		});

		it('handles file path without directory separators', () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView });

			insertFileLinks(['recording.webm'], null, app);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'![[recording.webm]]',
			);
		});

		it('skips non-matching leaves and finds the correct one', () => {
			const wrongView = createMockView('notes/wrong.md', 0, 0);
			const correctView = createMockView('notes/target.md', 0, 0);
			const wrongLeaf = { view: wrongView };
			const correctLeaf = { view: correctView };
			const context: InsertionContext = {
				filePath: 'notes/target.md',
				line: 5,
				ch: 0,
			};
			const app = createMockApp({ leaves: [wrongLeaf, correctLeaf] });

			insertFileLinks(['recordings/audio.webm'], context, app);

			expect(correctView.editor!.replaceRange).toHaveBeenCalledWith(
				'![[audio.webm]]\n',
				{ line: 6, ch: 0 },
			);
			// Wrong view should not be touched

			expect(wrongView.editor!.replaceRange).not.toHaveBeenCalled();
		});

		it('handles empty file links array', () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = createMockApp({ activeView });

			insertFileLinks([], null, app);

			expect(activeView.editor!.replaceSelection).toHaveBeenCalledWith(
				'',
			);
		});
	});
});
