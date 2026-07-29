/**
 * Unit tests for NoteInserter module.
 * Tests cursor context capture and audio link insertion into notes.
 * @module tests/unit/NoteInserter.test
 */

import type { InsertionContext } from 'src/types';
import { at } from '../helpers/assertions';
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

/** Mock TFile for the instanceof check in insertProcessedAudioEmbed. */
class MockTFile {
	path: string;
	extension: string;
	constructor(path: string) {
		this.path = path;
		this.extension = path.split('.').pop() ?? '';
	}
}

jest.mock('obsidian', () => ({
	MarkdownView: MockMarkdownView,
	TFile: MockTFile,
	getLinkpath: (link: string): string =>
		at(at(link.split('#'), 0).split('|'), 0).trim(),
}));

import {
	captureInsertionContext,
	insertFileLinks,
	insertProcessedAudioEmbed,
} from 'src/recording/NoteInserter';
import type { TFile } from 'obsidian';

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

		it('returns the context note path when inserted at the captured context', () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
				ch: 3,
			};
			const app = createMockApp({ leaves: [{ view }] });

			const notePath = insertFileLinks(
				['recordings/audio.webm'],
				context,
				app,
			);

			expect(notePath).toBe('notes/daily.md');
		});

		it('returns the active note path when falling back to the active editor', () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const app = createMockApp({ activeView, leaves: [] });

			const notePath = insertFileLinks(
				['recordings/audio.webm'],
				null,
				app,
			);

			expect(notePath).toBe('notes/other.md');
		});

		it('returns null when no editor is available to receive the links', () => {
			const app = createMockApp({ activeView: null, leaves: [] });

			const notePath = insertFileLinks(
				['recordings/audio.webm'],
				null,
				app,
			);

			expect(notePath).toBeNull();
		});
	});

	describe('insertProcessedAudioEmbed', () => {
		// Builds an app whose active note embeds a single source file, with
		// the note body editable through a captured vault.process callback.
		function buildEmbedApp(opts: {
			noteExtension?: string;
			noteActive?: boolean;
			embeds?: Array<{ link: string; original: string }>;
			resolves?: Record<string, string>;
			content: string;
		}): { app: App; getContent: () => string } {
			const note =
				opts.noteActive === false
					? null
					: new MockTFile(
							`notes/daily.${opts.noteExtension ?? 'md'}`,
						);
			let content = opts.content;
			const app = {
				workspace: {
					getActiveFile: (): MockTFile | null => note,
				},
				metadataCache: {
					getFileCache: (): { embeds: typeof opts.embeds } => ({
						embeds: opts.embeds ?? [],
					}),
					getFirstLinkpathDest: (
						linkpath: string,
					): { path: string } | null => {
						const dest = opts.resolves?.[linkpath];
						return dest ? { path: dest } : null;
					},
				},
				vault: {
					getFileByPath: (path: string): MockTFile =>
						new MockTFile(path),
					process: (
						_note: unknown,
						fn: (current: string) => string,
					): Promise<string> => {
						content = fn(content);
						return Promise.resolve(content);
					},
				},
				fileManager: {
					generateMarkdownLink: (file: MockTFile): string =>
						`[[${file.path.split('/').pop() ?? file.path}]]`,
				},
			} as unknown as App;
			return { app, getContent: (): string => content };
		}

		const source = (): TFile =>
			new MockTFile('Audio/recording.mp4') as unknown as TFile;

		it('replaces the source embed when the source is being deleted', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'intro\n![[recording.mp4]]\noutro',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(getContent()).toBe('intro\n![[recording-clean.wav]]\noutro');
		});

		it('inserts the new embed after the source when it is kept', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'intro\n![[recording.mp4]]\noutro',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				false,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(getContent()).toBe(
				'intro\n![[recording.mp4]]\n![[recording-clean.wav]]\noutro',
			);
		});

		it('returns null when the active note does not embed the source', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [{ link: 'other.mp4', original: '![[other.mp4]]' }],
				resolves: { 'other.mp4': 'Audio/other.mp4' },
				content: 'intro\n![[other.mp4]]\noutro',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(notePath).toBeNull();
			// The note body must stay untouched when no embed matched
			expect(getContent()).toBe('intro\n![[other.mp4]]\noutro');
		});

		it('returns null when there is no active markdown note', async () => {
			const { app } = buildEmbedApp({
				noteActive: false,
				content: '',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(notePath).toBeNull();
		});

		it('returns null when the active file is not a markdown note', async () => {
			const { app } = buildEmbedApp({
				noteExtension: 'canvas',
				content: '',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(notePath).toBeNull();
		});

		it('writes a processed filename containing $ verbatim', async () => {
			// A `$&`/`$$` in the replacement would be reinterpreted by
			// String.prototype.replace, corrupting the note. The link text must
			// land in the note exactly as generated.
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'intro\n![[recording.mp4]]\noutro',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/clean $& $$.wav',
				true,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(getContent()).toBe('intro\n![[clean $& $$.wav]]\noutro');
		});

		it('replaces every embed of the source when it is being deleted', async () => {
			// The source embedded twice must leave no occurrence behind, or
			// trashing it would orphan the un-rewritten embed.
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'a\n![[recording.mp4]]\nb\n![[recording.mp4]]\nc',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(getContent()).toBe(
				'a\n![[recording-clean.wav]]\nb\n![[recording-clean.wav]]\nc',
			);
		});

		it('replaces distinct source embeds (plain and aliased) alike', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
					{
						link: 'recording.mp4',
						original: '![[recording.mp4|My audio]]',
					},
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content:
					'a\n![[recording.mp4]]\nb\n![[recording.mp4|My audio]]\nc',
			});

			await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(getContent()).toBe(
				'a\n![[recording-clean.wav]]\nb\n![[recording-clean.wav]]\nc',
			);
		});

		it('inserts after the first embed only when the source is kept', async () => {
			// Keeping a twice-embedded source must add the processed embed once,
			// after the first occurrence, not once per occurrence.
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'a\n![[recording.mp4]]\nb\n![[recording.mp4]]\nc',
			});

			await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				false,
			);

			expect(getContent()).toBe(
				'a\n![[recording.mp4]]\n![[recording-clean.wav]]\nb\n![[recording.mp4]]\nc',
			);
		});
	});
});
