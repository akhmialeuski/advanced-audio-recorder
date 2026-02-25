/**
 * Unit tests for ContextMenu module.
 * @module tests/unit/ContextMenu.test
 */
/** @jest-environment jsdom */

import { ContextMenu } from '../../src/ui/ContextMenu';
import { AUDIO_EXTENSIONS } from '../../src/constants';
import { FORMAT_MP4 } from '../../src/recording/AudioCapabilityDetector';
import {
    App,
    Menu,
    TFile,
    Plugin,
    Editor,
    Notice,
    MarkdownView,
    Workspace,
    MetadataCache,
    Vault,
    FileManager,
} from 'obsidian';

// Mock obsidian module
jest.mock('obsidian', () => ({
    App: jest.fn(),
    Menu: class {
        addItem = jest.fn();
        showAtPosition = jest.fn();
    },
    TFile: jest.fn(),
    Plugin: jest.fn(),
    Editor: jest.fn(),
    Notice: jest.fn(),
    MarkdownView: jest.fn(),
    FileManager: jest.fn(),
}));

describe('ContextMenu', () => {
    let contextMenu: ContextMenu;
    let mockApp: App;
    let mockPlugin: Plugin;
    let mockWorkspace: Workspace;
    let mockMetadataCache: MetadataCache;
    let mockVault: Vault;
    let mockFileManager: FileManager;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock App and its components
        mockWorkspace = {
            on: jest.fn(),
            trigger: jest.fn(),
            getActiveFile: jest.fn(),
            getActiveViewOfType: jest.fn(),
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

        // Mock Plugin
        mockPlugin = {
            registerEvent: jest.fn(),
            registerDomEvent: jest.fn(),
        } as unknown as Plugin;

        contextMenu = new ContextMenu(mockApp, mockPlugin);
    });

    describe('register', () => {
        it('should register file, editor, and player menus', () => {
            // We can't easily spy on private methods, so we verify side effects (calls to plugin.register*)
            contextMenu.register();

            // registerFileMenu calls workspace.on('file-menu') and plugin.registerEvent
            expect(mockWorkspace.on).toHaveBeenCalledWith(
                'file-menu',
                expect.any(Function),
            );
            expect(mockPlugin.registerEvent).toHaveBeenCalled();

            // registerEditorMenu calls workspace.on('editor-menu') and plugin.registerEvent
            expect(mockWorkspace.on).toHaveBeenCalledWith(
                'editor-menu',
                expect.any(Function),
            );

            // registerPlayerMenu calls plugin.registerDomEvent
            expect(mockPlugin.registerDomEvent).toHaveBeenCalledWith(
                document,
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
            // Extract the callback passed to workspace.on('file-menu', ...)
            const call = (mockWorkspace.on as jest.Mock).mock.calls.find(
                (c) => c[0] === 'file-menu',
            );
            fileMenuCallback = call[1];
        });

        it('should include mp4 in AUDIO_EXTENSIONS', () => {
            expect(AUDIO_EXTENSIONS).toContain(FORMAT_MP4);
        });

        test.each(AUDIO_EXTENSIONS)(
            'should add "Delete recording" item for %s files',
            (extension) => {
                const mockMenu = new Menu();
                const mockFile = new TFile();
                Object.defineProperty(mockFile, 'extension', { value: extension });

                fileMenuCallback(mockMenu, mockFile);

                expect(mockMenu.addItem).toHaveBeenCalled();
            },
        );

        it('should add "Delete recording" item for audio files', () => {
            const mockMenu = new Menu();
            const mockFile = new TFile();
            // Mock TFile properties setup
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });

            fileMenuCallback(mockMenu, mockFile);

            expect(mockMenu.addItem).toHaveBeenCalled();

            // Verify the item configuration
            const addItemCallback = (mockMenu.addItem as jest.Mock).mock
                .calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            expect(mockItem.setTitle).toHaveBeenCalledWith('Delete recording');
            expect(mockItem.setIcon).toHaveBeenCalledWith('trash');
            expect(mockItem.setSection).toHaveBeenCalledWith('danger');
        });

        it('should NOT add item for non-audio files', () => {
            const mockMenu = new Menu();
            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'md' });

            fileMenuCallback(mockMenu, mockFile);

            expect(mockMenu.addItem).not.toHaveBeenCalled();
        });

        it('should delete file on click', async () => {
            const mockMenu = new Menu();
            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });

            fileMenuCallback(mockMenu, mockFile);

            const addItemCallback = (mockMenu.addItem as jest.Mock).mock
                .calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            // Trigger click
            const clickHandler = mockItem.onClick.mock.calls[0][0];
            await clickHandler();

            expect(mockFileManager.trashFile).toHaveBeenCalledWith(mockFile);
            expect(Notice).toHaveBeenCalledWith('Recording deleted');
        });

        it('should handle deletion error', async () => {
            const mockMenu = new Menu();
            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockFileManager.trashFile as jest.Mock).mockRejectedValue(
                new Error('Delete failed'),
            );
            const consoleSpy = jest
                .spyOn(console, 'error')
                .mockImplementation(() => { });

            fileMenuCallback(mockMenu, mockFile);

            const addItemCallback = (mockMenu.addItem as jest.Mock).mock
                .calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            const clickHandler = mockItem.onClick.mock.calls[0][0];
            await clickHandler();

            expect(Notice).toHaveBeenCalledWith('Failed to delete recording');
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe('registerEditorMenu', () => {
        let editorMenuCallback: (
            menu: Menu,
            editor: Editor,
            view: any,
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
            'should add "Delete recording & link" item for %s files',
            (extension) => {
                const mockMenu = new Menu();
                (mockEditor.getLine as jest.Mock).mockReturnValue(`[[audio.${extension}]]`);
                (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 2 });

                const mockFile = new TFile();
                Object.defineProperty(mockFile, 'extension', { value: extension });
                (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

                editorMenuCallback(mockMenu, mockEditor, {});

                expect(mockMenu.addItem).toHaveBeenCalled();
            },
        );

        it('should do nothing if no link at cursor', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('Just text');

            editorMenuCallback(mockMenu, mockEditor, {});

            expect(mockMenu.addItem).not.toHaveBeenCalled();
        });

        it('should do nothing if link resolves to non-audio file', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[[note]]');
            (mockEditor.getCursor as jest.Mock).mockReturnValue({
                line: 0,
                ch: 2,
            }); // Inside link
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(
                new TFile(),
            ); // Default check fails mostly on extension mock? Or default TFile mock

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'md' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(
                mockFile,
            );

            editorMenuCallback(mockMenu, mockEditor, {});

            expect(mockMenu.addItem).not.toHaveBeenCalled();
        });

        it('should add "Delete recording & link" if valid audio link', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
            (mockEditor.getCursor as jest.Mock).mockReturnValue({
                line: 0,
                ch: 2,
            });

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(
                mockFile,
            );

            editorMenuCallback(mockMenu, mockEditor, {});

            expect(mockMenu.addItem).toHaveBeenCalled();
            const addItemCallback = (mockMenu.addItem as jest.Mock).mock
                .calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            expect(mockItem.setTitle).toHaveBeenCalledWith(
                'Delete recording & link to file',
            );
        });

        it('should delete file and remove link text on click', async () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('Text [[audio.mp3]] Text');
            // Cursor at link
            (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 7 });

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            editorMenuCallback(mockMenu, mockEditor, {});

            const addItemCallback = (mockMenu.addItem as jest.Mock).mock.calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            const clickHandler = mockItem.onClick.mock.calls[0][0];
            await clickHandler();

            expect(mockFileManager.trashFile).toHaveBeenCalledWith(mockFile);
            // Verify editor.replaceRange was called with correct range for [[audio.mp3]]
            // "Text [[audio.mp3]] Text" -> Link is at index 5 to 18 (13 chars)
            // But strict regex might handle it differently.
            // Let's rely on the fact that existing logic finds it.
            // Regex !?\[\[(.*?)(?:\|.*?)?\]\]
            // For 'Text [[audio.mp3]] Text', match index is 5.
            expect(mockEditor.replaceRange).toHaveBeenCalledWith(
                '',
                { line: 0, ch: 5 },
                { line: 0, ch: 18 }
            );
            expect(Notice).toHaveBeenCalledWith('Recording and link deleted');
        });

        it('should handle deletion error in editor menu', async () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
            (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 2 });

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            // Mock delete failure
            (mockFileManager.trashFile as jest.Mock).mockRejectedValue(new Error('Delete failed'));
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            editorMenuCallback(mockMenu, mockEditor, {});

            const addItemCallback = (mockMenu.addItem as jest.Mock).mock.calls[0][0];
            const mockItem = {
                setTitle: jest.fn().mockReturnThis(),
                setIcon: jest.fn().mockReturnThis(),
                setSection: jest.fn().mockReturnThis(),
                onClick: jest.fn(),
            };
            addItemCallback(mockItem);

            const clickHandler = mockItem.onClick.mock.calls[0][0];
            await clickHandler();

            expect(Notice).toHaveBeenCalledWith('Failed to delete recording');
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('should work with markdown links', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[link](audio.mp3)');
            // [link](audio.mp3) -> cursor at 5 (inside link text) or 10 (inside path)
            // Regex: !?\[(.*?)\]\((.*?)\)
            // Group 1: link, Group 2: audio.mp3
            // Match index 0. Length: [link](audio.mp3) = 17 chars.
            (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 10 });

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            editorMenuCallback(mockMenu, mockEditor, {});

            expect(mockMenu.addItem).toHaveBeenCalled();
        });

        it('should handle view with no file', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
            (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 2 });

            // view has no file property or it is null
            const mockView = {};

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            // Should call getFirstLinkpathDest with sourcePath = ''
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            editorMenuCallback(mockMenu, mockEditor, mockView);

            expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('audio.mp3', '');
            expect(mockMenu.addItem).toHaveBeenCalled();
        });

        it('should handle view with file', () => {
            const mockMenu = new Menu();
            (mockEditor.getLine as jest.Mock).mockReturnValue('[[audio.mp3]]');
            (mockEditor.getCursor as jest.Mock).mockReturnValue({ line: 0, ch: 2 });

            const mockView = { file: { path: 'view.md' } };

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            editorMenuCallback(mockMenu, mockEditor, mockView);

            expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('audio.mp3', 'view.md');
            expect(mockMenu.addItem).toHaveBeenCalled();
        });
    });

    describe('registerPlayerMenu', () => {
        let playerMenuCallback: (event: MouseEvent) => void;

        beforeEach(() => {
            contextMenu.register();
            const call = (mockPlugin.registerDomEvent as jest.Mock).mock.calls.find(
                (c) => c[1] === 'contextmenu',
            );
            playerMenuCallback = call[2];
        });

        test.each(AUDIO_EXTENSIONS)(
            'should resolve %s file and show context menu',
            (extension) => {
                const embed = document.createElement('div');
                embed.className = 'internal-embed';
                embed.setAttribute('src', `audio.${extension}`);
                const target = document.createElement('span');
                embed.appendChild(target);

                const mockEvent = {
                    target: target,
                    pageX: 100,
                    pageY: 200,
                    preventDefault: jest.fn(),
                    stopPropagation: jest.fn(),
                } as unknown as MouseEvent;

                const mockFile = new TFile();
                Object.defineProperty(mockFile, 'extension', { value: extension });
                (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);
                (mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(null);

                playerMenuCallback(mockEvent);

                expect(mockEvent.preventDefault).toHaveBeenCalled();
                expect(mockWorkspace.trigger).toHaveBeenCalledWith(
                    'file-menu',
                    expect.any(Menu),
                    mockFile,
                    'audio-recorder-player-context-menu',
                );
            },
        );

        it('should do nothing if target is not part of internal-embed', () => {
            const mockEvent = {
                target: document.createElement('div'),
            } as unknown as MouseEvent;

            playerMenuCallback(mockEvent);

            expect(mockMetadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
        });

        it('should do nothing if embed has no src', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            // No src attribute

            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
            } as unknown as MouseEvent;

            playerMenuCallback(mockEvent);

            expect(mockMetadataCache.getFirstLinkpathDest).not.toHaveBeenCalled();
        });

        it('should resolve file and show menu if valid audio', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            embed.setAttribute('src', 'audio.mp3');

            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
                pageX: 100,
                pageY: 200,
                preventDefault: jest.fn(),
                stopPropagation: jest.fn(),
            } as unknown as MouseEvent;

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(
                mockFile,
            );

            // Cover truthy activeFile branch
            const mockActiveFile = new TFile();
            mockActiveFile.path = 'active.md';
            (mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(mockActiveFile);

            playerMenuCallback(mockEvent);

            expect(mockEvent.preventDefault).toHaveBeenCalled();
            expect(mockEvent.stopPropagation).toHaveBeenCalled();
            expect(mockWorkspace.trigger).toHaveBeenCalledWith(
                'file-menu',
                expect.any(Menu),
                mockFile,
                'audio-recorder-player-context-menu'
            );
            expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('audio.mp3', 'active.md');
        });

        it('should do nothing if file resolution fails', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            embed.setAttribute('src', 'audio.mp3');
            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
            } as unknown as MouseEvent;

            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(null);

            playerMenuCallback(mockEvent);

            expect(mockEvent.preventDefault).not.toBeDefined(); // Event not passed to callback in this test setup actually, wait. 
            // The callback receives event. If we don't mock preventDefault it might be undefined properly.
            // But we want to ensure we returned early.
            // Check if triggers were called.
            expect(mockWorkspace.trigger).not.toHaveBeenCalled();
        });

        it('should handle no active file in player menu', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            embed.setAttribute('src', 'audio.mp3');
            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
                preventDefault: jest.fn(),
                stopPropagation: jest.fn(),
            } as unknown as MouseEvent;

            (mockWorkspace.getActiveFile as jest.Mock).mockReturnValue(null);

            // We expect getFirstLinkpathDest to be called with sourcePath = ''
            // and if it finds file, proceed.
            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            playerMenuCallback(mockEvent);

            expect(mockMetadataCache.getFirstLinkpathDest).toHaveBeenCalledWith('audio.mp3', '');
            expect(mockWorkspace.trigger).toHaveBeenCalled();
        });

        it('should attempt to find link in editor and add "Delete & Link" option', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            embed.setAttribute('src', 'audio.mp3');
            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
                pageX: 100,
                pageY: 200,
                preventDefault: jest.fn(),
                stopPropagation: jest.fn(),
            } as unknown as MouseEvent;

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            // Mock active view and editor
            const mockEditor = {
                offsetToPos: jest.fn().mockReturnValue({ line: 0, ch: 0 }),
                getLine: jest.fn().mockReturnValue('[[audio.mp3]]'),
                getCursor: jest.fn().mockReturnValue({ line: 10, ch: 10 }), // Should rely on offsetToPos result
                replaceRange: jest.fn(),
            } as unknown as Editor;

            const editorViewOverride = {
                posAtDOM: jest.fn().mockReturnValue(0)
            };
            // Mock casting editor to any to access cm/posAtDOM
            Object.defineProperty(mockEditor, 'cm', {
                get: () => editorViewOverride
            });

            (mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
                editor: mockEditor
            });

            playerMenuCallback(mockEvent);

            // With findLinkAtCursor working (line is '[[audio.mp3]]', cursor 0), it matches
            // We expect the menu to have items.
            // Since we create 'new Menu()' inside using mock, we check its calls.
            // The class creates one Menu instance.
            // We can't easily access that exact instance unless we spy on Menu constructor or check args passed to workspace.trigger

            const triggerCall = (mockWorkspace.trigger as jest.Mock).mock.calls[0];
            const menuInstance = triggerCall[1];

            expect(menuInstance.addItem).toHaveBeenCalled();

            // Check if one of the items is "Delete recording & link"
            // Since we manually add it inside registerPlayerMenu logic
            // logic: if (linkMatch) { addDeleteRecordingAndLinkMenuItem(...) }

            // We can check if addItem was called enough times or with specific title setup
            const calls = (menuInstance.addItem as jest.Mock).mock.calls;
            let foundDeleteLink = false;

            for (const call of calls) {
                const cb = call[0];
                const mockItem = {
                    setTitle: jest.fn().mockReturnThis(),
                    setIcon: jest.fn().mockReturnThis(),
                    setSection: jest.fn().mockReturnThis(),
                    onClick: jest.fn(),
                };
                cb(mockItem);
                if (mockItem.setTitle.mock.calls.length > 0 && mockItem.setTitle.mock.calls[0][0] === 'Delete recording & link to file') {
                    foundDeleteLink = true;
                    break;
                }
            }

            expect(foundDeleteLink).toBe(true);
        });

        it('should handle errors in link resolution gracefully', () => {
            const embed = document.createElement('div');
            embed.className = 'internal-embed';
            embed.setAttribute('src', 'audio.mp3');
            const target = document.createElement('span');
            embed.appendChild(target);

            const mockEvent = {
                target: target,
                pageX: 100,
                pageY: 200,
                preventDefault: jest.fn(),
                stopPropagation: jest.fn(),
            } as unknown as MouseEvent;

            const mockFile = new TFile();
            Object.defineProperty(mockFile, 'extension', { value: 'mp3' });
            (mockMetadataCache.getFirstLinkpathDest as jest.Mock).mockReturnValue(mockFile);

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

            // Force error by returning an editor that throws inside posAtDOM
            const mockEditor = {
                get cm() {
                    return {
                        posAtDOM: jest.fn().mockImplementation(() => {
                            throw new Error('Test Error');
                        })
                    };
                }
            } as unknown as Editor;
            (mockWorkspace.getActiveViewOfType as jest.Mock).mockReturnValue({
                editor: mockEditor
            });

            playerMenuCallback(mockEvent);

            expect(consoleSpy).toHaveBeenCalledWith(
                '[AudioRecorder] Failed to resolve link position in editor:',
                expect.any(Error)
            );
            consoleSpy.mockRestore();
        });
    });
});
