/**
 * Where a quick note's text goes: the cursor of the note the dictation was
 * started in, as it stood when the microphone opened.
 *
 * A position taken as a line and a column goes stale the moment the user types
 * above it, and a dictation takes long enough for that to be the common case.
 * So the position is held inside the editor itself, in a CodeMirror state field
 * that maps it through every edit, and read back when the text arrives. When
 * that editor is gone, the offset taken at the start is the best that is left:
 * the note open elsewhere takes the text there, and a closed note takes it in
 * its file.
 * @module quicknotes/dictationAnchor
 */

import { StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MarkdownView, editorInfoField } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { findNoteView } from '../utils/noteViews';

/** Sets the anchor of one editor, or clears it with null. */
const setDictationAnchor = StateEffect.define<number | null>();

/**
 * The dictation anchor of one editor: the offset the text goes to, mapped
 * through every edit, or null when no dictation is anchored there.
 *
 * It maps with association to the left, so text typed at the anchor after the
 * dictation started stays after the dictated text: the dictation goes where the
 * cursor was when it began. A transaction that replaces the whole document,
 * which is how an editor reused for another note or a reload swaps its content,
 * leaves nothing for the offset to mean, and the anchor is dropped.
 */
export const dictationAnchorField = StateField.define<number | null>({
	create: () => null,
	update(anchor, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setDictationAnchor)) {
				return effect.value;
			}
		}
		if (anchor === null || !transaction.docChanged) {
			return anchor;
		}
		const before = transaction.startState.doc.length;
		let replacedWhole = false;
		transaction.changes.iterChangedRanges((fromA, toA) => {
			if (before > 0 && fromA === 0 && toA === before) {
				replacedWhole = true;
			}
		});
		return replacedWhole ? null : transaction.changes.mapPos(anchor, -1);
	},
});

/**
 * The CodeMirror editor behind a Markdown view, found through the DOM and
 * confirmed through Obsidian's `editorInfoField`, so an editor nested in the
 * view (an embed) is never taken for the view's own.
 * @param view - The Markdown view
 * @returns Its editor, or null when it shows none
 */
function editorViewOf(view: MarkdownView): EditorView | null {
	const root = view.contentEl.querySelector<HTMLElement>('.cm-editor');
	const editorView = root ? EditorView.findFromDOM(root) : null;
	if (
		!editorView ||
		editorView.state.field(editorInfoField, false)?.editor !== view.editor
	) {
		return null;
	}
	return editorView;
}

/** One dictation's place in a note, from the press that started it. */
export class DictationAnchor {
	private constructor(
		/**
		 * The note the dictation was started in. Held as the file rather than
		 * its path, because a rename rewrites the path on the same TFile, and
		 * a new note is often renamed through its inline title while the
		 * dictation records.
		 */
		private readonly file: TFile,
		/** The cursor's offset when it started, for when the editor is gone. */
		private readonly offset: number,
		/** The editor holding the mapped anchor, when one could take it. */
		private readonly editorView: EditorView | null,
	) {}

	/** The note's path as it stands now, after any rename. */
	get notePath(): string {
		return this.file.path;
	}

	/**
	 * Anchors a dictation at the cursor of the active note.
	 * @param app - Obsidian App
	 * @returns The anchor, or null when no Markdown note is active
	 */
	static place(app: App): DictationAnchor | null {
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		const editor = view?.editor;
		if (!view || !file || !editor) {
			return null;
		}
		const offset = editor.posToOffset(editor.getCursor());
		const editorView = editorViewOf(view);
		const anchored =
			editorView?.state.field(dictationAnchorField, false) !== undefined;
		if (editorView && anchored) {
			editorView.dispatch({ effects: setDictationAnchor.of(offset) });
		}
		return new DictationAnchor(file, offset, anchored ? editorView : null);
	}

	/**
	 * Inserts the text at the anchor and releases it.
	 * @param app - Obsidian App
	 * @param text - The text, verbatim
	 * @returns The note the text went into, or null when the note is gone
	 */
	async insert(app: App, text: string): Promise<string | null> {
		const tracked = this.trackedPosition();
		if (tracked !== null && this.editorView) {
			const cursor = this.editorView.state.selection.main;
			// A cursor still standing where the dictation began moves past the
			// text, as typing it would have; one the user moved stays put.
			const followText = cursor.empty && cursor.head === tracked;
			this.editorView.dispatch({
				changes: { from: tracked, insert: text },
				effects: setDictationAnchor.of(null),
				...(followText
					? { selection: { anchor: tracked + text.length } }
					: {}),
			});
			return this.notePath;
		}
		this.release();
		const open = findNoteView(app, this.notePath);
		if (open?.editor) {
			const length = open.editor.getValue().length;
			open.editor.replaceRange(
				text,
				open.editor.offsetToPos(Math.min(this.offset, length)),
			);
			return this.notePath;
		}
		// A deleted note leaves its TFile behind, so the vault is asked whether
		// it still holds this very file under its path.
		if (app.vault.getFileByPath(this.notePath) !== this.file) {
			return null;
		}
		await app.vault.process(this.file, (data) => {
			const at = Math.min(this.offset, data.length);
			return data.slice(0, at) + text + data.slice(at);
		});
		return this.notePath;
	}

	/** Drops the anchor without inserting, for a dictation that ended empty. */
	release(): void {
		if (this.editorView?.state.field(dictationAnchorField, false) != null) {
			this.editorView.dispatch({ effects: setDictationAnchor.of(null) });
		}
	}

	/**
	 * The anchor as the editor has mapped it, or null when the editor is gone,
	 * now shows another note, or dropped the anchor.
	 */
	private trackedPosition(): number | null {
		const editorView = this.editorView;
		if (
			!editorView?.dom.isConnected ||
			editorView.state.field(editorInfoField, false)?.file !== this.file
		) {
			return null;
		}
		return editorView.state.field(dictationAnchorField, false) ?? null;
	}
}
