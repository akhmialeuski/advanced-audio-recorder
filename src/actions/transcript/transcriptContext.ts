/**
 * The target of a transcript action: a selection over rendered transcript
 * lines and the way those lines are written back. A module of its own because
 * the split and merge dialogs take this context, and the actions that open
 * those dialogs must not be what the dialogs import.
 * @module actions/transcript/transcriptContext
 */

import type { TFile } from 'obsidian';
import type { ActionServices } from '../core/actionServices';
import type { PluginCommand } from '../core/PluginAction';

/**
 * A selection over rendered transcript lines: the lines it was made in, the
 * note and the recording the first line belongs to (through its timecode
 * link), and exactly what was selected, so an action can act on those lines
 * and verify they are still the same when it does. Most selections lie inside
 * one line (`line` equals `lastLine`); one reaching over several lines spans
 * `line` to `lastLine`, both holding selected text.
 */
export interface TranscriptSelectionContext {
	/** Injected services shared by every action. */
	readonly services: ActionServices;
	/** The note's lines, read and written where the selection was made. */
	readonly lines: TranscriptLines;
	/** The note the line is in. */
	readonly note: TFile;
	/** The recording the line's timecode link resolves to. */
	readonly audio: TFile;
	/** Zero-based number of the first selected line. */
	readonly line: number;
	/** Zero-based number of the last selected line. */
	readonly lastLine: number;
	/** The first line's text when the selection was resolved. */
	readonly lineText: string;
	/**
	 * The text of every line from `line` to `lastLine` when the selection was
	 * resolved, blank lines between them included.
	 */
	readonly lineTexts: readonly string[];
	/** Selection start column, on the first line. */
	readonly from: number;
	/** Selection end column, on the last line. */
	readonly to: number;
	/** Whole seconds the first line's timecode link points at. */
	readonly seconds: number;
}

/**
 * The lines of the note a transcript selection is in, and the one way a line
 * edit writes them back: through the open editor, so a dialog's edit is
 * undone like any other, or through the note file, where no editor holds the
 * note.
 */
export interface TranscriptLines {
	/** The text of a zero-based line. */
	getLine(line: number): string;
	/** How many lines there are. */
	lineCount(): number;
	/**
	 * Replaces consecutive lines with new text, unless they no longer read as
	 * they did: an edit made over lines that moved would land on the wrong
	 * ones.
	 * @param first - Zero-based first line
	 * @param expected - What the lines must still read, in order
	 * @param text - What replaces them, possibly several lines
	 * @returns Whether they were replaced
	 */
	replaceLines(
		first: number,
		expected: readonly string[],
		text: string,
	): Promise<boolean>;
}

/**
 * An action on a selection over transcript lines. Rendered into the editor
 * menu, and registered as a palette command that resolves the active editor's
 * selection, so it is hotkey-assignable like every other action.
 */
export type TranscriptAction = PluginCommand<TranscriptSelectionContext>;
