/**
 * A plugin action defined once and surfaced everywhere: the same
 * definition renders as a context-menu item and registers as a palette
 * command (which makes it hotkey-assignable in Obsidian's Hotkeys
 * settings). Adding a per-file feature here puts it in the file menu,
 * the editor menu, the player menu, and the command palette at once.
 * @module actions/PluginAction
 */

import type { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/Settings';
import type { TranscriptionModalOptions } from '../ui/TranscriptionModal';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';

/**
 * Primes freshly written files for the enhanced player so a cleaned or
 * converted file is upgraded immediately instead of after the note is
 * reopened.
 */
export type EnhancementPrimer = (
	paths: string[],
	notePath: string | null,
) => void;

/**
 * Everything an action handler may need, injected by the plugin at
 * load. Actions stay stateless definitions; the services carry state.
 */
export interface ActionServices {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	readonly createTranscriptionModalOptions: () => TranscriptionModalOptions;
	readonly primeForEnhancement: EnhancementPrimer;
	readonly getWorkerClient: () => EncodingWorkerClient | null;
}

/**
 * An action on a single audio file. Rendered into the file, editor,
 * and player context menus, and registered as a palette command that
 * resolves the active file.
 */
export interface FileAction {
	/** Command id (also the per-menu dedup key). */
	readonly commandId: string;
	/** Menu/command title in sentence case. */
	readonly title: string;
	/** Lucide icon name for the menu item. */
	readonly icon: string;
	/**
	 * Whether the action is offered in the editor menu. The file
	 * explorer menu and the palette always offer available actions;
	 * the editor menu can substitute a link-aware variant instead.
	 */
	readonly showInEditorMenu: boolean;
	/** Availability gate evaluated per file (and per menu build). */
	isAvailable(file: TFile, services: ActionServices): boolean;
	/** Executes the action. */
	run(file: TFile, services: ActionServices): void | Promise<void>;
}

/**
 * An action available while a recording session is live (recording or
 * paused). Registered as a palette command gated on the session state,
 * so each gets its own hotkey.
 */
export interface RecordingMarkerAction {
	/** Command id. */
	readonly commandId: string;
	/** Command title in sentence case. */
	readonly title: string;
	/** Lucide icon name. */
	readonly icon: string;
	/** Executes the action. */
	run(): void;
}
