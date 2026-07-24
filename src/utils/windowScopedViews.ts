/**
 * Window-scoped lookup of the MarkdownView that owns a DOM node. Used to
 * resolve a right-clicked embed or a clicked timecode link against the note it
 * actually lives in, so resolution stays correct in pop-out windows and
 * background splits instead of assuming the globally active note.
 * @module utils/windowScopedViews
 */

import { MarkdownView } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Finds the open MarkdownView whose container holds the given node.
 * `Node.contains` is scoped to the node's own document, so a node matches only
 * the view in its own window, which is what makes the lookup correct across
 * pop-out windows and background splits rather than the globally active view.
 * @param app - Obsidian app whose open leaves are searched
 * @param node - The DOM node to locate (an embed element or a link node)
 * @returns The owning MarkdownView, or null when none holds it
 */
export function markdownViewContaining(
	app: App,
	node: Node,
): MarkdownView | null {
	const owning: MarkdownView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.containerEl.contains(node)) {
			owning.push(view);
		}
	});
	return owning[0] ?? null;
}
