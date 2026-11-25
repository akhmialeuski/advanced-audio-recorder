/**
 * Unit tests for NoteInserter module.
 * Tests cursor context capture and audio link insertion into notes.
 * @module tests/unit/NoteInserter.test
 */

import type { InsertionContext } from 'src/types';
import type { App, TFile } from 'obsidian';
import {
	createFile,
	createMarkdownView,
	createMockApp,
	type SpiedMarkdownView,
} from '../helpers/createApp';

import {
	captureInsertionContext,
	insertFileLinks,
	insertProcessedAudioEmbed,
	insertTextAtCursor,
} from 'src/recording/NoteInserter';

// DebugLogger mock
function createMockDebugLogger(): { log: jest.Mock } {
	return { log: jest.fn() };
}

/**
 * A mock App with workspace methods, over a vault that indexes every file it
 * is asked about. Links are generated the way Obsidian's default settings
 * produce them, as a shortest-path wikilink, unless a test supplies its own
 * generator.
 * @param overrides - The open views, and the link generator to use
 * @returns The app
 */
function appWithViews(overrides?: {
	activeView?: SpiedMarkdownView | null;
	leaves?: Array<{ view: SpiedMarkdownView }>;
	generateMarkdownLink?: jest.Mock;
	indexed?: boolean;
	/** The notes on disk, by path; written back by `vault.process`. */
	notes?: Record<string, string>;
}): App {
	const activeView = overrides?.activeView ?? null;
	const leaves = overrides?.leaves ?? [];

	return createMockApp({
		workspace: {
			getActiveViewOfType: jest.fn().mockReturnValue(activeView),
			getLeavesOfType: jest.fn().mockReturnValue(leaves),
		},
		vault: {
			getFileByPath: (path: string): TFile | null =>
				overrides?.indexed === false ? null : createFile(path),
			process: jest.fn(
				(file: TFile, change: (content: string) => string) => {
					const notes = overrides?.notes ?? {};
					notes[file.path] = change(notes[file.path] ?? '');
					return Promise.resolve(notes[file.path]);
				},
			),
		},
		fileManager: {
			generateMarkdownLink:
				overrides?.generateMarkdownLink ??
				jest.fn((file: TFile): string => `[[${file.name}]]`),
		},
	}).app;
}

/**
 * A markdown view over a note, optionally with a cursor in it.
 * @param filePath - Note the view shows, or null for a view with no file
 * @param cursorLine - Cursor line
 * @param cursorCh - Cursor column
 * @param mode - The view mode; editing when omitted
 * @returns The view, with every editor method spied, over a note long enough
 *   for every line a test names to be inside it
 */
function createMockView(
	filePath: string | null,
	cursorLine: number,
	cursorCh: number,
	mode: 'source' | 'preview' = 'source',
): SpiedMarkdownView {
	const view = createMarkdownView({
		file: filePath ? createFile(filePath) : null,
		cursor: { line: cursorLine, ch: cursorCh },
		mode,
	});
	view.editor.lastLine.mockReturnValue(100);
	return view;
}

