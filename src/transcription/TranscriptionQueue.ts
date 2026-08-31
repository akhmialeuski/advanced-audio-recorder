/**
 * A queue of recordings to transcribe, kept on disk so it survives a restart.
 *
 * Transcribing a month of recordings meant opening each one and waiting, and
 * closing Obsidian halfway through lost everything that had not run yet. The
 * queue holds the list and each entry's state in the plugin folder, the same
 * way {@link SessionJournal} holds an interrupted recording: a serialized
 * chain of operations that never rejects, a coalesced write, a structural
 * guard on read, and a version so a later shape can be migrated.
 *
 * It lives beside the settings rather than in them: a queue is frequently
 * rewritten and entirely losable, and settings persistence carries backup and
 * recovery machinery that must not be triggered by either.
 * @module transcription/TranscriptionQueue
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';

/** Queue file name inside the plugin folder. */
export const TRANSCRIPTION_QUEUE_FILE = 'transcription-queue.json';

/** On-disk format version, for future migrations. */
const QUEUE_VERSION = 1;

/** Debounce window for writing the queue file after a change. */
const SAVE_DEBOUNCE_MS = 500;

/** What one queued recording is doing. */
export const QUEUE_ENTRY_STATES = [
	'waiting',
	'running',
	'done',
	'failed',
] as const;

/** The state of one queued recording. */
export type QueueEntryState = (typeof QUEUE_ENTRY_STATES)[number];

/** One recording in the queue. */
export interface QueueEntry {
	/** Vault-relative path of the recording. */
	path: string;
	/** What it is doing. */
	state: QueueEntryState;
	/** What went wrong, for an entry that failed. */
	error?: string;
}

/** Shape of the queue file. */
export interface QueueFileShape {
	version: number;
	/** The entries, in the order they were queued. */
	entries: QueueEntry[];
	/** Whether the queue is paused; a paused queue starts nothing new. */
	paused: boolean;
}

/**
 * Whether a parsed value has the queue shape. A file that fails this is
 * discarded rather than migrated: a queue is losable, and re-queueing a
 * folder costs the user one action.
 * @param value - Parsed JSON value
 * @returns True for a structurally valid queue
 */
function isValidQueue(value: unknown): value is QueueFileShape {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<QueueFileShape>;
	if (
		typeof candidate.version !== 'number' ||
		typeof candidate.paused !== 'boolean' ||
		!Array.isArray(candidate.entries)
	) {
		return false;
	}
	return candidate.entries.every((entry: unknown) => {
		if (typeof entry !== 'object' || entry === null) {
			return false;
		}
		const item = entry as Partial<QueueEntry>;
		return (
			typeof item.path === 'string' &&
			typeof item.state === 'string' &&
			(QUEUE_ENTRY_STATES as readonly string[]).includes(item.state)
		);
	});
}

/** A queue with nothing in it. */
function emptyQueue(): QueueFileShape {
	return { version: QUEUE_VERSION, entries: [], paused: false };
}

/**
 * The recordings waiting to be transcribed, and what each is doing.
 */
export class TranscriptionQueue {
	/** In-memory state, loaded from disk on first use. */
	private state: QueueFileShape = emptyQueue();

	/** Whether the disk state has been read yet. */
	private loaded = false;

	/** The read in flight, so callers arriving during it share that one read. */
	private loading: Promise<void> | null = null;

	/** Serialized operation chain, which never rejects. */
	private chain: Promise<void> = Promise.resolve();

	/**
	 * Handle of the pending coalesced write, or 0 when none is waiting. A
	 * handle rather than a flag, because {@link TranscriptionQueue.flush} has
	 * to be able to call it off and write immediately.
	 */
	private saveTimer = 0;

	/** Told whenever the queue changes, so a view can redraw. */
	private readonly listeners = new Set<() => void>();

	/**
	 * @param queuePath - Vault-relative queue file path, or null when the
	 *   plugin folder is unknown, in which case the queue is memory-only
	 * @param app - The Obsidian App instance
	 */
	constructor(
		private readonly queuePath: string | null,
		private readonly app: App,
	) {}

