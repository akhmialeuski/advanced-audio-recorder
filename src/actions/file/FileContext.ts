/**
 * The target of a recording action: the audio file, how it was reached and
 * the services it runs against. A module of its own, apart from the actions
 * that use it, because the menus and the recording panel build this context
 * too, and they must not depend on the actions that open dialogs.
 * @module actions/file/FileContext
 */

import type { TFile } from 'obsidian';
import type { ActionServices } from '../core/actionServices';
import type { PluginCommand } from '../core/PluginAction';
import type { RecordingOrigin } from './RecordingOrigin';

/** The audio file an action targets, with the services it runs against. */
export interface FileContext {
	/** The audio file under the menu, or the active one in the palette. */
	readonly file: TFile;
	/** Injected services shared by every file action. */
	readonly services: ActionServices;
	/**
	 * How the recording was reached, which decides which deletes are offered
	 * and which note a dialog opened for it writes into.
	 */
	readonly origin: RecordingOrigin;
}

/**
 * An action on a single audio file. Rendered into the file, editor, and
 * player context menus, and registered as a palette command and a command
 * line command. Where it is offered follows from its availability over the
 * context alone: a recording reached through a note carries that note.
 */
export type FileAction = PluginCommand<FileContext>;