describe('NoteInserter', () => {
	describe('captureInsertionContext', () => {
		it('returns null when insertAtOriginalPosition is false', () => {
			const app = appWithViews();
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, false, logger);

			expect(result).toBeNull();
			// Should not attempt to access workspace at all
			expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();
		});

		it('returns InsertionContext when active MarkdownView has file and cursor', () => {
			const view = createMockView('notes/test.md', 10, 5);
			const app = appWithViews({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toEqual({
				filePath: 'notes/test.md',
				line: 10,
			});
			expect(logger.log).not.toHaveBeenCalled();
		});

		it('returns null and logs when no active MarkdownView', () => {
			const app = appWithViews({ activeView: null });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toBeNull();
			expect(logger.log).toHaveBeenCalledWith(
				'Could not capture insertion context: no active Markdown view',
			);
		});

		it('returns null and logs when view has no file', () => {
			const view = createMockView(null, 3, 0);
			const app = appWithViews({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toBeNull();
			expect(logger.log).toHaveBeenCalledWith(
				'Could not capture insertion context: no active Markdown view',
			);
		});

		it('captures a note in Reading view without a line', () => {
			// Reading view has no cursor; its hidden editor still reports
			// one, which is not where the user is and must not be used.
			const view = createMockView('notes/test.md', 4, 2, 'preview');
			const app = appWithViews({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toEqual({ filePath: 'notes/test.md', line: null });
			expect(view.editor.getCursor).not.toHaveBeenCalled();
			expect(logger.log).not.toHaveBeenCalled();
		});

		it('captures a cursor on the first line', () => {
			const view = createMockView('notes/test.md', 0, 0);
			const app = appWithViews({ activeView: view });
			const logger = createMockDebugLogger();

			const result = captureInsertionContext(app, true, logger);

			expect(result).toEqual({
				filePath: 'notes/test.md',
				line: 0,
			});
		});
	});

	describe('insertFileLinks', () => {
		it('inserts at insertion context position when context and matching leaf exist', async () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const leaf = { view };
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
			};
			const app = appWithViews({ leaves: [leaf] });

			await insertFileLinks(['recordings/audio.webm'], context, app);

			expect(app.workspace.getLeavesOfType).toHaveBeenCalledWith(
				'markdown',
			);

			expect(view.editor.replaceRange).toHaveBeenCalledWith(
				'![[audio.webm]]\n',
				{ line: 8, ch: 0 },
			);
			// Should not fall back to active editor
			expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();
		});

		it('writes the context note through the vault when it is in Reading view', async () => {
			// Regression (#177): the view keeps its editor in Reading view,
			// and a write to it never reaches the note.
			const view = createMockView('notes/daily.md', 0, 0, 'preview');
			const notes = { 'notes/daily.md': 'one\ntwo\nthree\n' };
			const app = appWithViews({ leaves: [{ view }], notes });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				{ filePath: 'notes/daily.md', line: 1 },
				app,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(view.editor.replaceRange).not.toHaveBeenCalled();
			expect(notes['notes/daily.md']).toBe(
				'one\ntwo\n![[audio.webm]]\nthree\n',
			);
		});

		it('writes the context note through the vault when it was closed meanwhile', async () => {
			// The recording was started in this note, so its link belongs
			// there, not in whichever note the user moved on to.
			const activeView = createMockView('notes/other.md', 2, 0);
			const notes = { 'notes/daily.md': 'one\ntwo' };
			const app = appWithViews({ activeView, leaves: [], notes });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				{ filePath: 'notes/daily.md', line: 0 },
				app,
			);

			expect(notePath).toBe('notes/daily.md');
			expect(notes['notes/daily.md']).toBe('one\n![[audio.webm]]\ntwo');
			expect(activeView.editor.replaceSelection).not.toHaveBeenCalled();
		});

		it('adds to the end of a note the recording was started in from Reading view', async () => {
			const view = createMockView('notes/daily.md', 0, 0, 'preview');
			const notes = { 'notes/daily.md': 'one\ntwo\n' };
			const app = appWithViews({ leaves: [{ view }], notes });

			await insertFileLinks(
				['recordings/audio.webm'],
				{ filePath: 'notes/daily.md', line: null },
				app,
			);

			expect(notes['notes/daily.md']).toBe('one\ntwo\n![[audio.webm]]\n');
		});

		it('adds after the last line of the editor when the context has no line', async () => {
			// Started in Reading view, switched to editing before the save.
			const view = createMockView('notes/daily.md', 0, 0);
			view.editor.lastLine.mockReturnValue(2);
			view.editor.getLine.mockReturnValue('three');
			const app = appWithViews({ leaves: [{ view }] });

			await insertFileLinks(
				['recordings/audio.webm'],
				{ filePath: 'notes/daily.md', line: null },
				app,
			);

			expect(view.editor.replaceRange).toHaveBeenCalledWith(
				'\n![[audio.webm]]\n',
				{ line: 2, ch: 5 },
			);
		});

		it('falls back to the active editor when the context note no longer exists', async () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
			};
			const app = appWithViews({
				activeView,
				leaves: [],
				indexed: false,
			});

			await insertFileLinks(['recordings/audio.webm'], context, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[recordings/audio.webm]]',
			);
		});

		it('adds to the end of the active note when it is in Reading view', async () => {
			const activeView = createMockView(
				'notes/other.md',
				3,
				0,
				'preview',
			);
			const notes = { 'notes/other.md': 'text' };
			const app = appWithViews({ activeView, notes });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				null,
				app,
			);

			expect(notePath).toBe('notes/other.md');
			expect(activeView.editor.replaceSelection).not.toHaveBeenCalled();
			expect(notes['notes/other.md']).toBe('text\n![[audio.webm]]\n');
		});

		it('names no note when the active note in Reading view is gone', async () => {
			const activeView = createMockView(
				'notes/other.md',
				0,
				0,
				'preview',
			);
			const app = appWithViews({ activeView, indexed: false });

			await expect(
				insertFileLinks(['recordings/audio.webm'], null, app),
			).resolves.toBeNull();
			expect(app.vault.process).not.toHaveBeenCalled();
		});

		it('names no note for a view in Reading view that shows no file', async () => {
			const activeView = createMockView(null, 0, 0, 'preview');
			const app = appWithViews({ activeView });

			await expect(
				insertFileLinks(['recordings/audio.webm'], null, app),
			).resolves.toBeNull();
			expect(app.vault.process).not.toHaveBeenCalled();
		});

		it('falls back to active editor when insertionContext is null', async () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const app = appWithViews({ activeView });

			await insertFileLinks(['recordings/audio.webm'], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[audio.webm]]',
			);
		});

		it('does nothing when no editor is available and the context note is gone', async () => {
			const app = appWithViews({
				activeView: null,
				leaves: [],
				indexed: false,
			});
			const context: InsertionContext = {
				filePath: 'notes/missing.md',
				line: 0,
			};

			await expect(
				insertFileLinks(['recordings/audio.webm'], context, app),
			).resolves.toBeNull();
		});

		it('does nothing when no editor is available and context is null', async () => {
			const app = appWithViews({ activeView: null });

			await expect(
				insertFileLinks(['recordings/audio.webm'], null, app),
			).resolves.toBeNull();
		});

		it('embeds the link generated for the file', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = appWithViews({ activeView });

			await insertFileLinks(
				['path/to/deep/folder/my-recording.mp3'],
				null,
				app,
			);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[my-recording.mp3]]',
			);
		});

		it('handles multiple file links joined with newlines', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = appWithViews({ activeView });

			await insertFileLinks(
				[
					'recordings/audio1.webm',
					'recordings/audio2.mp3',
					'recordings/audio3.wav',
				],
				null,
				app,
			);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[audio1.webm]]\n![[audio2.mp3]]\n![[audio3.wav]]',
			);
		});

		it('handles multiple file links at insertion context with newline suffix', async () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const leaf = { view };
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 3,
			};
			const app = appWithViews({ leaves: [leaf] });

			await insertFileLinks(
				['recordings/audio1.webm', 'recordings/audio2.mp3'],
				context,
				app,
			);

			expect(view.editor.replaceRange).toHaveBeenCalledWith(
				'![[audio1.webm]]\n![[audio2.mp3]]\n',
				{ line: 4, ch: 0 },
			);
		});

		it('follows the Markdown link format when the vault uses it', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const generateMarkdownLink = jest.fn(
				(): string => '[my take](../Recordings/my%20take.webm)',
			);
			const app = appWithViews({ activeView, generateMarkdownLink });

			await insertFileLinks(['Recordings/my take.webm'], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![my take](../Recordings/my%20take.webm)',
			);
		});

		it('keeps a path the generator adds to tell same-named files apart', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const generateMarkdownLink = jest.fn(
				(file: TFile): string => `[[${file.path}]]`,
			);
			const app = appWithViews({ activeView, generateMarkdownLink });

			await insertFileLinks(['Meetings/Audio/recording.flac'], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[Meetings/Audio/recording.flac]]',
			);
		});

		it('writes one embed marker when the generator already embeds', async () => {
			// generateMarkdownLink prefixes media files with "!" by itself
			const activeView = createMockView('notes/test.md', 0, 0);
			const generateMarkdownLink = jest.fn(
				(): string => '![[recording.webm]]',
			);
			const app = appWithViews({ activeView, generateMarkdownLink });

			await insertFileLinks(['Recordings/recording.webm'], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[recording.webm]]',
			);
		});

		it('generates the link from the note the context names', async () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const active = createMockView('elsewhere/other.md', 0, 0);
			const generateMarkdownLink = jest.fn((): string => '[[x]]');
			const app = appWithViews({
				activeView: active,
				leaves: [{ view }],
				generateMarkdownLink,
			});
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 0,
			};

			await insertFileLinks(['Recordings/a.webm'], context, app);

			expect(generateMarkdownLink).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Recordings/a.webm' }),
				'notes/daily.md',
			);
		});

		it('generates the link from the active note when falling back to it', async () => {
			const activeView = createMockView('notes/other.md', 0, 0);
			const generateMarkdownLink = jest.fn((): string => '[[x]]');
			const app = appWithViews({ activeView, generateMarkdownLink });

			await insertFileLinks(['Recordings/a.webm'], null, app);

			expect(generateMarkdownLink).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Recordings/a.webm' }),
				'notes/other.md',
			);
		});

		it('generates the link from the vault root for a view showing no note', async () => {
			const activeView = createMockView(null, 0, 0);
			const generateMarkdownLink = jest.fn((): string => '[[x]]');
			const app = appWithViews({ activeView, generateMarkdownLink });

			await insertFileLinks(['Recordings/a.webm'], null, app);

			expect(generateMarkdownLink).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Recordings/a.webm' }),
				'',
			);
		});

		it('names the full vault path of a file the vault does not index', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = appWithViews({ activeView, indexed: false });

			await insertFileLinks(['Recordings/recording.webm'], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith(
				'![[Recordings/recording.webm]]',
			);
		});

		it('skips non-matching leaves and finds the correct one', async () => {
			const wrongView = createMockView('notes/wrong.md', 0, 0);
			const correctView = createMockView('notes/target.md', 0, 0);
			const wrongLeaf = { view: wrongView };
			const correctLeaf = { view: correctView };
			const context: InsertionContext = {
				filePath: 'notes/target.md',
				line: 5,
			};
			const app = appWithViews({ leaves: [wrongLeaf, correctLeaf] });

			await insertFileLinks(['recordings/audio.webm'], context, app);

			expect(correctView.editor.replaceRange).toHaveBeenCalledWith(
				'![[audio.webm]]\n',
				{ line: 6, ch: 0 },
			);
			// Wrong view should not be touched

			expect(wrongView.editor.replaceRange).not.toHaveBeenCalled();
		});

		it('handles empty file links array', async () => {
			const activeView = createMockView('notes/test.md', 0, 0);
			const app = appWithViews({ activeView });

			await insertFileLinks([], null, app);

			expect(activeView.editor.replaceSelection).toHaveBeenCalledWith('');
		});

		it('returns the context note path when inserted at the captured context', async () => {
			const view = createMockView('notes/daily.md', 5, 0);
			const context: InsertionContext = {
				filePath: 'notes/daily.md',
				line: 7,
			};
			const app = appWithViews({ leaves: [{ view }] });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				context,
				app,
			);

			expect(notePath).toBe('notes/daily.md');
		});

		it('returns the active note path when falling back to the active editor', async () => {
			const activeView = createMockView('notes/other.md', 2, 0);
			const app = appWithViews({ activeView, leaves: [] });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				null,
				app,
			);

			expect(notePath).toBe('notes/other.md');
		});

		it('returns null when no editor is available to receive the links', async () => {
			const app = appWithViews({ activeView: null, leaves: [] });

			const notePath = await insertFileLinks(
				['recordings/audio.webm'],
				null,
				app,
			);

			expect(notePath).toBeNull();
		});
	});

	describe('insertTextAtCursor', () => {
		it("inserts at the active note's cursor", () => {
			const active = createMockView('notes/other.md', 0, 0);
			const app = appWithViews({
				activeView: active,
				leaves: [{ view: active }],
			});

			expect(insertTextAtCursor(app, 'dictated')).toBe('notes/other.md');
			expect(active.editor.replaceSelection).toHaveBeenCalledWith(
				'dictated',
			);
		});

		it('inserts nothing into a note in Reading view, which has no cursor', () => {
			// The caller then keeps the text on the clipboard instead of
			// writing it to a hidden editor that never reaches the note.
			const reading = createMockView('notes/other.md', 0, 0, 'preview');
			const app = appWithViews({ activeView: reading });

			expect(insertTextAtCursor(app, 'dictated')).toBeNull();
			expect(reading.editor.replaceSelection).not.toHaveBeenCalled();
		});

		it('names no note for an active view that shows no file', () => {
			const unsaved = createMockView(null, 0, 0);
			const app = appWithViews({
				activeView: unsaved,
				leaves: [{ view: unsaved }],
			});

			expect(insertTextAtCursor(app, 'dictated')).toBeNull();
			expect(unsaved.editor.replaceSelection).toHaveBeenCalledWith(
				'dictated',
			);
		});

		it('reports that no note took the text when none is open', () => {
			expect(insertTextAtCursor(appWithViews(), 'dictated')).toBeNull();
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
			indexed?: boolean;
		}): { app: App; getContent: () => string } {
			const note =
				opts.noteActive === false
					? null
					: createFile(`notes/daily.${opts.noteExtension ?? 'md'}`);
			let content = opts.content;
			const app = createMockApp({
				workspace: {
					getActiveFile: (): TFile | null => note,
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
					getFileByPath: (path: string): TFile | null =>
						opts.indexed === false ? null : createFile(path),
					process: (
						_note: unknown,
						fn: (current: string) => string,
					): Promise<string> => {
						content = fn(content);
						return Promise.resolve(content);
					},
				},
				fileManager: {
					generateMarkdownLink: (file: TFile): string =>
						`[[${file.path.split('/').pop() ?? file.path}]]`,
				},
			}).app;
			return { app, getContent: (): string => content };
		}

		const source = (): TFile => createFile('Audio/recording.mp4');

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

		it('names the full vault path of a processed file the vault does not index', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'intro\n![[recording.mp4]]\noutro',
				indexed: false,
			});

			await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				true,
			);

			expect(getContent()).toBe(
				'intro\n![[Audio/recording-clean.wav]]\noutro',
			);
		});

		it('writes into the note it is given rather than the active one', async () => {
			const { app, getContent } = buildEmbedApp({
				noteActive: false,
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: '![[recording.mp4]]',
			});

			const notePath = await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				false,
				createFile('Meetings/standup.md'),
			);

			expect(notePath).toBe('Meetings/standup.md');
			expect(getContent()).toBe(
				'![[recording.mp4]]\n![[recording-clean.wav]]',
			);
		});

		it('leaves the note as it is when the embed left it since it was read', async () => {
			const { app, getContent } = buildEmbedApp({
				embeds: [
					{ link: 'recording.mp4', original: '![[recording.mp4]]' },
				],
				resolves: { 'recording.mp4': 'Audio/recording.mp4' },
				content: 'intro\noutro',
			});

			await insertProcessedAudioEmbed(
				app,
				source(),
				'Audio/recording-clean.wav',
				false,
			);

			expect(getContent()).toBe('intro\noutro');
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
