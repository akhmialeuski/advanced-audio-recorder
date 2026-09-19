/**
 * The dialog that says what changed, shown once after the plugin updates.
 * @module ui/ReleaseNotesModal
 */

import { Component, MarkdownRenderer } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { PluginModal } from './PluginModal';

/**
 * Obsidian's own class for a block of rendered Markdown, which the renderer
 * does not add itself.
 *
 * With it the notes read as a note does: code spans, lists, quotes and tables
 * are styled, and the first and last blocks lose the margins that would
 * otherwise push the text off the top of the dialog. Nothing here is the
 * plugin's to restyle, which is why this dialog ships no CSS of its own - the
 * dialog scrolls because `.modal` is already bounded and scrollable.
 */
const RENDERED_CLASS = 'markdown-rendered';

/**
 * Shows release notes as Markdown.
 *
 * The dialog knows nothing about versions: it is handed the text to show and
 * shows it, whether that text came from an update or from the palette command.
 * Which versions are in it is decided in {@link module:release/releaseNotes},
 * and whether it opens at all in the plugin itself.
 */
export class ReleaseNotesModal extends PluginModal {
	/**
	 * Owns what the Markdown renderer builds inside the dialog. Obsidian's
	 * renderer attaches child components to the one it is given - a callout's
	 * fold, an embed, a code block's copy button - and they are torn down with
	 * their parent. Modal is not a Component, so the dialog carries one and
	 * unloads it on close; without that the children outlive the DOM they were
	 * built for.
	 */
	private readonly renderer = new Component();

	/**
	 * Creates the dialog over the notes it shows.
	 * @param app - The Obsidian App instance
	 * @param notes - Markdown of every version being announced, newest first
	 */
	constructor(
		app: App,
		private readonly notes: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle("What's new");
		if (this.notes === '') {
			// Reachable from the palette command alone: an update announces
			// itself only when it has something on record to announce.
			this.renderEmptyState(
				'This version ships no release notes. The full history is on the releases page of the plugin repository.',
			);
			return;
		}
		// An upgrade that spanned several releases is longer than any window,
		// and a dialog that scrolls as one whole carries its own title and its
		// own Close button off the top with the text.
		this.makeBodyScrollable();
		this.renderer.load();
		const body = this.contentEl.createDiv({ cls: RENDERED_CLASS });
		// The source path is what the renderer resolves a relative internal
		// link against. These notes link only to the repository, so there is
		// no note to name and an empty path is the honest answer.
		void MarkdownRenderer.render(
			this.app,
			this.notes,
			body,
			'',
			this.renderer,
		).catch((error: unknown) => {
			console.error(
				`${PLUGIN_LOG_PREFIX} Release notes could not be rendered:`,
				error,
			);
		});
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: 'This dialog can be turned off in the plugin settings.',
		});
		this.renderActions({
			text: 'Close',
			cta: true,
			onClick: () => {
				this.close();
			},
		});
	}

	override onClose(): void {
		// Before the body is emptied, not after: the renderer's children were
		// built over elements inside it and tear down against them, so an
		// unload that runs once the DOM is gone unloads them against nothing.
		this.renderer.unload();
		super.onClose();
	}
}
