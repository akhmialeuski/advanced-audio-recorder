/**
 * Unit tests for ContextMenu. Behavior-focused: menus are rendered into a
 * recording Menu fake and asserted by their visible item titles and what
 * each item's click actually does (modals opened, files trashed, links
 * removed), not by the setIcon/setSection call structure - so harmless
 * implementation changes do not break the suite while real regressions
 * (a missing action, a click doing the wrong thing) still do.
 * @module tests/unit/ContextMenu.test
 */

import { ContextMenu } from 'src/actions/ContextMenu';
import type { ActionServices } from 'src/actions/core/actionServices';
import { AUDIO_EXTENSIONS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import * as AudioFileAnalyzer from 'src/utils/AudioFileAnalyzer';
import { at, defined } from '../helpers/assertions';
import { noticeMessages } from '../mocks/obsidian';
import { tick } from '../helpers/async';
import { asMockMenu, partialPlugin } from '../helpers/obsidianMock';
import { setPlayerEmbedActions } from 'src/player/playerEmbedActions';
import type { PlayerEmbedActions } from 'src/player/playerEmbedActions';
import {
	App,
	Menu,
	TFile,
	Plugin,
	Editor,
	Notice,
	Workspace,
	MetadataCache,
	Vault,
	FileManager,
	MarkdownView,
	TFolder,
} from 'obsidian';
import {
	partial,
	commonActionServices,
	queueServicesDouble,
	internalsOf,
} from '../helpers/doubles';
import { registeredMenus } from '../helpers/menuFamilies';
import { createFile, createMockApp } from '../helpers/createApp';
import {
	mountLiveEditor,
	rangeOf,
	type LiveEditor,
} from '../helpers/liveEditor';
import { registerDomEventOnAllWindows } from 'src/utils/multiWindowDomEvents';
import { AudioFileInfoModal } from 'src/ui/AudioFileInfoModal';
import { SplitModal } from 'src/ui/SplitModal';
import { AudioProcessingModal } from 'src/cleanup/AudioProcessingModal';

// The player menu binds through registerDomEventOnAllWindows (one listener
// per Obsidian window). These unit tests exercise the handler itself, so the
// primitive is mocked to capture the registered handler; its own cross-window
// behavior is covered in tests/unit/multiWindowDomEvents.test.ts.
jest.mock('src/utils/multiWindowDomEvents', () => ({
	registerDomEventOnAllWindows: jest.fn(),
}));

jest.mock('src/ui/AudioFileInfoModal', () => ({
	AudioFileInfoModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

jest.mock('src/ui/ConversionModal', () => ({
	ConversionModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

jest.mock('src/ui/SplitModal', () => ({
	SplitModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

jest.mock('src/ui/SpeakerRenameModal', () => ({
	SpeakerRenameModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

jest.mock('src/cleanup/AudioProcessingModal', () => ({
	AudioProcessingModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
}));

// Mock AudioEncoder to avoid mediabunny TextDecoder requirement
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
}));

/** The visible item titles of a rendered menu. */
function titlesOf(menu: Menu): string[] {
	return asMockMenu(menu).items.map((item) => item.title);
}

/**
 * Clicks the menu item with the given title.
 *
 * The mock's own click() names the entries it does have when the title is
 * missing, so a renamed item fails here rather than three assertions later.
 * @param menu - The rendered menu
 * @param title - Exact item title
 */
async function clickItem(menu: Menu, title: string): Promise<void> {
	asMockMenu(menu).click(title);
	// The handlers are async and fire-and-forget from the menu's point of
	// view; let them settle before the assertions run.
	await tick();
}

describe('ContextMenu', () => {
	let contextMenu: ContextMenu;
	let mockApp: App;
	let mockPlugin: Plugin;
	let mockWorkspace: Workspace;
	let mockMetadataCache: MetadataCache;
	let mockVault: Vault;
	let mockFileManager: FileManager;

	beforeEach(() => {
		mockWorkspace = partial<Workspace>({
			on: jest.fn(),
			trigger: jest.fn(),
			getActiveFile: jest.fn(),
			getActiveViewOfType: jest.fn(),
			iterateAllLeaves: jest.fn(),
		});

		mockMetadataCache = partial<MetadataCache>({
			getFirstLinkpathDest: jest.fn(),
			getFileCache: jest.fn().mockReturnValue(null),
		});

		mockVault = partial<Vault>({
			delete: jest.fn(),
		});

		mockFileManager = {
			trashFile: jest.fn(),
		} as unknown as FileManager;

		mockApp = createMockApp({
			workspace: mockWorkspace,
			metadataCache: mockMetadataCache,
			vault: mockVault,
			fileManager: mockFileManager,
		}).app;

		mockPlugin = partialPlugin({
			registerEvent: jest.fn(),
			registerDomEvent: jest.fn(),
		});

		contextMenu = menuWith({
			deleteSourceAfterConversion: true,
			conversionLinkAction: 'replace',
		});
	});

	/**
	 * A context menu over the given settings, rendering the families the
	 * plugin registers.
	 * @param settings - The settings the actions read
	 * @param services - Services this case varies
	 */
	function menuWith(
		settings: Partial<AudioRecorderSettings>,
		services: Partial<ActionServices> = {},
	): ContextMenu {
		const all: ActionServices = {
			app: mockApp,
			getSettings: () => partial<AudioRecorderSettings>(settings),
			...commonActionServices(),
			...services,
		};
		const { registry, families } = registeredMenus(all);
		return new ContextMenu(mockPlugin, all, registry, families);
	}

	function makeAudioFile(extension = 'mp3'): TFile {
		const file = new TFile();
		Object.defineProperty(file, 'extension', { value: extension });
		return file;
	}

	describe('register', () => {
		it('registers file, editor, and player menus', () => {
			contextMenu.register();

			expect(mockWorkspace.on).toHaveBeenCalledWith(
				'file-menu',
				expect.any(Function),
			);
			expect(mockPlugin.registerEvent).toHaveBeenCalled();
			expect(mockWorkspace.on).toHaveBeenCalledWith(
				'editor-menu',
				expect.any(Function),
			);
			expect(
				jest.mocked(registerDomEventOnAllWindows),
			).toHaveBeenCalledWith(
				mockPlugin,
				mockApp,
				'contextmenu',
				expect.any(Function),
				{ capture: true },
			);
		});
	});

	describe('registerFileMenu', () => {
		let fileMenuCallback: (menu: Menu, file: TFile) => void;

		beforeEach(() => {
			contextMenu.register();
			const call = (mockWorkspace.on as jest.Mock).mock.calls.find(
				(c) => c[0] === 'file-menu',
			);
			fileMenuCallback = call[1];
		});

		test.each(AUDIO_EXTENSIONS)(
			'offers the recording actions for %s files',
			(extension) => {
				const menu = new Menu();

				fileMenuCallback(menu, makeAudioFile(extension));

				expect(titlesOf(menu)).toContain('Delete recording');
			},
		);

		it('removes the links of the note a link was right-clicked in', async () => {
			const menu = new Menu();
			const recording = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(recording);
			(mockMetadataCache.getFileCache as jest.Mock).mockReturnValue({
				embeds: [
					{ link: 'audio.mp3', position: { start: { offset: 0 } } },
				],
			});
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				file: { path: 'Meetings/standup.md' },
			});

			(
				fileMenuCallback as (
					menu: Menu,
					file: TFile,
					source: string,
				) => void
			)(menu, recording, 'link-context-menu');
			await clickItem(menu, 'Delete recording & link to file');

			expect(noticeMessages().join(' ')).toContain(
				'from Meetings/standup.md',
			);
		});

		it('acts on a link right-clicked in a note through that note', () => {
			const menu = new Menu();
			const note = Object.assign(Object.create(TFile.prototype), {
				path: 'Meetings/standup.md',
				extension: 'md',
			}) as TFile;
			const leaf = {
				view: Object.assign(
					Object.create(
						internalsOf<{ prototype: object }>(MarkdownView)
							.prototype,
					),
					{ file: note },
				),
			};

			(
				fileMenuCallback as (
					menu: Menu,
					file: TFile,
					source: string,
					leaf: unknown,
				) => void
			)(menu, makeAudioFile(), 'link-context-menu', leaf);

			expect(titlesOf(menu)).toContain('Delete recording & link to file');
			expect(titlesOf(menu)).not.toContain('Delete recording');
		});

		it.each([
			{
				name: 'the active note when Obsidian names no leaf',
				active: { file: { path: 'Meetings/standup.md' } },
				offered: 'Delete recording & link to file',
			},
			{
				name: 'no note when none is open',
				active: null,
				offered: 'Delete recording & link to file',
			},
		])('takes a link right-clicked from $name', ({ active, offered }) => {
			const menu = new Menu();
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue(
				active,
			);

			(
				fileMenuCallback as (
					menu: Menu,
					file: TFile,
					source: string,
				) => void
			)(menu, makeAudioFile(), 'link-context-menu');

			// A link is reached through, note or not: never the plain delete.
			expect(titlesOf(menu)).toContain(offered);
			expect(titlesOf(menu)).not.toContain('Delete recording');
		});

		it('offers the full action set for an audio file (transcription off)', () => {
			const menu = new Menu();

			fileMenuCallback(menu, makeAudioFile());

			expect(titlesOf(menu)).toEqual([
				'Audio file info',
				'Convert audio format',
				'Split audio into parts',
				'Clean up audio',
				'Export chapters and markers',
				'Delete recording',
			]);
		});

		/** A folder, as the vault hands one to the menu handler. */
		function folder(): TFolder {
			return Object.assign(Object.create(TFolder.prototype), {
				name: 'Recordings',
				path: 'Recordings',
				children: [],
			}) as TFolder;
		}

		/**
		 * Fires the file menu for a folder against a menu built with the
		 * given transcription setting.
		 * @param transcriptionEnabled - Whether transcription is on
		 * @returns The menu, and the queue the entry would reach
		 */
		function folderMenu(transcriptionEnabled: boolean): {
			menu: Menu;
			queueFolder: jest.Mock;
		} {
			const queueFolder = jest.fn().mockResolvedValue(undefined);
			menuWith(
				{ transcriptionEnabled },
				{
					transcriptionQueue: {
						...queueServicesDouble(),
						queueFolder,
					},
				},
			).register();
			const call = (mockWorkspace.on as jest.Mock).mock.calls
				.filter((c) => c[0] === 'file-menu')
				.at(-1);
			const menu = new Menu();
			(call?.[1] as (m: Menu, f: TFolder) => void)(menu, folder());
			return { menu, queueFolder };
		}

		// A folder is not a file action: it targets no recording, and every
		// entry in that list would be wrong for it. It gets the one thing
		// that does apply to a folder.
		it('offers to queue a folder of recordings', () => {
			const { menu } = folderMenu(true);

			expect(titlesOf(menu)).toEqual([
				'Transcribe every recording in this folder',
			]);
		});

		it('queues the folder that was right-clicked', async () => {
			const { menu, queueFolder } = folderMenu(true);

			await clickItem(menu, 'Transcribe every recording in this folder');

			expect(queueFolder).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Recordings' }),
			);
		});

		it('offers a folder nothing while transcription is off', () => {
			const { menu } = folderMenu(false);

			expect(titlesOf(menu)).toEqual([]);
		});

		it('opens the file-info modal from "Audio file info"', async () => {
			const menu = new Menu();
			const file = makeAudioFile();
			const info = {
				fileName: 'audio.mp3',
				fileSize: '1 KB',
				duration: '0:10',
				containerFormat: 'MP3',
				audioCodec: 'mp3',
				bitrate: '128 kbps',
				sampleRate: '44.1 kHz',
				channels: 'Stereo',
			};
			jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
				info,
			);

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Audio file info');

			expect(AudioFileAnalyzer.getAudioFileInfo).toHaveBeenCalledWith(
				mockApp,
				file,
			);
			expect(jest.mocked(AudioFileInfoModal)).toHaveBeenCalledTimes(1);
		});

		it('does not open the file-info modal when analysis fails', async () => {
			const menu = new Menu();
			jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
				null,
			);

			fileMenuCallback(menu, makeAudioFile());
			await clickItem(menu, 'Audio file info');

			expect(jest.mocked(AudioFileInfoModal)).not.toHaveBeenCalled();
		});

		it('does not duplicate actions when both menu hooks fire for one menu', () => {
			const menu = new Menu();
			const file = makeAudioFile();

			// Simulate both editor-menu and file-menu firing for the same Menu
			fileMenuCallback(menu, file);
			fileMenuCallback(menu, file);

			const titles = titlesOf(menu);
			expect(titles.filter((t) => t === 'Audio file info')).toHaveLength(
				1,
			);
			expect(
				titles.filter((t) => t === 'Split audio into parts'),
			).toHaveLength(1);
		});

		it('opens SplitModal with a live settings accessor from "Split audio into parts"', async () => {
			const menu = new Menu();
			const file = makeAudioFile();

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Split audio into parts');

			expect(jest.mocked(SplitModal)).toHaveBeenCalledWith(
				mockApp,
				file,
				expect.any(Function),
				// The sidecar, so the dialog can offer to cut at the
				// recording's own chapters
				expect.anything(),
			);
			// Every dialog takes an accessor rather than a snapshot, so it reads
			// the settings that are current when it opens.
			const getSettings = at(
				(SplitModal as jest.Mock).mock.calls,
				0,
			)[2] as () => AudioRecorderSettings;
			expect(getSettings()).toEqual(
				expect.objectContaining({ deleteSourceAfterConversion: true }),
			);
		});

		it('opens AudioProcessingModal from "Clean up audio"', async () => {
			const menu = new Menu();
			const file = makeAudioFile();

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Clean up audio');

			expect(jest.mocked(AudioProcessingModal)).toHaveBeenCalledWith(
				mockApp,
				file,
				expect.any(Function),
				expect.any(Function),
			);
		});

		it('offers no actions for non-audio files', () => {
			const menu = new Menu();

			fileMenuCallback(menu, makeAudioFile('md'));

			expect(titlesOf(menu)).toEqual([]);
		});

		it('trashes the file and confirms from "Delete recording"', async () => {
			const menu = new Menu();
			const file = makeAudioFile();

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Delete recording');

			expect(mockFileManager.trashFile).toHaveBeenCalledWith(file);
			expect(Notice).toHaveBeenCalledWith('Recording deleted');
		});

		it('reports a deletion failure without throwing', async () => {
			const menu = new Menu();
			(mockFileManager.trashFile as jest.Mock).mockRejectedValue(
				new Error('Delete failed'),
			);
			const consoleSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {});

			fileMenuCallback(menu, makeAudioFile());
			await clickItem(menu, 'Delete recording');

			expect(Notice).toHaveBeenCalledWith('Failed to delete recording');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('registerEditorMenu', () => {
		let editorMenuCallback: (
			menu: Menu,
			editor: Editor,
			view: unknown,
		) => void;
		let mockEditor: Editor;

		beforeEach(() => {
			contextMenu.register();
			const call = (mockWorkspace.on as jest.Mock).mock.calls.find(
				(c) => c[0] === 'editor-menu',
			);
			editorMenuCallback = call[1];

			mockEditor = partial<Editor>({
				getCursor: jest.fn().mockReturnValue({ line: 0, ch: 0 }),
				somethingSelected: jest.fn().mockReturnValue(false),
				getLine: jest.fn(),
				replaceRange: jest.fn(),
				offsetToPos: jest.fn(),
			});
		});

		test.each(AUDIO_EXTENSIONS)(
			'offers "Delete recording & link to file" for %s links',
			(extension) => {
				const menu = new Menu();
				(mockEditor.getLine as jest.Mock).mockReturnValue(
					`[[audio.${extension}]]`,
				);
				(mockEditor.getCursor as jest.Mock).mockReturnValue({
					line: 0,
					ch: 2,
				});
				(
					mockMetadataCache.getFirstLinkpathDest as jest.Mock
				).mockReturnValue(makeAudioFile(extension));

				editorMenuCallback(menu, mockEditor, {});

				expect(titlesOf(menu)).toContain(
					'Delete recording & link to file',
				);
			},
		);

		it.each([
			{
				name: 'a timecode link, without its subpath',
				line: '[[audio.mp3#t=30|0:30]] Speaker 1',
				ch: 5,
				path: 'audio.mp3',
			},
			{
				name: 'an encoded Markdown link, decoded',
				line: 'Take [one](Recordings/my%20take.mp3)',
				ch: 8,
				path: 'Recordings/my take.mp3',
			},
			{
				name: 'the link the cursor sits just past',
				line: 'Text [[audio.mp3]] Text',
				ch: 18,
				path: 'audio.mp3',
			},
		])('resolves $name', ({ line, ch, path }) => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue(line);
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			editorMenuCallback(menu, mockEditor, {});

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				path,
				'',
			);
		});

		/**
		 * Opens the editor menu on the first link of a line.
		 * @param line - The line the cursor is on
		 * @returns The titles of the menu that opened
		 */
		function editorMenuOn(line: string): string[] {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue(line);
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 3,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			editorMenuCallback(menu, mockEditor, {});

			return titlesOf(menu);
		}

		it.each([
			{ name: 'a timestamp', line: '[[audio.mp3#t=30|0:30]] Speaker 1' },
			{ name: 'an unreadable timestamp', line: '[[audio.mp3#t=abc]]' },
			{ name: 'a Markdown timestamp', line: '[0:30](audio.mp3#t=30)' },
		])('offers no delete on $name', ({ line }) => {
			// A transcript holds dozens of timestamps to one recording;
			// trashing it from one would leave the rest pointing at nothing.
			const titles = editorMenuOn(line);

			expect(titles).not.toContain('Delete recording & link to file');
			expect(titles).not.toContain('Delete recording');
		});

		it('keeps the non-destructive file actions on a timestamp', () => {
			expect(editorMenuOn('[[audio.mp3#t=30|0:30]]')).toContain(
				'Audio file info',
			);
		});

		it('offers link deletion on a link to a heading in the recording', () => {
			expect(editorMenuOn('[[audio.mp3#Intro]]')).toContain(
				'Delete recording & link to file',
			);
		});

		it('offers nothing when no link is at the cursor', () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue('Just text');

			editorMenuCallback(menu, mockEditor, {});

			expect(titlesOf(menu)).toEqual([]);
		});

		it('offers nothing when the link resolves to a non-audio file', () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue('[[note]]');
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 2,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile('md'));

			editorMenuCallback(menu, mockEditor, {});

			expect(titlesOf(menu)).toEqual([]);
		});

		it('deletes the file and removes the link text on click', async () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue(
				'Text [[audio.mp3]] Text',
			);
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 7,
			});
			const file = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(file);

			editorMenuCallback(menu, mockEditor, {});
			await clickItem(menu, 'Delete recording & link to file');

			expect(mockFileManager.trashFile).toHaveBeenCalledWith(file);
			// "Text [[audio.mp3]] Text": the link spans columns 5..18
			expect(mockEditor.replaceRange).toHaveBeenCalledWith(
				'',
				{ line: 0, ch: 5 },
				{ line: 0, ch: 18 },
			);
			expect(Notice).toHaveBeenCalledWith('Recording and link deleted');
		});

		it('reports a deletion failure from the editor menu', async () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 2,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());
			(mockFileManager.trashFile as jest.Mock).mockRejectedValue(
				new Error('Delete failed'),
			);
			const consoleSpy = jest
				.spyOn(console, 'error')
				.mockImplementation();

			editorMenuCallback(menu, mockEditor, {});
			await clickItem(menu, 'Delete recording & link to file');

			expect(Notice).toHaveBeenCalledWith('Failed to delete recording');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});

		it('recognizes markdown-style links', () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue(
				'[link](audio.mp3)',
			);
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 10,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			editorMenuCallback(menu, mockEditor, {});

			expect(titlesOf(menu)).toContain('Delete recording & link to file');
		});

		it('resolves the link without a source path when the view has no file', () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 2,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			editorMenuCallback(menu, mockEditor, {});

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'',
			);
			expect(titlesOf(menu)).not.toEqual([]);
		});

		it("resolves the link against the view's file path", () => {
			const menu = new Menu();
			(mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
			(mockEditor.getCursor as jest.Mock).mockReturnValue({
				line: 0,
				ch: 2,
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			editorMenuCallback(menu, mockEditor, {
				file: { path: 'view.md' },
			});

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'view.md',
			);
			expect(titlesOf(menu)).not.toEqual([]);
		});
	});

	describe('transcript selection in the editor menu', () => {
		const line = '[[rec.m4a#t=5|0:05]] **Speaker 1** Sure. Go ahead.';

		/**
		 * Opens the editor menu on a selection of the transcript line, or on
		 * one reaching from it into the line below.
		 */
		function openOn(from: number, to: number, toLine = 0): Menu {
			const audio = makeAudioFile('m4a');
			const menu = new Menu();
			const transcriptMenu = menuWith({ transcriptionEnabled: true });
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(audio);
			transcriptMenu.register();
			const call = (mockWorkspace.on as jest.Mock).mock.calls
				.filter((c) => c[0] === 'editor-menu')
				.at(-1);
			const editor = partial<Editor>({
				somethingSelected: () => toLine > 0 || from !== to,
				getCursor: (which?: string) =>
					which === 'to'
						? { line: toLine, ch: to }
						: { line: 0, ch: from },
				getLine: () => line,
			});
			call[1](menu, editor, {
				file: partial<TFile>({ path: 'Notes/meeting.md' }),
			});
			return menu;
		}

		it('offers the split on a selection in a transcript line', () => {
			const from = line.indexOf('Go ahead.');

			const menu = openOn(from, from + 'Go ahead.'.length);

			expect(titlesOf(menu)).toContain(
				'Split selection into another speaker',
			);
		});

		it('offers the merge, not the split, on a selection over two lines', () => {
			const menu = openOn(30, 10, 1);

			expect(titlesOf(menu)).toContain('Merge selected lines into one');
			expect(titlesOf(menu)).not.toContain(
				'Split selection into another speaker',
			);
		});

		it('offers no merge on a selection inside one line', () => {
			const from = line.indexOf('Go ahead.');

			const menu = openOn(from, from + 'Go ahead.'.length);

			expect(titlesOf(menu)).not.toContain(
				'Merge selected lines into one',
			);
		});

		it('offers no split without a selection', () => {
			const menu = openOn(30, 30);

			expect(titlesOf(menu)).not.toContain(
				'Split selection into another speaker',
			);
		});
	});

	describe('registerPlayerMenu', () => {
		let playerMenuCallback: (event: MouseEvent) => void;

		beforeEach(() => {
			contextMenu.register();
			const call = (
				registerDomEventOnAllWindows as jest.Mock
			).mock.calls.find((c) => c[2] === 'contextmenu');
			playerMenuCallback = call[3];
		});

		function makeEmbedEvent(src = 'audio.mp3'): MouseEvent {
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			embed.setAttribute('src', src);
			const target = document.createElement('span');
			embed.appendChild(target);
			return partial<MouseEvent>({
				target,
				pageX: 100,
				pageY: 200,
				preventDefault: jest.fn(),
				stopPropagation: jest.fn(),
			});
		}

		/** The menu the player handler passed to workspace.trigger. */
		function triggeredMenu(): Menu {
			const call = (mockWorkspace.trigger as jest.Mock).mock.calls.find(
				(c) => c[0] === 'file-menu',
			);
			if (!call) {
				throw new Error('file-menu was not triggered');
			}
			return call[1] as Menu;
		}

		test.each(AUDIO_EXTENSIONS)(
			'shows the context menu for %s embeds',
			(extension) => {
				const event = makeEmbedEvent(`audio.${extension}`);
				const file = makeAudioFile(extension);
				(
					mockMetadataCache.getFirstLinkpathDest as jest.Mock
				).mockReturnValue(file);
				(mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(
					null,
				);

				playerMenuCallback(event);

				expect(event.preventDefault).toHaveBeenCalledTimes(1);
				expect(mockWorkspace.trigger).toHaveBeenCalledWith(
					'file-menu',
					expect.any(Object),
					file,
					'audio-recorder-player-context-menu',
				);
			},
		);

		it('does nothing when the target is not inside an internal embed', () => {
			playerMenuCallback(
				partial<MouseEvent>({
					target: document.createElement('div'),
				}),
			);

			expect(
				mockMetadataCache.getFirstLinkpathDest,
			).not.toHaveBeenCalled();
		});

		it('does nothing when the embed has no src', () => {
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			const target = document.createElement('span');
			embed.appendChild(target);

			playerMenuCallback(partial<MouseEvent>({ target }));

			expect(
				mockMetadataCache.getFirstLinkpathDest,
			).not.toHaveBeenCalled();
		});

		it('resolves the embed against the active file and shows the menu', () => {
			const event = makeEmbedEvent();
			const file = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(file);
			const activeFile = new TFile();
			activeFile.path = 'active.md';
			(mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(
				activeFile,
			);

			playerMenuCallback(event);

			expect(event.preventDefault).toHaveBeenCalledTimes(1);
			expect(event.stopPropagation).toHaveBeenCalledTimes(1);
			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'active.md',
			);
			// Opened from the event, which carries the window it happened in.
			expect(asMockMenu(triggeredMenu()).shownAtEvent).toBe(event);
		});

		it('does nothing when the file cannot be resolved', () => {
			const event = makeEmbedEvent();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(null);

			playerMenuCallback(event);

			expect(mockWorkspace.trigger).not.toHaveBeenCalled();
		});

		it('resolves without a source path when there is no active file', () => {
			const event = makeEmbedEvent();
			(mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(null);
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			playerMenuCallback(event);

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'',
			);
			expect(mockWorkspace.trigger).toHaveBeenCalledTimes(1);
		});

		it('resolves the embed against the note that contains it, not the active file', () => {
			// The embed lives inside a specific view's container (a pop-out or a
			// background split), whose note differs from the globally active file.
			const containerEl = document.createElement('div');
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			embed.setAttribute('src', 'audio.mp3');
			const target = document.createElement('span');
			embed.appendChild(target);
			containerEl.appendChild(embed);

			const owningView = Object.assign(
				Object.create(
					internalsOf<{ prototype: object }>(MarkdownView).prototype,
				),
				{ containerEl, file: { path: 'owner.md' }, editor: {} },
			);
			(mockWorkspace.iterateAllLeaves as jest.Mock).mockImplementation(
				(cb: (leaf: { view: unknown }) => void) =>
					cb({ view: owningView }),
			);
			// A DIFFERENT note is active; it must not be used for resolution.
			(mockWorkspace.getActiveFile as jest.Mock).mockReturnValue({
				path: 'active.md',
			});
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			playerMenuCallback(
				partial<MouseEvent>({
					target,
					pageX: 10,
					pageY: 20,
					preventDefault: jest.fn(),
					stopPropagation: jest.fn(),
				}),
			);

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'owner.md',
			);
			expect(mockWorkspace.getActiveFile).not.toHaveBeenCalled();
		});

		/**
		 * A right-click on the embed widget a Live Preview editor renders for
		 * an embed of a note.
		 * @param source - The note's source
		 * @param embedText - The embed in it the widget stands for
		 * @param src - The widget's src attribute. Obsidian sets it to the
		 *   link text without its alias, subpath included, so
		 *   `![[a.mp3#t=30|x]]` renders `a.mp3#t=30`; a test passes another
		 *   one only to model a widget that maps to a different link.
		 * @param file - The note the editor shows, null for an editor that
		 *   shows none, as a canvas card does
		 * @returns The event, and the editor the note is open in
		 */
		function rightClickOnRenderedEmbed(
			source: string,
			embedText: string,
			src = embedText.slice(3, -2).split('|')[0] ?? '',
			file: TFile | null = partial<TFile>({ path: 'note.md' }),
		): { event: MouseEvent; live: LiveEditor } {
			const live = mountLiveEditor({
				doc: source,
				file,
				embeds: [{ ...rangeOf(source, embedText), src }],
			});
			const event = partial<MouseEvent>({
				target: at(live.embeds(), 0),
				preventDefault: jest.fn(),
				stopPropagation: jest.fn(),
			});
			return { event, live };
		}

		it('offers "Delete recording & link to file" when the embed maps to an editor link', () => {
			const { event } = rightClickOnRenderedEmbed(
				'Intro\n![[audio.mp3]]',
				'![[audio.mp3]]',
			);
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			playerMenuCallback(event);

			expect(titlesOf(triggeredMenu())).toContain(
				'Delete recording & link to file',
			);
		});

		it('removes the link the embed was rendered from', async () => {
			const { event, live } = rightClickOnRenderedEmbed(
				'Intro\nBefore ![[audio.mp3|My take]] after',
				'![[audio.mp3|My take]]',
			);
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());
			playerMenuCallback(event);

			await clickItem(triggeredMenu(), 'Delete recording & link to file');

			expect(live.text()).toBe('Intro\nBefore  after');
		});

		it('resolves the link of a player in an editor that shows no note from the vault root', () => {
			const { event } = rightClickOnRenderedEmbed(
				'![[audio.mp3]]',
				'![[audio.mp3]]',
				'audio.mp3',
				null,
			);
			const file = makeAudioFile();
			const resolve = mockMetadataCache.getFirstLinkpathDest as jest.Mock;
			resolve.mockReturnValue(file);

			playerMenuCallback(event);

			expect(resolve).toHaveBeenLastCalledWith('audio.mp3', '');
			expect(titlesOf(triggeredMenu())).toContain(
				'Delete recording & link to file',
			);
		});

		it('offers no delete over a player that starts at a timestamp', () => {
			const { event } = rightClickOnRenderedEmbed(
				'![[audio.mp3#t=30]]',
				'![[audio.mp3#t=30]]',
			);
			// Resolves the recording by its path alone, as Obsidian does: a
			// name still carrying the subpath names no file.
			const file = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((link: string) =>
				link === 'audio.mp3' ? file : null,
			);

			playerMenuCallback(event);

			// A timestamp offers what a timestamp link offers in the editor:
			// the file actions that leave the recording in place.
			const titles = titlesOf(triggeredMenu());
			expect(titles).toContain('Audio file info');
			expect(titles).not.toContain('Delete recording');
			expect(titles).not.toContain('Delete recording & link to file');
		});

		it('treats a player that opens at a heading like a plain embed', () => {
			const { event } = rightClickOnRenderedEmbed(
				'![[audio.mp3#Intro]]',
				'![[audio.mp3#Intro]]',
			);
			const file = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((link: string) =>
				link === 'audio.mp3' ? file : null,
			);

			playerMenuCallback(event);

			expect(titlesOf(triggeredMenu())).toContain(
				'Delete recording & link to file',
			);
		});

		it('offers no delete over a Reading view player that starts at a timestamp', () => {
			const file = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((link: string) =>
				link === 'audio.mp3' ? file : null,
			);

			playerMenuCallback(makeEmbedEvent('audio.mp3#t=30'));

			const titles = titlesOf(triggeredMenu());
			expect(titles).toContain('Audio file info');
			expect(titles).not.toContain('Delete recording');
			expect(titles).not.toContain('Delete recording & link to file');
		});

		it('removes no link the embed maps to that is not its own', async () => {
			// A widget spanning several lines, such as a table, maps to where
			// it starts, and the link there need not be this recording's.
			const { event, live } = rightClickOnRenderedEmbed(
				'![[other.mp3]]',
				'![[other.mp3]]',
				'audio.mp3',
			);
			const files: Record<string, TFile> = {
				'audio.mp3': createFile('Recordings/audio.mp3'),
				'other.mp3': createFile('Recordings/other.mp3'),
			};
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((path: string) => files[path] ?? null);

			playerMenuCallback(event);
			await clickItem(triggeredMenu(), 'Delete recording & link to file');

			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				files['audio.mp3'],
			);
			expect(live.text()).toBe('![[other.mp3]]');
		});

		it('locates no link for a player no editor renders', () => {
			// Reading view renders the embed outside any editor, so there is
			// no source link under it; the player is still reached through
			// its note, so the link-aware delete stands in for the plain one.
			const event = makeEmbedEvent();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			playerMenuCallback(event);

			expect(titlesOf(triggeredMenu())).toContain(
				'Delete recording & link to file',
			);
			expect(titlesOf(triggeredMenu())).not.toContain('Delete recording');
		});
	});

	describe('a link Obsidian raises its own menu for', () => {
		let rightClick: (event: MouseEvent) => void;
		let linkMenu: (menu: Menu, file: TFile, source: string) => void;
		let editorMenu: (menu: Menu, editor: Editor, view: unknown) => void;
		let recording: TFile;
		const note = partial<TFile>({ path: 'note.md', extension: 'md' });

		beforeEach(() => {
			contextMenu.register();
			const on = (mockWorkspace.on as jest.Mock).mock.calls;
			linkMenu = on.find((c) => c[0] === 'file-menu')?.[1];
			editorMenu = on.find((c) => c[0] === 'editor-menu')?.[1];
			rightClick = (
				registerDomEventOnAllWindows as jest.Mock
			).mock.calls.find((c) => c[2] === 'contextmenu')?.[3];
			recording = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(recording);
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue(
				null,
			);
		});

		/**
		 * A right-click on a link as Reading view draws it, followed by the
		 * link menu Obsidian raises for it, the only menu raised there.
		 * @param href - The link text the anchor carries
		 * @returns The menu
		 */
		function readingViewMenuOn(href: string): Menu {
			const anchor = document.createElement('a');
			anchor.className = 'internal-link';
			anchor.setAttribute('data-href', href);
			const label = anchor.appendChild(document.createElement('span'));
			rightClick(partial<MouseEvent>({ target: label }));
			const menu = new Menu();
			linkMenu(menu, recording, 'link-context-menu');
			return menu;
		}

		/**
		 * A right-click on a link Live Preview draws as tokens, with the two
		 * menus Obsidian raises for it in the order given.
		 * @param source - The note's source, the link alone on its line
		 * @param order - Which menu Obsidian raises first
		 * @returns The menu and the editor
		 */
		function livePreviewMenuOn(
			source: string,
			order: 'link first' | 'editor first' | 'link only',
		): { menu: Menu; live: LiveEditor } {
			const live = mountLiveEditor({
				doc: source,
				file: note,
				linkTokens: [rangeOf(source, source)],
			});
			// Obsidian puts the cursor where the right-click landed.
			live.editor.setCursor({ line: 0, ch: 2 });
			rightClick(
				partial<MouseEvent>({ target: at(live.linkTokens(), 0) }),
			);
			const menu = new Menu();
			const raiseEditorMenu = (): void => {
				editorMenu(menu, live.editor, { file: note });
			};
			if (order === 'editor first') {
				raiseEditorMenu();
			}
			linkMenu(menu, recording, 'link-context-menu');
			if (order === 'link first') {
				raiseEditorMenu();
			}
			return { menu, live };
		}

		it('offers no delete on a timestamp in Reading view', () => {
			// A transcript links its recording at dozens of moments; this menu
			// is the only one Reading view raises, and it must not trash the
			// recording the rest of them point at.
			const titles = titlesOf(readingViewMenuOn('audio.mp3#t=30'));

			expect(titles).not.toContain('Delete recording & link to file');
			expect(titles).not.toContain('Delete recording');
			expect(titles).toContain('Audio file info');
		});

		it('offers the link-aware delete on a whole-file link in Reading view', () => {
			expect(titlesOf(readingViewMenuOn('audio.mp3'))).toContain(
				'Delete recording & link to file',
			);
		});

		it('keeps the link-aware delete when the click maps to no link', () => {
			// A link drawn where neither Reading view nor an editor drew it, as
			// in a canvas card, says nothing about a moment; the link menu still
			// reached the recording through a link.
			rightClick(
				partial<MouseEvent>({ target: document.createElement('span') }),
			);
			const menu = new Menu();
			linkMenu(menu, recording, 'link-context-menu');

			expect(titlesOf(menu)).toContain('Delete recording & link to file');
		});

		it('ignores a right-click that landed on a link to another file', () => {
			// What the last right-click hit is only evidence about this menu when
			// it links this recording; a stale element must not hide the delete
			// of a whole-file link to it.
			const other = makeAudioFile('wav');
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((path: string) =>
				path === 'other.wav' ? other : recording,
			);

			expect(titlesOf(readingViewMenuOn('other.wav#t=30'))).toContain(
				'Delete recording & link to file',
			);
		});

		it.each(['link first', 'editor first', 'link only'] as const)(
			'offers no delete on a timestamp in Live Preview, %s',
			(order) => {
				const { menu } = livePreviewMenuOn(
					'[[audio.mp3#t=30|0:30]]',
					order,
				);

				expect(titlesOf(menu)).not.toContain(
					'Delete recording & link to file',
				);
				expect(titlesOf(menu)).not.toContain('Delete recording');
			},
		);

		it('removes the right-clicked link when only the link menu is raised', async () => {
			const { menu, live } = livePreviewMenuOn(
				'[[audio.mp3]]',
				'link only',
			);

			await clickItem(menu, 'Delete recording & link to file');

			expect(mockFileManager.trashFile).toHaveBeenCalledWith(recording);
			expect(live.text()).toBe('');
		});
	});

	describe('ContextMenu over an enhanced player', () => {
		/** The contextmenu handler the menu installed on every window. */
		function playerMenu(): (event: MouseEvent) => void {
			const call = (
				registerDomEventOnAllWindows as jest.Mock
			).mock.calls.find((args: unknown[]) => args[2] === 'contextmenu');
			if (!call) {
				throw new Error('Expected a contextmenu handler registration');
			}
			return call[3] as (event: MouseEvent) => void;
		}

		/**
		 * A right-click on an embed carrying the given player actions.
		 * @param actions - What the player published on its container
		 * @param clientX - Where along the seek area the click landed
		 * @returns The event, ready to hand to the handler
		 */
		function rightClickOnPlayer(
			actions: Partial<PlayerEmbedActions>,
			clientX = 120,
		): MouseEvent {
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			embed.setAttribute('src', 'audio.mp3');
			setPlayerEmbedActions(embed, {
				markersEnabled: true,
				timeAtClientX: () => 42,
				togglePlayback: jest.fn(),
				...actions,
			});
			const target = document.createElement('span');
			embed.appendChild(target);
			return partial<MouseEvent>({
				target,
				clientX,
				pageX: 100,
				pageY: 200,
				preventDefault: jest.fn(),
				stopPropagation: jest.fn(),
			});
		}

		/** The titles of the menu the handler built. */
		function menuTitles(): string[] {
			const call = (mockWorkspace.trigger as jest.Mock).mock.calls.find(
				(args: unknown[]) => args[0] === 'file-menu',
			);
			if (!call) {
				throw new Error('file-menu was not triggered');
			}
			return asMockMenu(call[1] as Menu).items.map((item) => item.title);
		}

		/** The sidecar the marker actions write, holding no markers yet. */
		let updateMarkers: jest.Mock;
		/** What the plugin tells the players once markers were written. */
		let onMarkersChanged: jest.Mock;

		beforeEach(() => {
			updateMarkers = jest.fn(
				(_path: string, update: (markers: []) => unknown) =>
					Promise.resolve(update([])),
			);
			onMarkersChanged = jest.fn();
			menuWith(
				{ playerEnableMarkers: true },
				{
					recordingSidecar: partial<
						ActionServices['recordingSidecar']
					>({
						updateMarkers,
					}),
					onMarkersChanged,
				},
			).register();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());
			(mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(null);
		});

		/**
		 * Clicks an entry of the menu the handler built.
		 * @param title - The entry
		 */
		async function clickPlayerItem(title: string): Promise<void> {
			const call = (mockWorkspace.trigger as jest.Mock).mock.calls.find(
				(args: unknown[]) => args[0] === 'file-menu',
			);
			await clickItem(at(call as unknown[], 1) as Menu, title);
		}

		it('offers the position-aware actions of an editable player', () => {
			// "Add marker here" has to mean where the user right-clicked, which
			// is the whole reason these live on the player rather than the file.
			playerMenu()(rightClickOnPlayer({}));

			expect(menuTitles()).toEqual(
				expect.arrayContaining([
					'Add marker here',
					'Add chapter here',
					'Copy timestamp link here',
				]),
			);
		});

		it.each([
			{ title: 'Add marker here', kind: 'bookmark' },
			{ title: 'Add chapter here', kind: 'chapter' },
		])(
			'$title drops one at the clicked position',
			async ({ title, kind }) => {
				playerMenu()(rightClickOnPlayer({}));

				await clickPlayerItem(title);

				await expect(
					at(updateMarkers.mock.results, 0).value,
				).resolves.toEqual([
					expect.objectContaining({ time: 42, kind }),
				]);
				// Every open player of the recording reads the new marker at once.
				expect(onMarkersChanged).toHaveBeenCalledWith(
					makeAudioFile().path,
				);
			},
		);

		/**
		 * Right-clicks the player and picks the copy entry, the clipboard a
		 * spy.
		 * @returns What was written to the clipboard
		 */
		async function copyLinkHere(): Promise<jest.Mock> {
			const writeText = jest.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText },
				configurable: true,
			});
			playerMenu()(rightClickOnPlayer({}));
			await clickPlayerItem('Copy timestamp link here');
			return writeText;
		}

		it('copies a link to the clicked position', async () => {
			const writeText = await copyLinkHere();

			// The link is Obsidian's, built for the clicked second.
			expect(
				mockApp.fileManager.generateMarkdownLink,
			).toHaveBeenCalledWith(
				expect.objectContaining({ extension: 'mp3' }),
				'',
				'#t=42',
				'0:42',
			);
			expect(writeText).toHaveBeenCalledWith(
				jest.mocked(mockApp.fileManager.generateMarkdownLink).mock
					.results[0]?.value,
			);
		});

		it('links from the note the player is in', async () => {
			// The note embeds the recording, so it is the one the player
			// reaches it through.
			(mockMetadataCache.getFileCache as jest.Mock).mockReturnValue({
				embeds: [
					{
						link: 'audio.mp3',
						position: { start: { offset: 0 } },
					},
				],
			});
			// No editor renders the player, so only the note, not the embed's
			// link, is known.
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				file: { path: 'Meetings/standup.md' },
				editor: partial<Editor>({}),
			});

			await copyLinkHere();

			expect(
				mockApp.fileManager.generateMarkdownLink,
			).toHaveBeenCalledWith(
				expect.objectContaining({ extension: 'mp3' }),
				'Meetings/standup.md',
				'#t=42',
				'0:42',
			);
		});

		it('keeps the plain delete out of a player menu in a note, past file-menu', () => {
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				file: { path: 'Meetings/standup.md' },
				editor: partial<Editor>({}),
			});
			playerMenu()(rightClickOnPlayer({}));
			const [, menu, file, source] = defined(
				(mockWorkspace.trigger as jest.Mock).mock.calls.find(
					(args: unknown[]) => args[0] === 'file-menu',
				),
			) as [string, Menu, TFile, string];
			const fileMenu = defined(
				(mockWorkspace.on as jest.Mock).mock.calls.find(
					(args: unknown[]) => args[0] === 'file-menu',
				),
			)[1] as (menu: Menu, file: TFile, source: string) => void;

			// What Obsidian does with the event the player menu triggers: every
			// file-menu handler runs, this plugin's own among them.
			fileMenu(menu, file, source);

			expect(menuTitles()).toContain('Delete recording & link to file');
			expect(menuTitles()).not.toContain('Delete recording');
		});

		it('reaches a player in a transcluded note through the note it is written in', async () => {
			const event = rightClickOnPlayer({});
			const transclusion = document.createElement('div');
			transclusion.className = 'internal-embed markdown-embed';
			transclusion.setAttribute('src', 'Meeting');
			transclusion.appendChild(
				(event.target as HTMLElement).parentElement as HTMLElement,
			);
			const recording = makeAudioFile();
			const meeting = Object.assign(Object.create(TFile.prototype), {
				path: 'Meetings/Meeting.md',
				extension: 'md',
			}) as TFile;
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((path: string) =>
				path === 'Meeting' ? meeting : recording,
			);
			(mockMetadataCache.getFileCache as jest.Mock).mockImplementation(
				(note: TFile) =>
					note === meeting
						? {
								embeds: [
									{
										link: 'audio.mp3',
										position: { start: { offset: 0 } },
									},
								],
							}
						: null,
			);
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: jest.fn().mockResolvedValue(undefined) },
				configurable: true,
			});

			playerMenu()(event);
			await clickPlayerItem('Copy timestamp link here');

			expect(
				mockApp.fileManager.generateMarkdownLink,
			).toHaveBeenCalledWith(
				recording,
				'Meetings/Meeting.md',
				'#t=42',
				'0:42',
			);
		});

		it('falls back to the note on screen when a transclusion does not resolve', async () => {
			const event = rightClickOnPlayer({});
			const gone = document.createElement('div');
			gone.className = 'internal-embed markdown-embed';
			gone.setAttribute('src', 'Gone');
			gone.appendChild(
				(event.target as HTMLElement).parentElement as HTMLElement,
			);
			const recording = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((path: string) =>
				path === 'Gone' ? null : recording,
			);
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				file: { path: 'Meetings/standup.md' },
				editor: partial<Editor>({}),
			});
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: jest.fn().mockResolvedValue(undefined) },
				configurable: true,
			});

			playerMenu()(event);
			await clickPlayerItem('Copy timestamp link here');

			expect(
				mockApp.fileManager.generateMarkdownLink,
			).toHaveBeenCalledWith(
				recording,
				'Meetings/standup.md',
				'#t=42',
				'0:42',
			);
		});

		it('follows nested transclusions, each from the note around it', async () => {
			const event = rightClickOnPlayer({});
			const inner = document.createElement('div');
			inner.className = 'internal-embed markdown-embed';
			inner.setAttribute('src', 'C');
			inner.appendChild(
				(event.target as HTMLElement).parentElement as HTMLElement,
			);
			const outer = document.createElement('div');
			outer.className = 'internal-embed markdown-embed';
			outer.setAttribute('src', 'B');
			outer.appendChild(inner);
			const note = (path: string): TFile =>
				Object.assign(Object.create(TFile.prototype), {
					path,
					extension: 'md',
				}) as TFile;
			const recording = makeAudioFile();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockImplementation((path: string, from: string) => {
				if (path === 'B') {
					return note('Y/B.md');
				}
				if (path === 'C') {
					// Two notes are called C; the one B links is beside it.
					return note(from === 'Y/B.md' ? 'Y/C.md' : 'X/C.md');
				}
				return recording;
			});
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: jest.fn().mockResolvedValue(undefined) },
				configurable: true,
			});

			playerMenu()(event);
			await clickPlayerItem('Copy timestamp link here');

			expect(
				mockApp.fileManager.generateMarkdownLink,
			).toHaveBeenCalledWith(recording, 'Y/C.md', '#t=42', '0:42');
		});

		it('resolves a player in a view that shows no file from the vault root', () => {
			const event = rightClickOnPlayer({});
			const containerEl = document.createElement('div');
			containerEl.appendChild(
				(event.target as HTMLElement).parentElement as HTMLElement,
			);
			const view = Object.assign(
				Object.create(
					internalsOf<{ prototype: object }>(MarkdownView).prototype,
				),
				{ containerEl, file: null, editor: {} },
			);
			(mockWorkspace.iterateAllLeaves as jest.Mock).mockImplementation(
				(cb: (leaf: { view: unknown }) => void) => cb({ view }),
			);

			playerMenu()(event);

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'',
			);
			expect(menuTitles()).toContain('Add marker here');
		});

		it('offers no marker actions in a read-only note', () => {
			// Reading view has no way to undo an accidental marker.
			playerMenu()(rightClickOnPlayer({ markersEnabled: false }));

			expect(menuTitles()).not.toContain('Add marker here');
			expect(menuTitles()).toContain('Copy timestamp link here');
		});

		it('offers no position-aware action when the click was off the seek area', () => {
			// Without a position "here" means nothing, and adding a marker at an
			// arbitrary time would be worse than offering nothing.
			playerMenu()(rightClickOnPlayer({ timeAtClientX: () => null }));

			expect(menuTitles()).not.toContain('Add marker here');
			expect(menuTitles()).not.toContain('Copy timestamp link here');
		});

		it('offers only the file actions over a plain embed', () => {
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			embed.setAttribute('src', 'audio.mp3');
			const target = document.createElement('span');
			embed.appendChild(target);

			playerMenu()(
				partial<MouseEvent>({
					target,
					clientX: 120,
					pageX: 100,
					pageY: 200,
					preventDefault: jest.fn(),
					stopPropagation: jest.fn(),
				}),
			);

			expect(menuTitles()).not.toContain('Add marker here');
			expect(mockWorkspace.trigger).toHaveBeenCalledTimes(1);
		});
	});
});
