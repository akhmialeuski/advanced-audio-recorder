/**
 * Unit tests for ContextMenu. Behavior-focused: menus are rendered into a
 * recording Menu fake and asserted by their visible item titles and what
 * each item's click actually does (modals opened, files trashed, links
 * removed), not by the setIcon/setSection call structure - so harmless
 * implementation changes do not break the suite while real regressions
 * (a missing action, a click doing the wrong thing) still do.
 * @module tests/unit/ContextMenu.test
 */

import { ContextMenu } from 'src/ui/ContextMenu';
import { FILE_ACTIONS } from 'src/actions/fileActions';
import type { ActionServices } from 'src/actions/PluginAction';
import { AUDIO_EXTENSIONS } from 'src/constants';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import * as AudioFileAnalyzer from 'src/utils/AudioFileAnalyzer';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { asMockMenu } from '../helpers/obsidianMock';
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
} from 'obsidian';

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
		mockWorkspace = {
			on: jest.fn(),
			trigger: jest.fn(),
			getActiveFile: jest.fn(),
			getActiveViewOfType: jest.fn(),
			iterateAllLeaves: jest.fn(),
		} as unknown as Workspace;

		mockMetadataCache = {
			getFirstLinkpathDest: jest.fn(),
		} as unknown as MetadataCache;

		mockVault = {
			delete: jest.fn(),
		} as unknown as Vault;

		mockFileManager = {
			trashFile: jest.fn(),
		} as unknown as FileManager;

		mockApp = {
			workspace: mockWorkspace,
			metadataCache: mockMetadataCache,
			vault: mockVault,
			fileManager: mockFileManager,
		} as unknown as App;

		mockPlugin = {
			registerEvent: jest.fn(),
			registerDomEvent: jest.fn(),
		} as unknown as Plugin;

		contextMenu = new ContextMenu(
			mockPlugin,
			{
				app: mockApp,
				getSettings: () =>
					({
						deleteSourceAfterConversion: true,
						conversionLinkAction: 'replace',
					}) as unknown as AudioRecorderSettings,
				saveSettings: () => Promise.resolve(),
				createTranscriptionModalOptions: () => ({}),
				primeForEnhancement: () => {},
				getWorkerClient: () => null,
				autoChapters: {
					generate: jest.fn(),
				} as unknown as ActionServices['autoChapters'],
				recordingSidecar: {
					getTranscript: jest.fn().mockResolvedValue(null),
					updateTranscript: jest.fn().mockResolvedValue(undefined),
				} as unknown as ActionServices['recordingSidecar'],
			},
			FILE_ACTIONS,
		);
	});

	function makeAudioFile(extension = 'mp3'): TFile {
		const file = new TFile();
		Object.defineProperty(file, 'extension', { value: extension });
		return file;
	}

	describe('register', () => {
		it('should register file, editor, and player menus', () => {
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
			const { registerDomEventOnAllWindows } = jest.requireMock(
				'src/utils/multiWindowDomEvents',
			);
			expect(registerDomEventOnAllWindows).toHaveBeenCalledWith(
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

		it('offers the full action set for an audio file (transcription off)', () => {
			const menu = new Menu();

			fileMenuCallback(menu, makeAudioFile());

			expect(titlesOf(menu)).toEqual([
				'Audio file info',
				'Convert audio format',
				'Split audio into parts',
				'Clean up audio',
				'Delete recording',
			]);
		});

		it('opens the file-info modal from "Audio file info"', async () => {
			const { AudioFileInfoModal } = jest.requireMock(
				'src/ui/AudioFileInfoModal',
			);
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
			expect(AudioFileInfoModal).toHaveBeenCalled();
		});

		it('does not open the file-info modal when analysis fails', async () => {
			const { AudioFileInfoModal } = jest.requireMock(
				'src/ui/AudioFileInfoModal',
			);
			const menu = new Menu();
			jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
				null,
			);

			fileMenuCallback(menu, makeAudioFile());
			await clickItem(menu, 'Audio file info');

			expect(AudioFileInfoModal).not.toHaveBeenCalled();
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
			const { SplitModal } = jest.requireMock('src/ui/SplitModal');
			const menu = new Menu();
			const file = makeAudioFile();

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Split audio into parts');

			expect(SplitModal).toHaveBeenCalledWith(
				mockApp,
				file,
				expect.any(Function),
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
			const { AudioProcessingModal } = jest.requireMock(
				'src/cleanup/AudioProcessingModal',
			);
			const menu = new Menu();
			const file = makeAudioFile();

			fileMenuCallback(menu, file);
			await clickItem(menu, 'Clean up audio');

			expect(AudioProcessingModal).toHaveBeenCalledWith(
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
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
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

			mockEditor = {
				getCursor: jest.fn().mockReturnValue({ line: 0, ch: 0 }),
				getLine: jest.fn(),
				replaceRange: jest.fn(),
				offsetToPos: jest.fn(),
			} as unknown as Editor;
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
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
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

	describe('registerPlayerMenu', () => {
		let playerMenuCallback: (event: MouseEvent) => void;

		beforeEach(() => {
			contextMenu.register();
			const { registerDomEventOnAllWindows } = jest.requireMock(
				'src/utils/multiWindowDomEvents',
			);
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
			return {
				target,
				pageX: 100,
				pageY: 200,
				preventDefault: jest.fn(),
				stopPropagation: jest.fn(),
			} as unknown as MouseEvent;
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

				expect(event.preventDefault).toHaveBeenCalled();
				expect(mockWorkspace.trigger).toHaveBeenCalledWith(
					'file-menu',
					expect.any(Object),
					file,
					'audio-recorder-player-context-menu',
				);
			},
		);

		it('does nothing when the target is not inside an internal embed', () => {
			playerMenuCallback({
				target: document.createElement('div'),
			} as unknown as MouseEvent);

			expect(
				mockMetadataCache.getFirstLinkpathDest,
			).not.toHaveBeenCalled();
		});

		it('does nothing when the embed has no src', () => {
			const embed = document.createElement('div');
			embed.className = 'internal-embed';
			const target = document.createElement('span');
			embed.appendChild(target);

			playerMenuCallback({ target } as unknown as MouseEvent);

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

			expect(event.preventDefault).toHaveBeenCalled();
			expect(event.stopPropagation).toHaveBeenCalled();
			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'active.md',
			);
			expect(asMockMenu(triggeredMenu()).shownAtPosition).toEqual({
				x: 100,
				y: 200,
			});
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
			expect(mockWorkspace.trigger).toHaveBeenCalled();
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
					(MarkdownView as unknown as { prototype: object })
						.prototype,
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

			playerMenuCallback({
				target,
				pageX: 10,
				pageY: 20,
				preventDefault: jest.fn(),
				stopPropagation: jest.fn(),
			} as unknown as MouseEvent);

			expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
				'audio.mp3',
				'owner.md',
			);
			expect(mockWorkspace.getActiveFile).not.toHaveBeenCalled();
		});

		it('offers "Delete recording & link to file" when the embed maps to an editor link', () => {
			const event = makeEmbedEvent();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());

			const mockEditor = {
				offsetToPos: jest.fn().mockReturnValue({ line: 0, ch: 0 }),
				getLine: jest.fn().mockReturnValue('[[audio.mp3]]'),
				getCursor: jest.fn().mockReturnValue({ line: 10, ch: 10 }),
				replaceRange: jest.fn(),
			} as unknown as Editor;
			Object.defineProperty(mockEditor, 'cm', {
				get: () => ({ posAtDOM: jest.fn().mockReturnValue(0) }),
			});
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				editor: mockEditor,
			});

			playerMenuCallback(event);

			expect(titlesOf(triggeredMenu())).toContain(
				'Delete recording & link to file',
			);
		});

		it('degrades gracefully when the editor link resolution throws', () => {
			const event = makeEmbedEvent();
			(
				mockMetadataCache.getFirstLinkpathDest as jest.Mock
			).mockReturnValue(makeAudioFile());
			const consoleSpy = jest
				.spyOn(console, 'error')
				.mockImplementation();
			const mockEditor = {
				get cm() {
					return {
						posAtDOM: jest.fn().mockImplementation(() => {
							throw new Error('Test Error');
						}),
					};
				},
			} as unknown as Editor;
			(mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
				editor: mockEditor,
			});

			playerMenuCallback(event);

			expect(consoleSpy).toHaveBeenCalledWith(
				'[AudioRecorder] Failed to resolve link position in editor:',
				expect.any(Error),
			);
			consoleSpy.mockRestore();
		});
	});
});
