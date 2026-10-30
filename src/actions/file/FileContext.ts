/**
 * The target of a recording action: the audio file, how it was reached and
 * the services it runs against. A module of its own, apart from the actions
 * that use it, because the menus and the recording panel build this context
 * too, and they must not depend on the actions that open dialogs.
 * @module actions/file/FileContext
 */

import type { Editor, TFile } from 'obsidian';
import type { ActionServices } from '../core/actionServices';
import type { PluginCommand } from '../core/PluginAction';

/** The audio file an action targets, with the services it runs against. */
export interface FileContext {
	/** The audio file under the menu, or the active one in the palette. */
	readonly file: TFile;
	/** Injected services shared by every file action. */
	readonly services: ActionServices;
	/**
	 * The note the recording was reached through: the note whose link or
	 * player the menu was opened on, the active note in the palette, the note
	 * named on the command line. What a transcript is written into and what a
	 * link is removed from. Absent when the recording was reached directly, as
	 * from the file explorer or with the audio file itself open.
	 */
	readonly note?: TFile;
	/**
	 * The link to the recording the menu or the cursor was on, when there was
	 * one: the one link an action that removes "the link" removes.
	 */
	readonly link?: LinkLocation;
	/**
	 * Set when the recording was reached through a link whose place in a
	 * note is not known: Obsidian's own menu for a link, a link in a canvas
	 * card, a player in a note that only transcludes the one linking it. The
	 * plain delete, which would leave that link broken, is not offered.
	 */
	readonly throughLink?: true;
	/**
	 * Set when the recording was reached at a moment of it: a timecode link,
	 * or a player embedded at a timestamp. A transcript holds dozens of those
	 * to one recording, so neither delete is offered from one: trashing the
	 * recording is not what a right-click on a moment asks for, and it would
	 * leave every other timestamp pointing at nothing.
	 */
	readonly atMoment?: true;
	/**
	 * Set when the context's note is the whole truth: the note it has, or
	 * none. A dialog opened for it then falls back to no note, where one
	 * opened without it falls back to the note active in the app. The command
	 * line sets it, since it names the note or names none and a script cannot
	 * see which note is active; so does a menu that knows the recording was
	 * reached through some note but cannot tell which.
	 */
	readonly noteFixed?: true;
}

/** One link in an open editor. */
export interface LinkLocation {
	/** The editor holding it. */
	readonly editor: Editor;
	/**
	 * The subpath of its target with the `#`, as in `#t=90`, or an empty
	 * string for a link to the whole file.
	 */
	readonly subpath: string;
	/** Zero-based line. */
	readonly line: number;
	/** Column the link starts at. */
	readonly start: number;
	/** Column just past its end. */
	readonly end: number;
}

/**
 * An action on a single audio file. Rendered into the file, editor, and
 * player context menus, and registered as a palette command and a command
 * line command. Where it is offered follows from its availability over the
 * context alone: a recording reached through a note carries that note.
 */
export type FileAction = PluginCommand<FileContext>;
