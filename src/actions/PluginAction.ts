/**
 * A plugin action defined once and surfaced everywhere: the same
 * definition registers as a palette command (which makes it
 * hotkey-assignable in Obsidian's Hotkeys settings), as a command of the
 * Obsidian command line, and, on the surfaces that have one, renders as a
 * context-menu item. Every action is the same shape over a different context -
 * an audio file, a position in one, the recording session, or the playback
 * that is running - so adding a feature is an entry in one of the lists in
 * this directory and nothing else.
 * @module actions/PluginAction
 */

import type { App, CliData, CliFlags, Editor, TFile, TFolder } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptionModalOptions } from '../ui/TranscriptionModal';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import type { AutoChapterService } from '../chapters/AutoChapterService';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { LlmCostSink } from '../transcription/llm/llmStep';
import type { RunCostSink } from '../transcription/SessionCostTracker';
import type { PlaybackControlsState } from '../player/playbackControls';
import type { MarkerKind } from '../markers/markerModel';
import type { MarkerHit } from '../markers/MarkerSearchIndex';
import type { RecordingMarkerHandle } from '../recording/recordingMarkers';
import type { RecordingStatus } from '../types';

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
	/** Palette title, and the menu title unless one is given, in sentence case. */
	readonly title: string;
	/**
	 * The title a context menu shows instead, where the menu names its target
	 * differently: a menu opened on a point of the player says "here" where
	 * the palette has to say "at the current playback position".
	 */
	readonly menuTitle?: string;
	/** Lucide icon name, used by the menus and the mobile toolbar. */
	readonly icon: string;
	/** Availability gate beyond the context resolving at all. */
	isAvailable(context: TContext): boolean;
	/** Executes the action for someone in front of the app. */
	run(context: TContext): void | Promise<void>;
	/**
	 * The same action as a command of the Obsidian command line. Required, so
	 * an action cannot reach the menus and the palette without also reaching
	 * the command line: the type will not compile until it says how.
	 */
	readonly cli: ActionCli<TContext>;
}

/**
 * How an action runs from the command line, where nobody is in front of the
 * app: it takes its choices as parameters instead of from a dialog, and
 * answers with text instead of a notice.
 */
export interface ActionCli<TContext> {
	/**
	 * What follows the plugin id in the command: `<plugin-id>:<name>`. Short
	 * and verb-like, since it is typed rather than searched for.
	 */
	readonly name: string;
	/** The line `obsidian help` shows for the command. */
	readonly description: string;
	/** Parameters beyond the ones naming the target, which the family owns. */
	readonly params?: CliFlags;
	/**
	 * Whether {@link PluginCommand.run} opens a dialog. Such an action also
	 * takes the `dialog` flag, which opens that dialog in Obsidian on the
	 * named target instead of running without it.
	 */
	readonly opensDialog?: boolean;
	/**
	 * The flag that makes {@link execute} answer only once the job it starts
	 * is over, for an action that otherwise answers as soon as it started
	 * one. The command line sets it on every target when there are several,
	 * so they run one after another rather than all at once.
	 */
	readonly waitFlag?: string;
	/**
	 * Why the action is not available for this target, said where a menu
	 * would simply leave the entry out. Without it a generic sentence is used.
	 * @param context - The target the action was asked for
	 */
	unavailable?(context: TContext): string;
	/**
	 * Runs the action without any dialog.
	 * @param context - The target, resolved from the parameters
	 * @param args - Everything typed after the command
	 * @returns The answer printed on the command line
	 */
	execute(context: TContext, args: CliData): string | Promise<string>;
}

/**
 * Where a family of actions finds its target on the command line: the
 * parameters that name it, shared by every action of the family, and how they
 * resolve.
 */
export interface CliTarget<TContext> {
	/** Parameters naming the target, declared on every command of the family. */
	readonly params: CliFlags;
	/**
	 * Resolves the target the parameters name.
	 * @param args - Everything typed after the command
	 * @returns One target, several to run in turn, or the sentence saying why
	 *   none could be resolved
	 */
	resolve(
		args: CliData,
	): readonly TContext[] | string | Promise<readonly TContext[] | string>;
}

