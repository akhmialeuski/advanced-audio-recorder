/**
 * A plugin action defined once and surfaced everywhere: the same
 * definition renders as a context-menu item and registers as a palette
 * command (which makes it hotkey-assignable in Obsidian's Hotkeys
 * settings). Adding a per-file feature here puts it in the file menu,
 * the editor menu, the player menu, and the command palette at once.
 * @module actions/PluginAction
 */

import type { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptionModalOptions } from '../ui/TranscriptionModal';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import type { AutoChapterService } from '../chapters/AutoChapterService';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { PlaybackControlsState } from '../player/playbackControls';

/**
 * Primes freshly written files for the enhanced player: starts their
 * media probe right away so the embeds are built enhanced (or upgraded
 * in place) instead of waiting for a lazily started probe.
 */
export type EnhancementPrimer = (paths: string[]) => void;

/**
 * Everything an action handler may need, injected by the plugin at
 * load. Actions stay stateless definitions; the services carry state.
 */
export interface ActionServices {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	/** Persists the (mutated) settings, e.g. after registry updates. */
	readonly saveSettings: () => Promise<void>;
	readonly createTranscriptionModalOptions: () => TranscriptionModalOptions;
	readonly primeForEnhancement: EnhancementPrimer;
	readonly getWorkerClient: () => EncodingWorkerClient | null;
	/** Generates LLM chapters from a recording's transcript. */
	readonly autoChapters: AutoChapterService;
	/** Shared per-recording sidecar store (markers + transcript data). */
	readonly recordingSidecar: RecordingSidecarStore;
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

/**
 * An action on the audio that is playing right now. Registered as a
 * palette command gated on the active playback snapshot, so it is absent
 * from the palette (and inert as a hotkey) while nothing plays.
 */
export interface PlaybackAction {
	/** Command id. */
	readonly commandId: string;
	/** Command title in sentence case. */
	readonly title: string;
	/** Lucide icon name, shown on the mobile toolbar. */
	readonly icon: string;
	/**
	 * Availability gate beyond an active playback, evaluated against the
	 * snapshot (e.g. markers or chapters being offered by the player).
	 */
	isAvailable(state: PlaybackControlsState): boolean;
	/** Executes the action against the active playback. */
	run(state: PlaybackControlsState): void;
}
