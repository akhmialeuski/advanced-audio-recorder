/**
 * The plugin's entries in Obsidian's context menus: a file's menu, a folder's
 * menu, the editor's menu, and the menu of an audio player in a note.
 *
 * Every entry is an action of a family the action registry registered, so
 * every entry is also a palette command and a command-line command. What this
 * class adds is only what a menu knows and nothing else does: which file,
 * folder, link, selection or point of the player it was opened on.
 * @module ui/ContextMenu
 */

import {
	App,
	Menu,
	TFile,
	TAbstractFile,
	Plugin,
	MarkdownView,
	TFolder,
} from 'obsidian';
import type { Editor, MarkdownFileInfo } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { registerDomEventOnAllWindows } from '../utils/multiWindowDomEvents';
import { markdownViewContaining } from '../utils/windowScopedViews';
import { getPlayerEmbedActions } from '../player/playerEmbedActions';
import { isAudioFile } from '../utils/audioFile';
import { linkAtCursor } from '../obsidian/linkAtCursor';
import type {
	ActionServices,
	FileContext,
	FolderContext,
	LinkLocation,
	PositionContext,
	TranscriptSelectionContext,
} from '../actions/PluginAction';
import type {
	ActionRegistry,
	RegisteredFamily,
} from '../actions/ActionRegistry';
import { transcriptSelectionIn } from '../actions/transcriptActions';

export type { EnhancementPrimer } from '../actions/PluginAction';

/** CodeMirror view attached to Editor (internal Obsidian API). */
interface EditorCodeMirrorView {
	posAtDOM?(node: Node): number;
}

interface EditorWithCM extends Editor {
	cm?: EditorCodeMirrorView;
}

/** The registered families the menus render. */
export interface MenuFamilies {
	/** Actions on a recording. */
	readonly file: RegisteredFamily<FileContext>;
	/** Actions on a selection over transcript lines. */
	readonly transcript: RegisteredFamily<TranscriptSelectionContext>;
	/** Actions on a point of a recording. */
	readonly position: RegisteredFamily<PositionContext>;
	/** Actions on a folder. */
	readonly folder: RegisteredFamily<FolderContext>;
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
	 * @param registry - The registry the families were added to.
	 * @param families - The families the menus render.
	 */
	constructor(
		private plugin: Plugin,
		private services: ActionServices,
		private registry: ActionRegistry,
		private families: MenuFamilies,
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

				if (!(file instanceof TFile) || !isAudioFile(file)) {
					return;
				}
				// Prevent the default browser context menu
				event.preventDefault();
				event.stopPropagation();

				const menu = new Menu();
				const rendered = this.renderedSetFor(menu);
				const note = owningView?.file ?? undefined;

				// The point of the player that was clicked, when the embed is
				// an enhanced player: "here" is where the user clicked rather
				// than where the playback is.
				const actions = getPlayerEmbedActions(embed as HTMLElement);
				const seconds = actions?.timeAtClientX(event.clientX) ?? null;
				if (actions && seconds !== null) {
					this.registry.renderInto(
						menu,
						this.families.position,
						{
							file,
							seconds,
							editable: actions.markersEnabled,
							...(note ? { note } : {}),
							services: this.services,
						},
						rendered,
					);
				}

				// The note the embed is in, and its link, so the link-aware
				// delete removes the embed that was right-clicked.
				const link = owningView
					? this.linkOfEmbed(owningView.editor, embed as HTMLElement)
					: null;
				this.registry.renderInto(
					menu,
					this.families.file,
					{
						file,
						services: this.services,
						...(note ? { note } : {}),
						...(link ? { link } : {}),
					},
					rendered,
				);

				// Lets Obsidian and other plugins add their own entries for the
				// file; this plugin's own handler finds its actions already in.
				this.app.workspace.trigger(
					'file-menu',
					menu,
					file,
					'audio-recorder-player-context-menu',
				);

				menu.showAtPosition({ x: event.pageX, y: event.pageY });
			},
			{ capture: true },
		);
	}

	/**
	 * The link an embed was rendered from, located in the editor of the note
	 * it is in.
	 * @param editor - The note's editor
	 * @param embed - The right-clicked embed
	 * @returns The link, or null when its position could not be resolved
	 */
	private linkOfEmbed(
		editor: Editor,
		embed: HTMLElement,
	): LinkLocation | null {
		const editorView = (editor as EditorWithCM).cm;
		if (!editorView?.posAtDOM) {
			return null;
		}
		try {
			const pos = editorView.posAtDOM(embed);
			const cursor = editor.offsetToPos(pos);
			const found = linkAtCursor(editor.getLine(cursor.line), cursor.ch);
			return found
				? {
						editor,
						line: cursor.line,
						start: found.start,
						end: found.end,
					}
				: null;
		} catch (e) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to resolve link position in editor:`,
				e,
			);
			return null;
		}
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
	 * Registers the file menu event (File Explorer): the file actions for an
	 * audio file, the folder actions for a folder.
	 */
	private registerFileMenu(): void {
		this.plugin.registerEvent(
			this.app.workspace.on(
				'file-menu',
				(menu: Menu, file: TAbstractFile) => {
					if (file instanceof TFile && isAudioFile(file)) {
						this.registry.renderInto(
							menu,
							this.families.file,
							{ file, services: this.services },
							this.renderedSetFor(menu),
						);
						return;
					}
					// A folder is not a file action: it targets no recording
					// and every entry in that list would be wrong for it.
					if (file instanceof TFolder) {
						this.registry.renderInto(
							menu,
							this.families.folder,
							{ folder: file, services: this.services },
							this.renderedSetFor(menu),
						);
					}
				},
			),
		);
	}

	/**
	 * Registers the editor menu event: the transcript actions for a
	 * selection in a transcript line, and the file actions for the audio
	 * link under the cursor.
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
		this.addTranscriptSelectionItems(menu, editor, view);
		const cursor = editor.getCursor();
		const found = linkAtCursor(editor.getLine(cursor.line), cursor.ch);
		if (!found) {
			return;
		}

		const file = this.app.metadataCache.getFirstLinkpathDest(
			found.path,
			view.file ? view.file.path : '',
		);

		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}

		// The link the cursor is on is what makes the link-aware delete the
		// one offered here, in place of the plain one.
		this.registry.renderInto(
			menu,
			this.families.file,
			{
				file,
				services: this.services,
				...(view.file ? { note: view.file } : {}),
				link: {
					editor,
					line: cursor.line,
					start: found.start,
					end: found.end,
				},
			},
			this.renderedSetFor(menu),
		);
	}

	/**
	 * Offers the transcript actions when the menu was opened on a selection
	 * inside a transcript line, i.e. a line whose timecode link resolves to a
	 * recording.
	 * @param menu - The context menu.
	 * @param editor - The editor instance.
	 * @param view - The markdown view or file info.
	 */
	private addTranscriptSelectionItems(
		menu: Menu,
		editor: Editor,
		view: MarkdownView | MarkdownFileInfo,
	): void {
		if (!view.file) {
			return;
		}
		const context = transcriptSelectionIn(this.services, editor, view.file);
		if (!context) {
			return;
		}
		this.registry.renderInto(
			menu,
			this.families.transcript,
			context,
			this.renderedSetFor(menu),
		);
	}
}
