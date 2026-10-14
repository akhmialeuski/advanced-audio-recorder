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
	getLinkpath,
} from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
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
import { recordingsInNote } from '../actions/recordingTargets';

export type { EnhancementPrimer } from '../actions/PluginAction';

/** CodeMirror view attached to Editor (internal Obsidian API). */
interface EditorCodeMirrorView {
	/** The editor's own DOM, which holds the widgets it renders. */
	dom?: HTMLElement;
	posAtDOM?(node: Node): number;
}

/** The source the player menu re-triggers file-menu with. */
const PLAYER_MENU_SOURCE = 'audio-recorder-player-context-menu';

/** The source Obsidian raises file-menu with for a link right-clicked in a note. */
const LINK_MENU_SOURCE = 'link-context-menu';

interface EditorWithCM extends Editor {
	cm?: EditorCodeMirrorView;
}

/** What a menu learns about how a recording was reached, filled in by each handler. */
type MutableFileContext = {
	-readonly [K in keyof FileContext]: FileContext[K];
};

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

	/**
	 * Per-menu context of each recording the file actions were rendered for.
	 * Obsidian raises file-menu and editor-menu for one link on one Menu, in
	 * an order this plugin cannot rely on, and each knows something the other
	 * does not: the editor knows where the link is, the link's own menu that
	 * it is a link. Every handler adds what it knows to the one context, so
	 * the actions are offered on everything known when each renders, and run
	 * on everything known by the time one is clicked.
	 */
	private readonly fileContexts = new WeakMap<
		Menu,
		Map<string, MutableFileContext>
	>();

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
	 * The context of a recording in a menu, with what this handler knows
	 * added to what the handlers before it found.
	 * @param menu - The menu
	 * @param file - The recording
	 * @param known - What this handler knows of how it was reached
	 * @returns The one context the menu's file actions share
	 */
	private fileContextFor(
		menu: Menu,
		file: TFile,
		known: {
			note?: TFile | null;
			link?: LinkLocation | null;
			throughLink?: boolean;
		},
	): FileContext {
		let contexts = this.fileContexts.get(menu);
		if (!contexts) {
			contexts = new Map();
			this.fileContexts.set(menu, contexts);
		}
		let context = contexts.get(file.path);
		if (!context) {
			context = { file, services: this.services };
			contexts.set(file.path, context);
		}
		if (known.note && !context.note) {
			context.note = known.note;
		}
		if (known.link && !context.link) {
			context.link = known.link;
		}
		if (known.throughLink) {
			context.throughLink = true;
		}
		return context;
	}

	/**
	 * The note of a view, when it links the recording: a note a player or a
	 * link is merely shown in - transcluded from another note - is not the
	 * note the recording was reached through.
	 * @param view - The view the menu was opened in
	 * @param file - The recording
	 */
	private noteLinking(view: MarkdownView | null, file: TFile): TFile | null {
		const note = view?.file ?? null;
		return note && recordingsInNote(this.app, note).includes(file)
			? note
			: null;
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
				const linkingNote = this.noteLinking(owningView, file);
				const note = linkingNote ?? undefined;

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
				// delete removes the embed that was right-clicked. A player is
				// an embed of the recording whether or not either is found.
				const link = owningView
					? this.linkOfEmbed(
							owningView.editor,
							embed as HTMLElement,
							file,
							sourcePath,
						)
					: null;
				this.registry.renderInto(
					menu,
					this.families.file,
					this.fileContextFor(menu, file, {
						note: linkingNote,
						link,
						throughLink: true,
					}),
					rendered,
				);

				// Lets Obsidian and other plugins add their own entries for the
				// file; this plugin's own handler finds its actions already in.
				this.app.workspace.trigger(
					'file-menu',
					menu,
					file,
					PLAYER_MENU_SOURCE,
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
	 * @param file - The recording the embed plays
	 * @param sourcePath - The note its links resolve from
	 * @returns The link, or null when its position could not be resolved to
	 *   a link of the recording
	 */
	private linkOfEmbed(
		editor: Editor,
		embed: HTMLElement,
		file: TFile,
		sourcePath: string,
	): LinkLocation | null {
		const editorView = (editor as EditorWithCM).cm;
		// Only a player the editor itself renders has a position in its text;
		// one drawn in reading view maps to whatever line is nearest.
		if (!editorView?.posAtDOM || !editorView.dom?.contains(embed)) {
			return null;
		}
		try {
			const pos = editorView.posAtDOM(embed);
			const cursor = editor.offsetToPos(pos);
			const found = linkAtCursor(editor.getLine(cursor.line), cursor.ch);
			// The line holds the embed's own link only if that link reaches
			// this very recording.
			const isThisLink =
				found !== null &&
				this.app.metadataCache.getFirstLinkpathDest(
					getLinkpath(found.path),
					sourcePath,
				) === file;
			return found && isThisLink
				? {
						editor,
						path: found.path,
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
				(
					menu: Menu,
					file: TAbstractFile,
					source: string,
					leaf?: WorkspaceLeaf,
				) => {
					if (file instanceof TFile && isAudioFile(file)) {
						// The player menu rendered these with the note the
						// player is in before it re-triggered the event, for
						// Obsidian and other plugins to add theirs.
						if (source === PLAYER_MENU_SOURCE) {
							return;
						}
						// A link right-clicked in a note reaches the recording
						// through it, and through the note of the leaf - or the
						// active one - when that note links it.
						const throughLink = source === LINK_MENU_SOURCE;
						const view = !throughLink
							? null
							: leaf?.view instanceof MarkdownView
								? leaf.view
								: this.app.workspace.getActiveViewOfType(
										MarkdownView,
									);
						this.registry.renderInto(
							menu,
							this.families.file,
							this.fileContextFor(menu, file, {
								note: this.noteLinking(view, file),
								throughLink,
							}),
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

		// The path without its subpath: a timecode link reaches its
		// recording as a whole-file link does.
		const file = this.app.metadataCache.getFirstLinkpathDest(
			getLinkpath(found.path),
			view.file ? view.file.path : '',
		);

		if (!(file instanceof TFile) || !isAudioFile(file)) {
			return;
		}

		// The link the cursor is on is what makes the link-aware delete the
		// one offered here, in place of the plain one; what of it the delete
		// removes is the delete's to decide.
		this.registry.renderInto(
			menu,
			this.families.file,
			this.fileContextFor(menu, file, {
				note: view.file,
				link: {
					editor,
					path: found.path,
					line: cursor.line,
					start: found.start,
					end: found.end,
				},
			}),
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
