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
	TFolder,
} from 'obsidian';
import type { MarkdownFileInfo } from 'obsidian';
import type { MenuItem } from 'obsidian';
import { AAR_MENU_SECTION, PLUGIN_LOG_PREFIX } from '../constants';
import { registerDomEventOnAllWindows } from '../utils/multiWindowDomEvents';
import { markdownViewContaining } from '../utils/windowScopedViews';
import { getPlayerEmbedActions } from '../player/playerEmbedActions';
import { MARKER_KIND, type MarkerKind } from '../markers/markerModel';
import { isAudioFile } from '../utils/audioFile';
import type { ActionServices, FileAction } from '../actions/PluginAction';
import { renderActionsIntoMenu } from '../actions/renderActionsIntoMenu';

export type { EnhancementPrimer } from '../actions/PluginAction';

/** CodeMirror view attached to Editor (internal Obsidian API). */
interface EditorCodeMirrorView {
	posAtDOM?(node: Node): number;
}

interface EditorWithCM extends Editor {
	cm?: EditorCodeMirrorView;
}

/**
 * Manages context menu items for audio files.
 */
export class ContextMenu {
	/**
	 * Per-menu ids of actions already rendered. Obsidian can fire both
	 * editor-menu and file-menu for one Menu instance, and the player
	 * menu re-triggers file-menu, so every add is deduplicated here.
	 */
	private readonly renderedActions = new WeakMap<Menu, Set<string>>();

	private readonly app: App;

	/**
	 * Creates a new ContextMenu instance.
	 * @param plugin - The plugin instance.
	 * @param services - Injected action services (app, settings, ...).
	 * @param fileActions - Per-file actions in display order.
	 */
	constructor(
		private plugin: Plugin,
		private services: ActionServices,
		private fileActions: readonly FileAction[],
	) {
		this.app = services.app;
	}

	/** Returns (creating on first use) the menu's rendered-action set. */
	private renderedSetFor(menu: Menu): Set<string> {
		let rendered = this.renderedActions.get(menu);
		if (!rendered) {
			rendered = new Set<string>();
			this.renderedActions.set(menu, rendered);
		}
		return rendered;
	}

	/**
	 * Registers all context menu events.
	 */
	register(): void {
		this.registerFileMenu();
		this.registerEditorMenu();
		this.registerPlayerMenu();
	}

	/**
	 * Registers a context menu event for audio players on every Obsidian
	 * window. Detects right-clicks on standard Obsidian audio embeds and shows
	 * the file menu. Binding per window (not once to activeDocument) is what
	 * keeps the menu working after a note is moved into a pop-out window, whose
	 * document does not share events with the main window.
	 */
	private registerPlayerMenu(): void {
		registerDomEventOnAllWindows(
			this.plugin,
			this.app,
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

				// Resolve the file from the link text against the note that
				// actually contains this embed, located from the DOM rather than
				// the globally active file. This is what keeps a relative link
				// correct when the embed lives in a pop-out window or a
				// background split, whose note is not the active one.
				const { sourcePath, view: owningView } =
					this.resolveEmbedSource(embed as HTMLElement);
				const file = this.app.metadataCache.getFirstLinkpathDest(
					src,
					sourcePath,
				);

				if (!file) {
					return;
				}

				if (file instanceof TFile && isAudioFile(file)) {
					// Prevent the default browser context menu
					event.preventDefault();
					event.stopPropagation();

					const menu = new Menu();

					// Offer "Delete recording & link" from the same note the embed
					// belongs to, so the editor lookup targets the pop-out or
					// split that was right-clicked, not the active pane.
					if (owningView) {
						const editor = owningView.editor;
						const editorView = (editor as EditorWithCM).cm;
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
									`${PLUGIN_LOG_PREFIX} Failed to resolve link position in editor:`,
									e,
								);
							}
						}
					}

					// Trigger the 'file-menu' event to allow Obsidian and other plugins (including this one)
					// to populate the menu with valid actions for this file.
					// Offer position-aware actions when the embed is an
					// enhanced player (add marker/chapter, copy timestamp).
					this.addEnhancedPlayerMenuItems(
						menu,
						embed as HTMLElement,
						event,
					);

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
	 * Resolves the note that contains an audio embed and its source path. The
	 * embed is matched to the MarkdownView whose container holds it, so a
	 * right-click resolves against the note the embed is actually in - a
	 * pop-out window or a background split as well as the active pane - rather
	 * than the globally active file. Falls back to the active file and view
	 * when the embed cannot be tied to a view (e.g. a detached render).
	 * @param embed - The right-clicked `.internal-embed` element
	 * @returns The resolved source path and owning MarkdownView, or the active
	 *   file and view as a fallback
	 */
	private resolveEmbedSource(embed: HTMLElement): {
		sourcePath: string;
		view: MarkdownView | null;
	} {
		const owningView = markdownViewContaining(this.app, embed);
		if (owningView) {
			return {
				sourcePath: owningView.file?.path ?? '',
				view: owningView,
			};
		}
		const activeFile = this.app.workspace.getActiveFile();
		return {
			sourcePath: activeFile ? activeFile.path : '',
			view: this.app.workspace.getActiveViewOfType(MarkdownView),
		};
	}