	/**
	 * Reads the queue from disk, once.
	 *
	 * A caller arriving while the read is in flight waits for that same read
	 * rather than being told the queue is already loaded. Marking it loaded
	 * before the disk had answered let the second caller straight through to
	 * an empty queue, and the recordings it added were then overwritten by the
	 * file the first caller was still waiting for - a folder queued at startup
	 * silently vanishing.
	 */
	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loading ??= this.readFromDisk();
		await this.loading;
	}

	/**
	 * Reads the queue file into memory. A missing file is an empty queue; a
	 * file that is not a queue is discarded with a warning, because a queue is
	 * losable and re-queueing costs one action.
	 */
	private async readFromDisk(): Promise<void> {
		try {
			if (
				!this.queuePath ||
				!(await this.app.vault.adapter.exists(this.queuePath))
			) {
				return;
			}
			const parsed: unknown = JSON.parse(
				await this.app.vault.adapter.read(this.queuePath),
			);
			if (isValidQueue(parsed)) {
				this.state = parsed;
				return;
			}
			console.warn(
				`${PLUGIN_LOG_PREFIX} The transcription queue file is not a queue; starting empty.`,
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the transcription queue:`,
				error,
			);
		} finally {
			// Set here rather than on the way in, so "loaded" means the disk
			// has answered and not merely that someone asked.
			this.loaded = true;
			this.loading = null;
		}
	}

	/** A snapshot of the queue, safe to render. */
	entries(): QueueEntry[] {
		return this.state.entries.map((entry) => ({ ...entry }));
	}

	/** Whether the queue is paused. */
	isPaused(): boolean {
		return this.state.paused;
	}

	/** The next recording to transcribe, or null while there is none. */
	next(): QueueEntry | null {
		if (this.state.paused) {
			return null;
		}
		return (
			this.state.entries.find((entry) => entry.state === 'waiting') ??
			null
		);
	}

	/**
	 * How many recordings a run of this queue would still transcribe.
	 *
	 * What the queue costs is counted from these and not from every entry it
	 * holds: an entry that is done or failed has already had whatever it cost
	 * spent on it, and pricing the whole list tells the user a drained queue
	 * is about to charge them again for work that is finished.
	 * @returns Entries still waiting or in flight
	 */
	pendingCount(): number {
		return this.state.entries.filter(
			(entry) => entry.state === 'waiting' || entry.state === 'running',
		).length;
	}

	/**
	 * Whether anything is left to do. What decides that a queue resumed after
	 * a restart still has work, and what a view asks before offering to run.
	 */
	hasWork(): boolean {
		return this.pendingCount() > 0;
	}

	/**
	 * Adds recordings to the queue, skipping any already in it. A path queued
	 * twice would transcribe it twice and bill for it twice.
	 * @param paths - Vault-relative recording paths
	 * @returns How many were added
	 */
	add(paths: readonly string[]): number {
		const known = new Set(this.state.entries.map((entry) => entry.path));
		const added = paths.filter((path) => !known.has(path));
		this.state.entries.push(
			...added.map((path): QueueEntry => ({ path, state: 'waiting' })),
		);
		this.changed();
		return added.length;
	}

	/**
	 * Records what one entry is doing.
	 * @param path - Vault-relative recording path
	 * @param state - What it is doing now
	 * @param error - What went wrong, for an entry that failed
	 */
	setState(path: string, state: QueueEntryState, error?: string): void {
		const entry = this.state.entries.find((item) => item.path === path);
		if (!entry) {
			return;
		}
		entry.state = state;
		if (error) {
			entry.error = error;
		} else {
			delete entry.error;
		}
		this.changed();
	}

	/**
	 * Pauses or resumes the queue. A paused queue lets the recording already
	 * running finish and starts nothing after it.
	 * @param paused - Whether to pause
	 */
	setPaused(paused: boolean): void {
		this.state.paused = paused;
		this.changed();
	}

	/**
	 * Removes one entry. A recording already running is left alone: stopping
	 * it is the run's own business, and dropping the entry would lose the
	 * record of what it is doing.
	 * @param path - Vault-relative recording path
	 * @returns True when an entry was removed
	 */
	remove(path: string): boolean {
		const index = this.state.entries.findIndex(
			(entry) => entry.path === path && entry.state !== 'running',
		);
		if (index < 0) {
			return false;
		}
		this.state.entries.splice(index, 1);
		this.changed();
		return true;
	}

	/** Empties the queue, leaving anything currently running in place. */
	clear(): void {
		this.state.entries = this.state.entries.filter(
			(entry) => entry.state === 'running',
		);
		this.changed();
	}

	/**
	 * Marks whatever was running as waiting again. Called on load: a run that
	 * was in flight when Obsidian closed did not finish, and leaving it as
	 * running would strand the queue behind an entry nothing will complete.
	 */
	requeueInterrupted(): void {
		let changed = false;
		for (const entry of this.state.entries) {
			if (entry.state === 'running') {
				entry.state = 'waiting';
				changed = true;
			}
		}
		if (changed) {
			this.changed();
		}
	}

	/**
	 * Subscribes to changes, so a view redraws when the queue moves.
	 * @param listener - Told after every change
	 * @returns Unsubscribes
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Writes any pending change now, for plugin unload.
	 *
	 * The debounce is cancelled rather than waited out. This call is the write
	 * that timer was going to make, and unload has no half-second to spare:
	 * the timer used to sit inside the same serialized chain, so a flush
	 * queued behind it and the last change a user made before quitting came
	 * back next session as if it had never happened.
	 */
	async flush(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = 0;
		await this.enqueue(() => this.write());
	}

	/** Tells the listeners and schedules a write. */
	private changed(): void {
		for (const listener of this.listeners) {
			listener();
		}
		this.scheduleWrite();
	}

	/**
	 * Queues one coalesced write. Several changes in a row cost one write,
	 * which is what keeps a queue that moves per recording from rewriting the
	 * file on every state change.
	 *
	 * The wait is a timer of its own rather than a sleep inside the write
	 * chain, so it can be cancelled. Held in the chain it blocked everything
	 * behind it, including the flush that unload depends on.
	 */
	private scheduleWrite(): void {
		// Anchored on the first change of a burst rather than the last, so a
		// queue that keeps moving is still written every half second instead
		// of postponing its write for as long as anything is happening.
		if (this.saveTimer !== 0 || !this.queuePath) {
			return;
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			void this.enqueue(() => this.write());
		}, SAVE_DEBOUNCE_MS);
	}

	/** Writes the queue, warning rather than throwing on failure. */
	private async write(): Promise<void> {
		if (!this.queuePath) {
			return;
		}
		try {
			await this.app.vault.adapter.write(
				this.queuePath,
				JSON.stringify(this.state),
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to write the transcription queue:`,
				error,
			);
		}
	}

	/**
	 * Runs one task behind any in-flight one, so two writes never interleave.
	 * A failure is contained so the chain stays usable.
	 * @param task - The task to queue
	 * @returns Resolves when the task has run
	 */
	private enqueue(task: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(task).catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} A transcription queue write failed:`,
				error,
			);
		});
		return this.chain;
	}
}
