/**
 * A plugin action defined once and surfaced everywhere: the same
 * definition registers as a palette command (which makes it
 * hotkey-assignable in Obsidian's Hotkeys settings) and, on the surfaces
 * that have one, renders as a context-menu item. Every action is the same
 * shape over a different context - the active audio file, the recording
 * session, or the playback that is running - so adding a feature is an
 * entry in one of the lists in this directory and nothing else.
 * @module actions/PluginAction
 */

import type { App, TFile, TFolder } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptionModalOptions } from '../ui/TranscriptionModal';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import type { AutoChapterService } from '../chapters/AutoChapterService';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { LlmCostSink } from '../transcription/llm/llmStep';
import type { PlaybackControlsState } from '../player/playbackControls';
import type { MarkerKind } from '../markers/markerModel';

/**
 * Primes freshly written files for the enhanced player: starts their
 * media probe right away so the embeds are built enhanced (or upgraded
 * in place) instead of waiting for a lazily started probe.
 */
export type EnhancementPrimer = (paths: string[]) => void;

/**
 * A command defined once over whatever context it needs.
 *
 * The context is resolved afresh on every palette check, so an action can
 * never hold a stale file or a finished playback, and a context that does
 * not resolve is what keeps the command out of the palette and leaves a
 * hotkey bound to it inert.
 */
export interface PluginCommand<TContext> {
	/** Command id (also the per-menu dedup key). */
	readonly commandId: string;
	/** Menu and command title in sentence case. */
	readonly title: string;
	/** Lucide icon name, used by the menus and the mobile toolbar. */
	readonly icon: string;
	/** Availability gate beyond the context resolving at all. */
	isAvailable(context: TContext): boolean;
	/** Executes the action. */
	run(context: TContext): void | Promise<void>;
}

/**
 * Everything a file action handler may need, injected by the plugin at
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
	/**
	 * The transcription queue, so a folder can be queued from the menu it is
	 * right-clicked in. Declared as the two things that surface needs rather
	 * than the coordinator itself, so the action definitions stay independent
	 * of the queue's internals.
	 */
	readonly transcriptionQueue: {
		queueFolder(folder: TFolder): Promise<void>;
		open(): void;
	};
	/**
	 * Where an action's own transcription run reports what its LLM steps
	 * cost, so a run started from a menu lands in the same session total as
	 * one started from the dialog. Optional: an action surface wired without
	 * one still works and simply accounts nothing.
	 */
	readonly transcriptionCosts?: LlmCostSink | undefined;
}

/** The audio file an action targets, with the services it runs against. */
export interface FileContext {
	/** The audio file under the menu, or the active one in the palette. */
	readonly file: TFile;
	/** Injected services shared by every file action. */
	readonly services: ActionServices;
}

/**
 * The slice of the recording session the session actions drive. Declared
 * as a port rather than the manager itself, so the action definitions
 * stay independent of the recording subsystem.
 */
export interface RecordingSessionPort {
	/** Starts capture, or stops and saves a running session. */
	toggleRecording(): Promise<void>;
	/** Whether a session is live: capturing or paused mid-capture. */
	isSessionActive(): boolean;
	/** Pauses a running session or resumes a paused one. */
	togglePauseResume(): void;
	/** Whether a marker can be dropped at the live position right now. */
	canDropMarker(): boolean;
}

/** Everything a recording-session action needs. */
export interface SessionServices {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	/** Persists the (mutated) settings, e.g. after choosing a device. */
	readonly saveSettings: () => Promise<void>;
	/** The live recording session the action drives. */
	readonly recording: RecordingSessionPort;
	/**
	 * Freezes a marker draft of the given kind at the live position and
	 * opens the naming modal. Without a kind the modal asks for one.
	 */
	readonly openMarkerModal: (kind?: MarkerKind) => void;
}

/**
 * An action on a single audio file. Rendered into the file, editor, and
 * player context menus, and registered as a palette command that
 * resolves the active file.
 */
export interface FileAction extends PluginCommand<FileContext> {
	/**
	 * Whether the action is offered in the editor menu. The file
	 * explorer menu and the palette always offer available actions;
	 * the editor menu can substitute a link-aware variant instead.
	 */
	readonly showInEditorMenu: boolean;
}

/**
 * An action on the recording session. Registered as a palette command
 * whose gate reads the live session, so each gets its own hotkey.
 */
export type SessionAction = PluginCommand<SessionServices>;

/**
 * An action on the audio that is playing right now. Registered as a
 * palette command gated on the active playback snapshot, so it is absent
 * from the palette (and inert as a hotkey) while nothing plays.
 */
export type PlaybackAction = PluginCommand<PlaybackControlsState>;

/** What a vault-wide search action needs. */
export interface SearchServices {
	/**
	 * Indexes the vault's markers if it has not been indexed yet and opens
	 * the search over them.
	 */
	readonly openMarkerSearch: () => Promise<void>;
	/** Shows the transcription queue, whatever state it is in. */
	readonly openTranscriptionQueue: () => void;
}

/**
 * An action that searches the vault. Its context always resolves, because it
 * is bound to no file and no playback: a marker can be looked for from any
 * note, which is exactly why it is not a file action.
 */
export type SearchAction = PluginCommand<SearchServices>;