	/**
	 * Adds position-aware enhanced-player actions to the menu when the
	 * right-clicked embed is an enhanced player. The clicked time is
	 * derived from the cursor position over the seek area, so "add marker
	 * here" lands where the user clicked rather than at playback.
	 * @param menu - The context menu being built
	 * @param embed - The right-clicked embed element
	 * @param event - The originating mouse event
	 */
	private addEnhancedPlayerMenuItems(
		menu: Menu,
		embed: HTMLElement,
		event: MouseEvent,
	): void {
		const actions = getPlayerEmbedActions(embed);
		if (!actions) {
			return;
		}
		const time = actions.timeAtClientX(event.clientX);
		if (time === null) {
			return;
		}
		const addMarkerItem = (
			title: string,
			icon: string,
			kind: MarkerKind,
		): void => {
			menu.addItem((item: MenuItem) => {
				item.setTitle(title)
					.setIcon(icon)
					.setSection(AAR_MENU_SECTION)
					.onClick(() => {
						actions.addMarkerAtTime(time, kind);
					});
			});
		};
		if (actions.markersEnabled) {
			addMarkerItem(
				'Add marker here',
				'bookmark-plus',
				MARKER_KIND.bookmark,
			);
			addMarkerItem('Add chapter here', 'list-plus', MARKER_KIND.chapter);
		}
		if (actions.timestampLinksEnabled) {
			menu.addItem((item: MenuItem) => {
				item.setTitle('Copy timestamp link here')
					.setIcon('link')
					.setSection(AAR_MENU_SECTION)
					.onClick(() => {
						actions.copyTimestampAtTime(time);
					});
			});
		}
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
					if (file instanceof TFile && isAudioFile(file)) {
						renderActionsIntoMenu(
							menu,
							this.fileActions,
							{ file, services: this.services },
							this.renderedSetFor(menu),
						);
						return;
					}
					// A folder is not a file action: it targets no recording
					// and every entry in that list would be wrong for it.
					if (file instanceof TFolder) {
						this.addFolderQueueItem(menu, file);
					}
				},
			),
		);
	}

	/**
	 * Adds the queue-this-folder entry to a folder's menu.
	 * @param menu - The folder's context menu
	 * @param folder - The folder that was right-clicked
	 */
	private addFolderQueueItem(menu: Menu, folder: TFolder): void {
		if (!this.services.getSettings().transcriptionEnabled) {
			return;
		}
		menu.addItem((item) => {
			item.setTitle('Transcribe every recording in this folder')
				.setIcon('list-plus')
				.onClick(() => {
					void this.services.transcriptionQueue.queueFolder(folder);
				});
		});
	}

	/**
	 * Registers the editor menu event.
	 * Adds a "Delete recording & link to file" option for audio file links/embeds.
	 */
	private registerEditorMenu(): void {
		this.plugin.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				(
					menu: Menu,
					editor: Editor,
					view: MarkdownView | MarkdownFileInfo,
				) => {
					this.handleEditorMenu(menu, editor, view);
				},
			),
		);
	}

	/**
	 * Handles the editor menu event.
	 * @param menu - The context menu.
	 * @param editor - The editor instance.
	 * @param view - The markdown view or file info.
	 */
	private handleEditorMenu(
		menu: Menu,
		editor: Editor,
		view: MarkdownView | MarkdownFileInfo,
	): void {
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

		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}

		renderActionsIntoMenu(
			menu,
			this.fileActions.filter((action) => action.showInEditorMenu),
			{ file, services: this.services },
			this.renderedSetFor(menu),
		);
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
			const path = match[1];
			if (path !== undefined && cursorCh >= start && cursorCh <= end) {
				return { path, start, end };
			}
		}

		// Regex for markdown links: ![alt](path) or [text](path)
		const markdownLinkRegex = /!?\[(.*?)\]\((.*?)\)/g;
		while ((match = markdownLinkRegex.exec(lineText)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			const path = match[2];
			if (path !== undefined && cursorCh >= start && cursorCh <= end) {
				return { path, start, end };
			}
		}

		return null;
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
				.setSection(AAR_MENU_SECTION)
				.onClick(() =>
					this.deleteRecordingAndLink(file, editor, line, linkMatch),
				);
		});
	}
}
