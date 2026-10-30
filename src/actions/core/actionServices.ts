/**
 * The services the recording, position, folder and transcript families run
 * against, injected by the plugin at load. They live apart from the action
 * contract because four families share them while the contract knows none of
 * them: an action definition stays a stateless value, and the services carry
 * the state.
 * @module actions/core/actionServices
 */

import type { App, TFolder } from 'obsidian';
import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import type { TranscriptionModalOptions } from '../../ui/TranscriptionModal';
import type { EncodingWorkerClient } from '../../audio/EncodingWorkerClient';
import type { AutoChapterService } from '../../chapters/AutoChapterService';
import type { RecordingSidecarStore } from '../../sidecar/RecordingSidecarStore';
import type { LlmCostSink } from '../../transcription/llm/llmStep';
import type { RunCostSink } from '../../transcription/SessionCostTracker';

/**
 * Primes freshly written files for the enhanced player: starts their
 * media probe right away so the embeds are built enhanced (or upgraded
 * in place) instead of waiting for a lazily started probe.
 */
export type EnhancementPrimer = (paths: string[]) => void;

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