/**
 * Actions that share one kind of context, and the three ways that context is
 * found: by the menu that was opened on it, by what is active when the palette
 * runs, and by what the command line names.
 */
export interface ActionFamily<TContext> {
	/** The actions, in menu and palette order. */
	readonly actions: readonly PluginCommand<TContext>[];
	/**
	 * What the palette acts on right now. Several targets are offered in a
	 * picker; none keeps every command of the family out of the palette.
	 * Resolved on every palette check, so it never holds a stale target.
	 */
	activeTargets(): readonly TContext[];
	/**
	 * Answers the palette's check without listing the targets, for a family
	 * whose targets take a pass over the vault to find. Obsidian runs the
	 * check for every command each time the palette opens, so such a family
	 * says from the settings alone whether the action is offered, and its
	 * targets are listed only when the command runs. A family whose targets
	 * come from what is active leaves it out.
	 */
	readonly offeredWithoutTargets?: (
		action: PluginCommand<TContext>,
	) => boolean;
	/** How the command line names a target. */
	readonly cliTarget: CliTarget<TContext>;
	/** Names a target in a picker row and in a command-line answer. */
	readonly describe: (context: TContext) => string;
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
	readonly transcriptionQueue: TranscriptionQueuePort;
	/**
	 * Tells every open player of a recording to re-read its markers, after an
	 * action wrote them outside any player.
	 */
	readonly onMarkersChanged: (path: string) => void;
	/**
	 * Where an action's own transcription run reports what it cost: the
	 * engine call through {@link RunCostSink}, its LLM steps through
	 * {@link LlmCostSink}. Both, because a run started from a menu lands in
	 * the same session total as one started from the dialog, and a total that
	 * covered only half of it would read as a cheaper run rather than as an
	 * incomplete count. Optional: an action surface wired without one still
	 * works and simply accounts nothing.
	 */
	readonly transcriptionCosts?: (LlmCostSink & RunCostSink) | undefined;
}

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

/** A point in a recording an action targets. */
export interface PositionContext {
	/** The recording. */
	readonly file: TFile;
	/** Seconds from the start of the recording. */
	readonly seconds: number;
	/** Whether markers may be added here: false over a read-only player. */
	readonly editable: boolean;
	/** The note links to the position are written for, when there is one. */
	readonly note?: TFile;
	/** Injected services shared by every action. */
	readonly services: ActionServices;
}

/** A folder an action targets, with the services it runs against. */
export interface FolderContext {
	/** The folder. */
	readonly folder: TFolder;
	/** Injected services shared by every action. */
	readonly services: ActionServices;
}

/**
 * The slice of the recording session the session actions drive. Declared
 * as a port rather than the manager itself, so the action definitions
 * stay independent of the recording subsystem.
 */
export interface RecordingSessionPort {
	/**
	 * Starts capture, or stops and saves a running session.
	 * @returns The reason it did not complete, or null once it has
	 */
	toggleRecording(): Promise<string | null>;
	/** Whether a session is live: capturing or paused mid-capture. */
	isSessionActive(): boolean;
	/** Pauses a running session or resumes a paused one. */
	togglePauseResume(): void;
	/** Whether a marker can be dropped at the live position right now. */
	canDropMarker(): boolean;
	/** What the recorder is doing. */
	getStatus(): RecordingStatus;
	/**
	 * Drops a marker at the live position and returns the handle that names
	 * it, or null when no marker can be dropped now.
	 * @param preselectKind - The kind the marker is created as
	 */
	captureMarkerDraft(
		preselectKind?: MarkerKind,
	): RecordingMarkerHandle | null;
}

/**
 * The slice of quick notes the session actions drive, declared as a port for
 * the same reason as {@link RecordingSessionPort}.
 */
export interface QuickNotePort {
	/** Starts a dictation, or stops the running one and inserts its text. */
	toggle(): Promise<void>;
	/** What the dictation is doing. */
	getStatus(): RecordingStatus;
}

