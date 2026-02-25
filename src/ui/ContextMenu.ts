/**
 * Handles context menu registrations and events for the plugin.
 * @module ui/ContextMenu
 */

import {
	App,
	Menu,
	TFile,
	TAbstractFile,
	Plugin,
	Editor,
	Notice,
	MarkdownView,
} from 'obsidian';
import type { MenuItem } from 'obsidian';
import { AUDIO_EXTENSIONS } from '../constants';
import { getAudioFileInfo } from '../utils/AudioFileAnalyzer';
import { AudioFileInfoModal } from './AudioFileInfoModal';

/**
 * Manages context menu items for audio files.
 */
export class ContextMenu {
	/**
	 * Creates a new ContextMenu instance.
	 * @param app - The Obsidian App instance.
	 * @param plugin - The plugin instance.
	 */
	constructor(
		private app: App,
		private plugin: Plugin,
	) {}

	/**
	 * Registers all context menu events.
	 */
	register(): void {
		this.registerFileMenu();
		this.registerEditorMenu();
		this.registerPlayerMenu();
	}

	/**
	 * Registers a global context menu event for audio players.
	 * Detects right-clicks on standard Obsidian audio embeds and shows the file menu.
	 */
	private registerPlayerMenu(): void {
		this.plugin.registerDomEvent(
			document,
			'contextmenu',
			(event: MouseEvent) => {
				const target = event.target as HTMLElement;

				// Standard Obsidian embeds are wrapped in a container with class 'internal-embed'
				const embed = target.closest('.internal-embed');

				if (!embed) {
					return;
				}

				// The src attribute contains the link text (filename or path)
				const src = embed.getAttribute('src');
				if (!src) {
					return;
				}

				// Resolve the file from the link text.
				// We use the active file as the source path to handle relative links correctly.
				const activeFile = this.app.workspace.getActiveFile();
				const sourcePath = activeFile ? activeFile.path : '';
				const file = this.app.metadataCache.getFirstLinkpathDest(
					src,
					sourcePath,
				);

				if (!file) {
					return;
				}

				if (file instanceof TFile && this.isAudioFile(file)) {
					// Prevent the default browser context menu
					event.preventDefault();
					event.stopPropagation();

					const menu = new Menu();

					// Attempt to find the link in the editor to offer "Delete recording & link"
					const activeView =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView) {
						const editor = activeView.editor;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const editorView = (editor as any).cm;
						if (editorView && editorView.posAtDOM) {
							try {
								const pos = editorView.posAtDOM(embed);
								const cursor = editor.offsetToPos(pos);
								const lineText = editor.getLine(cursor.line);
								const linkMatch = this.findLinkAtCursor(
									lineText,
									cursor.ch,
								);

								if (linkMatch) {
									this.addDeleteRecordingAndLinkMenuItem(
										menu,
										file,
										editor,
										cursor.line,
										linkMatch,
									);
								}
							} catch (e) {
								console.error(
									'[AudioRecorder] Failed to resolve link position in editor:',
									e,
								);
							}
						}
					}

					// Trigger the 'file-menu' event to allow Obsidian and other plugins (including this one)
					// to populate the menu with valid actions for this file.
					this.app.workspace.trigger(
						'file-menu',
						menu,
						file,
						'audio-recorder-player-context-menu',
					);

					menu.showAtPosition({ x: event.pageX, y: event.pageY });
				}
			},
			{ capture: true },
		);
	}

	/**
	 * Registers the file menu event (File Explorer).
	 * Adds a "Delete recording" option for audio files.
	 */
	private registerFileMenu(): void {
		this.plugin.registerEvent(
			this.app.workspace.on(
				'file-menu',
				(menu: Menu, file: TAbstractFile) => {
					if (file instanceof TFile && this.isAudioFile(file)) {
						this.addAudioFileInfoMenuItem(menu, file);
						this.addDeleteRecordingMenuItem(menu, file);
					}
				},
			),
		);
	}

	/**
	 * Registers the editor menu event.
	 * Adds a "Delete recording & link to file" option for audio file links/embeds.
	 */
	private registerEditorMenu(): void {
		this.plugin.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(menu: Menu, editor: Editor, view: any) => {
					this.handleEditorMenu(menu, editor, view);
				},
			),
		);
	}

	/**
	 * Handles the editor menu event.
	 * @param menu - The context menu.
	 * @param editor - The editor instance.
	 * @param view - The markdown view (typed as any to avoid lint errors).
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private handleEditorMenu(menu: Menu, editor: Editor, view: any): void {
		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		const linkMatch = this.findLinkAtCursor(lineText, cursor.ch);

		if (!linkMatch) {
			return;
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(
			linkMatch.path,
			view.file ? view.file.path : '',
		);

		if (!(file instanceof TFile) || !this.isAudioFile(file)) {
			return;
		}

		this.addAudioFileInfoMenuItem(menu, file);
		this.addDeleteRecordingAndLinkMenuItem(
			menu,
			file,
			editor,
			cursor.line,
			linkMatch,
		);
	}

	/**
	 * Deletes the recording file and removes the link from the editor.
	 * @param file - The file to delete.
	 * @param editor - The editor instance.
	 * @param line - The line number where the link is located.
	 * @param linkMatch - The link match object containing start and end indices.
	 */
	private async deleteRecordingAndLink(
		file: TFile,
		editor: Editor,
		line: number,
		linkMatch: { start: number; end: number },
	): Promise<void> {
		try {
			await this.app.fileManager.trashFile(file);
			// Remove the link from editor
			editor.replaceRange(
				'',
				{
					line,
					ch: linkMatch.start,
				},
				{
					line,
					ch: linkMatch.end,
				},
			);
			new Notice('Recording and link deleted');
		} catch (error) {
			new Notice('Failed to delete recording');
			console.error('Failed to delete recording:', error);
		}
	}

	/**
	 * Checks if a file is an audio file based on its extension.
	 * @param file - The file to check.
	 * @returns True if the file is an audio file, false otherwise.
	 */
	private isAudioFile(file: TFile): boolean {
		return AUDIO_EXTENSIONS.includes(file.extension.toLowerCase());
	}

	/**
	 * Finds a markdown or wiki link at the specified cursor position in a line of text.
	 * @param lineText - The text of the line.
	 * @param cursorCh - The cursor character index.
	 * @returns An object containing the link path and its start/end indices, or null if no link is found.
	 */
	private findLinkAtCursor(
		lineText: string,
		cursorCh: number,
	): { path: string; start: number; end: number } | null {
		// Regex for internal links: ![[path]] or [[path]]
		// We focus on embedded audio usually ![[...]] but could be [[...]]
		const internalLinkRegex = /!?\[\[(.*?)(?:\|.*?)?\]\]/g;
		let match;
		while ((match = internalLinkRegex.exec(lineText)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (cursorCh >= start && cursorCh <= end) {
				return { path: match[1], start, end };
			}
		}

		// Regex for markdown links: ![alt](path) or [text](path)
		const markdownLinkRegex = /!?\[(.*?)\]\((.*?)\)/g;
		while ((match = markdownLinkRegex.exec(lineText)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (cursorCh >= start && cursorCh <= end) {
				return { path: match[2], start, end };
			}
		}

		return null;
	}
	/**
	 * Adds a "Delete recording" item to the menu.
	 * @param menu - The menu to add the item to.
	 * @param file - The file to delete.
	 */
	private addDeleteRecordingMenuItem(menu: Menu, file: TFile): void {
		menu.addItem((item: MenuItem) => {
			item.setTitle('Delete recording')
				.setIcon('trash')
				.setSection('danger')
				.onClick(async () => {
					try {
						await this.app.fileManager.trashFile(file);
						new Notice('Recording deleted');
					} catch (error) {
						new Notice('Failed to delete recording');
						console.error('Failed to delete recording:', error);
					}
				});
		});
	}

	/**
	 * Adds a "Delete recording & link to file" item to the menu.
	 * @param menu - The menu to add the item to.
	 * @param file - The file to delete.
	 * @param editor - The editor instance.
	 * @param line - The line number where the link is located.
	 * @param linkMatch - The link match object containing start and end indices.
	 */
	private addDeleteRecordingAndLinkMenuItem(
		menu: Menu,
		file: TFile,
		editor: Editor,
		line: number,
		linkMatch: { start: number; end: number },
	): void {
		menu.addItem((item: MenuItem) => {
			item.setTitle('Delete recording & link to file')
				.setIcon('trash')
				.setSection('danger')
				.onClick(() =>
					this.deleteRecordingAndLink(file, editor, line, linkMatch),
				);
		});
	}

	/**
	 * Adds an "Audio file info" item to the menu.
	 * @param menu - The menu to add the item to.
	 * @param file - The audio file.
	 */
	private addAudioFileInfoMenuItem(menu: Menu, file: TFile): void {
		menu.addItem((item: MenuItem) => {
			item.setTitle('Audio file info')
				.setIcon('info')
				.setSection('default')
				.onClick(async () => {
					const info = await getAudioFileInfo(this.app, file);
					if (info) {
						new AudioFileInfoModal(this.app, info).open();
					}
				});
		});
	}
}
