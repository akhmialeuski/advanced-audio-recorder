/**
 * Maps a DOM node rendered by a Markdown editor to the editor and the source
 * position it stands for. The player's right-click menu needs it to find the
 * embed link it may delete, and a Live Preview timecode click needs it to read
 * the link it plays, because CodeMirror renders both without the target in an
 * attribute.
 *
 * Only public API is used. CodeMirror's `EditorView.findFromDOM` finds the
 * editor that owns the node, so a node in a pop-out window, a background split
 * or an editor nested inside another resolves against the editor that really
 * rendered it, and Obsidian's `editorInfoField` hands over the Obsidian
 * `Editor` and the note bound to that same CodeMirror view. The private
 * `editor.cm` this replaces could be read only from a view found some other
 * way, which had to be guessed from the workspace.
 * @module obsidian/editorDomPosition
 */

import { EditorView } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { Editor, EditorPosition, TFile } from 'obsidian';

/** Where in which editor a rendered node sits. */
export interface EditorDomPosition {
	/** The Obsidian editor that rendered the node. */
	editor: Editor;
	/** The note that editor shows, or null when it shows none. */
	file: TFile | null;
	/** The source position of the node's start. */
	position: EditorPosition;
}

/**
 * Finds the editor that rendered a node and the source position the node
 * starts at. `findFromDOM` takes the editor's root element, not an arbitrary
 * descendant, so the root is located first. A node outside the editor's
 * content, such as a gutter or a panel, maps to no source position. CodeMirror
 * documents that `posAtDOM` throws for one, and the version Obsidian ships
 * answers the start or the end of the document instead, which would name an
 * unrelated line; either way the honest answer is null, so such a node is
 * turned away before it is asked.
 * @param node - A node rendered inside a Markdown editor
 * @returns The editor, its note and the position, or null when the node is
 *   not part of an editor's content or the editor carries no Obsidian editor
 */
export function editorPositionOfNode(
	node: HTMLElement,
): EditorDomPosition | null {
	const root = node.closest<HTMLElement>('.cm-editor');
	const view = root ? EditorView.findFromDOM(root) : null;
	if (!view?.contentDOM.contains(node)) {
		return null;
	}
	const info = view.state.field(editorInfoField, false);
	const editor = info?.editor;
	if (!info || !editor) {
		return null;
	}
	return {
		editor,
		file: info.file,
		position: editor.offsetToPos(view.posAtDOM(node)),
	};
}