/** Everything a recording-session action needs. */
export interface SessionServices {
	readonly app: App;
	readonly getSettings: () => AudioRecorderSettings;
	/** Persists the (mutated) settings, e.g. after choosing a device. */
	readonly saveSettings: () => Promise<void>;
	/** The live recording session the action drives. */
	readonly recording: RecordingSessionPort;
	/** Quick notes, which dictate into the note at the cursor. */
	readonly quickNote: QuickNotePort;
	/**
	 * Freezes a marker draft of the given kind at the live position and
	 * opens the naming modal. Without a kind the modal asks for one.
	 */
	readonly openMarkerModal: (kind?: MarkerKind) => void;
}

/**
 * An action on a single audio file. Rendered into the file, editor, and
 * player context menus, and registered as a palette command and a command
 * line command. Where it is offered follows from its availability over the
 * context alone: a recording reached through a note carries that note.
 */
export type FileAction = PluginCommand<FileContext>;

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
 * An action on a point in a recording. Rendered into the player menu at the
 * point that was right-clicked, and registered as a palette command over the
 * position of the playback that is running.
 */
export type PositionAction = PluginCommand<PositionContext>;

/**
 * An action on a folder. Rendered into a folder's menu, and registered as a
 * palette command that asks which folder.
 */
export type FolderAction = PluginCommand<FolderContext>;

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
	/** Every marker of every recording, from the same index the search reads. */
	readonly markerHits: () => Promise<readonly MarkerHit[]>;
	/** The transcription queue, which one of the actions shows and drives. */
	readonly transcriptionQueue: TranscriptionQueuePort;
	/** Opens the recording panel in the sidebar, creating it if closed. */
	readonly openRecordingPanel: () => Promise<void>;
}

/** One recording in the transcription queue, as the queue reports it. */
export interface QueueEntryView {
	/** Vault path of the recording. */
	readonly path: string;
	/** Where it stands: waiting, running, done or failed. */
	readonly state: string;
	/** Why it failed, for a failed entry. */
	readonly error?: string | undefined;
}

/** The transcription queue as a whole, as the queue reports it. */
export interface QueueStatusView {
	/** Every entry, in queue order. */
	readonly entries: readonly QueueEntryView[];
	/** Whether the queue was paused. */
	readonly paused: boolean;
	/** Whether a recording is being transcribed right now. */
	readonly running: boolean;
}

/**
 * The transcription queue, declared as what the actions drive rather than as
 * the coordinator itself, so the action definitions stay independent of the
 * queue's internals.
 */
export interface TranscriptionQueuePort {
	/** Queues a folder's recordings and shows the queue, as the menu does. */
	queueFolder(folder: TFolder): Promise<void>;
	/** Shows the queue, whatever state it is in. */
	open(): void;
	/**
	 * Queues a folder's recordings without showing anything.
	 * @returns How many recordings the folder holds and how many were added
	 */
	enqueueFolder(folder: TFolder): Promise<{ found: number; added: number }>;
	/** What the queue holds, read from storage if it was not read yet. */
	status(): Promise<QueueStatusView>;
	/** Starts, or resumes, transcribing what waits. */
	start(): void;
	/** Pauses after the recording being transcribed. */
	pause(): void;
	/** Removes every entry that is not running. */
	clear(): void;
	/**
	 * Removes one entry.
	 * @returns Whether it was removed; a running entry is not
	 */
	remove(path: string): boolean;
}

/**
 * An action that searches the vault. Its context always resolves, because it
 * is bound to no file and no playback: a marker can be looked for from any
 * note, which is exactly why it is not a file action.
 */
export type SearchAction = PluginCommand<SearchServices>;

/** What an action about the plugin itself needs. */
export interface HelpServices {
	/** Shows every release the bundle carries notes for. */
	readonly showReleaseNotes: () => void;
}

/**
 * An action that explains the plugin rather than acting on audio. Its context
 * always resolves, since it is bound to nothing in the vault at all.
 */
export type HelpAction = PluginCommand<HelpServices>;
