/**
 * Crash-recovery journal for recording sessions. Tracks the files an
 * active recording has already put on disk in a JSON file next to the
 * plugin's data.json, so a session interrupted by a crash,
 * power loss, or plugin unload can be recovered (or its leftovers
 * cleaned up) on the next launch. All operations are best-effort and
 * never throw into the recording hot path; mutations are serialized
 * and writes are coalesced.
 * @module recording/SessionJournal
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';

/** Journal file name inside the plugin folder. */
export const JOURNAL_FILE_NAME = 'recording-journal.json';

/** Current journal schema version. */
export const JOURNAL_VERSION = 1;

/**
 * Journal entry for a single recording track.
 */
export interface JournalTrack {
	/** Base name snapshotted at session start; unique per track. */
	fileBaseName: string;
	/** True for the desktop PCM/WAV capture path. */
	isPcm: boolean;
	/** Channel count of the PCM data (PCM tracks). */
	pcmChannels: number;
	/** Sample rate of the PCM data in Hz (PCM tracks). */
	pcmSampleRate: number;
	/**
	 * Level and stereo position this track was to be given in a merged
	 * file, so a mix rebuilt from recovered parts reproduces the one the
	 * interrupted session was going to write. Absent on a session that
	 * writes one file per track, and on every journal written before the
	 * mixer could place a track.
	 *
	 * Adding them deliberately did not bump JOURNAL_VERSION, by the
	 * precedent captureMode set: an older plugin ignores the fields and
	 * mixes the recovered tracks flat, while a bump would make it skip the
	 * whole journal and lose the recovery itself.
	 */
	gainDb?: number;
	/** Stereo position for the merged file; see {@link JournalTrack.gainDb}. */
	pan?: number;
	/** Live .tmp segment files (vault-relative), in capture order. */
	segmentPaths: string[];
	/**
	 * Finalized part files (vault-relative), in creation order. On the
	 * 'stream' capture mode they are auto-split deliverables recovery
	 * only reports; on 'rotation' they are the recording itself.
	 */
	partPaths: string[];
	/**
	 * True when the first MediaRecorder segment (which carries the
	 * container header) was lost: the remaining data is not playable
	 * and the track is discard-only. Set by the recovery prune.
	 */
	headerLost?: boolean;
}

/**
 * Journal entry for one recording session.
 */
export interface JournalSession {
	/** Session id; the recording timestamp string. */
	sessionId: string;
	/** Epoch milliseconds of the recording start. */
	startedAt: number;
	/**
	 * How the audio of this session reached disk. 'stream' is the
	 * journaled pipeline whose flushes write raw mid-stream segments;
	 * its part files are auto-split deliverables recovery never touches.
	 * 'rotation' is the pipeline whose every flush is a full part
	 * rotation, where the part files together ARE the interrupted
	 * recording, so recovery offers them and a discard removes them.
	 * Absent in journals written before the field existed, which were
	 * all of the first kind.
	 *
	 * Adding it deliberately did not bump JOURNAL_VERSION. The cost is
	 * that a downgraded plugin prunes a rotation session to nothing and
	 * never offers its parts, which stay on disk unclaimed. The bump
	 * would cost more: the version guard makes an older plugin skip the
	 * whole journal, losing recovery of the far commoner stream session
	 * as well.
	 */
	captureMode?: 'stream' | 'rotation';
	/**
	 * Active recorded milliseconds already finalized into part files.
	 * Written at every part rotation, so an interrupted session can be
	 * offered with its length. Absent until the first part lands, and on
	 * the PCM path, which splits by exact byte count and keeps no active
	 * clock per part.
	 */
	recordedMs?: number;
	/** Output format snapshotted at session start. */
	outputFormat: string;
	/** Container format of the MediaRecorder segments. */
	recorderFormat: string;
	/** Encoder bitrate snapshotted at session start. */
	bitrate: number;
	/** Tracks of the session. */
	tracks: JournalTrack[];
}

/**
 * On-disk journal file shape.
 */
export interface JournalFile {
	/** Schema version (JOURNAL_VERSION). */
	version: number;
	/**
	 * Sessions with possibly live temporary files. An array: a new
	 * recording started before the user decided on a crashed session
	 * appends instead of clobbering the undecided entry.
	 */
	sessions: JournalSession[];
}

/**
 * Checks that a parsed value has the journal file shape.
 * @param value - Parsed JSON value
 * @returns True for a structurally valid journal
 */
function isValidJournal(value: unknown): value is JournalFile {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { version?: unknown; sessions?: unknown };
	if (typeof candidate.version !== 'number') {
		return false;
	}
	if (!Array.isArray(candidate.sessions)) {
		return false;
	}
	return candidate.sessions.every((session: unknown) => {
		if (typeof session !== 'object' || session === null) {
			return false;
		}
		const entry = session as { sessionId?: unknown; tracks?: unknown };
		return (
			typeof entry.sessionId === 'string' && Array.isArray(entry.tracks)
		);
	});
}

/**
 * Result of reading the journal from disk.
 */
export interface JournalReadResult {
	/** Parsed journal, or null when missing or not usable. */
	data: JournalFile | null;
	/** True when the file exists but its content is not a journal. */
	corrupt: boolean;
}

/**
 * Best-effort journal of active recording sessions.
 */
export class SessionJournal {
	/** In-memory journal state, lazily loaded from disk. */
	private state: JournalFile | null = null;
	/** Session id mutations apply to. */
	private activeSessionId: string | null = null;
	/** Serialized operation chain (never rejected). */
	private opChain: Promise<void> = Promise.resolve();
	/** Whether the in-memory state has unwritten changes. */
	private dirty = false;
	/** Whether a coalesced write is already queued on the chain. */
	private writeScheduled = false;

	/**
	 * Creates a new SessionJournal.
	 * @param journalPath - Vault-relative journal file path, or null
	 * when the plugin folder is unknown (all operations no-op)
	 * @param app - The Obsidian App instance
	 */
	constructor(
		private readonly journalPath: string | null,
		private readonly app: App,
	) {}

	/**
	 * Reads and parses the journal from disk, bypassing the in-memory
	 * state. Used by the startup recovery check.
	 * @returns Parsed journal; corrupt is set when the file exists but
	 * does not parse into a valid journal. A transient read failure
	 * reports neither data nor corruption so the file survives for the
	 * next launch.
	 */
	async readJournal(): Promise<JournalReadResult> {
		if (!this.journalPath) {
			return { data: null, corrupt: false };
		}
		let raw: string;
		try {
			if (!(await this.app.vault.adapter.exists(this.journalPath))) {
				return { data: null, corrupt: false };
			}
			raw = await this.app.vault.adapter.read(this.journalPath);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the recording journal:`,
				error,
			);
			return { data: null, corrupt: false };
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isValidJournal(parsed)) {
				return { data: null, corrupt: true };
			}
			return { data: parsed, corrupt: false };
		} catch {
			return { data: null, corrupt: true };
		}
	}

	/**
	 * Removes the journal file from disk and resets the in-memory
	 * state. Used by the recovery check for corrupt journals.
	 */
	async discardJournalFile(): Promise<void> {
		if (!this.journalPath) {
			return;
		}
		try {
			if (await this.app.vault.adapter.exists(this.journalPath)) {
				await this.app.vault.adapter.remove(this.journalPath);
			}
			this.state = null;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to remove the recording journal:`,
				error,
			);
		}
	}

	/**
	 * Registers a new active recording session.
	 * @param session - Session entry to journal
	 */
	startSession(session: JournalSession): void {
		this.activeSessionId = session.sessionId;
		this.mutate((state) => {
			state.sessions.push(session);
		});
	}

	/**
	 * Records a flushed temporary segment file of the active session.
	 * @param fileBaseName - Track identifier (RecordingTarget base name)
	 * @param segmentPath - Vault-relative segment file path
	 */
	addSegment(fileBaseName: string, segmentPath: string): void {
		this.mutateActiveSession((session) => {
			const track = session.tracks.find(
				(entry) => entry.fileBaseName === fileBaseName,
			);
			track?.segmentPaths.push(segmentPath);
		});
	}

	/**
	 * Records a finalized part file of the active session, together with
	 * the recorded length that is now safely on disk.
	 * @param fileBaseName - Track identifier (RecordingTarget base name)
	 * @param partPath - Vault-relative part file path
	 * @param recordedMs - Active milliseconds finalized so far, where the
	 *   caller keeps that clock; omitted on the PCM path, which splits by
	 *   byte count and never folds an active span at a part boundary
	 */
	addPart(fileBaseName: string, partPath: string, recordedMs?: number): void {
		this.mutateActiveSession((session) => {
			const track = session.tracks.find(
				(entry) => entry.fileBaseName === fileBaseName,
			);
			track?.partPaths.push(partPath);
			if (recordedMs !== undefined) {
				session.recordedMs = recordedMs;
			}
		});
	}

	/**
	 * Removes consumed segment files from the active session, across
	 * all of its tracks.
	 * @param segmentPaths - Segment paths that were deleted from disk
	 */
	removeSegments(segmentPaths: string[]): void {
		if (segmentPaths.length === 0) {
			return;
		}
		const removed = new Set(segmentPaths);
		this.mutateActiveSession((session) => {
			for (const track of session.tracks) {
				track.segmentPaths = track.segmentPaths.filter(
					(path) => !removed.has(path),
				);
			}
		});
	}

	/**
	 * Ends the active session, removing it from the journal. The
	 * journal file disappears once no sessions remain.
	 */
	endSession(): void {
		const endedId = this.activeSessionId;
		this.activeSessionId = null;
		if (!endedId) {
			return;
		}
		this.mutate((state) => {
			state.sessions = state.sessions.filter(
				(session) => session.sessionId !== endedId,
			);
		});
	}

	/**
	 * Replaces the non-active sessions of the journal. Used by the
	 * recovery flow to persist pruned, recovered, or discarded
	 * sessions; a session that started recording meanwhile is kept.
	 * @param sessions - Remaining non-active sessions
	 */
	async replaceSessions(sessions: JournalSession[]): Promise<void> {
		this.mutate((state) => {
			const active = state.sessions.find(
				(session) => session.sessionId === this.activeSessionId,
			);
			state.sessions = active
				? [
						...sessions.filter(
							(session) => session.sessionId !== active.sessionId,
						),
						active,
					]
				: [...sessions];
		});
		await this.flush();
	}

	/**
	 * Waits until every queued journal operation (including the
	 * coalesced write) has settled.
	 */
	async flush(): Promise<void> {
		// Operations enqueue follow-up writes while running, so the
		// chain may grow while it is being awaited
		let tail: Promise<void>;
		do {
			tail = this.opChain;
			await tail;
		} while (tail !== this.opChain);
	}

	/**
	 * Enqueues a state mutation followed by a coalesced write.
	 * @param change - Mutation applied to the loaded journal state
	 */
	private mutate(change: (state: JournalFile) => void): void {
		if (!this.journalPath) {
			return;
		}
		this.enqueue(async () => {
			await this.ensureLoaded();
			if (!this.state) {
				return;
			}
			change(this.state);
			this.dirty = true;
			this.scheduleWrite();
		});
	}

	/**
	 * Enqueues a mutation of the active session, if any.
	 * @param change - Mutation applied to the active session entry
	 */
	private mutateActiveSession(
		change: (session: JournalSession) => void,
	): void {
		this.mutate((state) => {
			const session = state.sessions.find(
				(entry) => entry.sessionId === this.activeSessionId,
			);
			if (session) {
				change(session);
			}
		});
	}

	/**
	 * Appends an operation to the serialized chain, containing its
	 * failure: the journal is best-effort and must never break the
	 * recording pipeline.
	 * @param operation - Operation to serialize
	 */
	private enqueue(operation: () => Promise<void>): void {
		this.opChain = this.opChain.then(operation).catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Recording journal operation failed:`,
				error,
			);
		});
	}

	/**
	 * Queues exactly one coalesced write behind the already-queued
	 * mutations: consecutive synchronous mutations share a single
	 * write instead of rewriting the file per call.
	 */
	private scheduleWrite(): void {
		if (this.writeScheduled) {
			return;
		}
		this.writeScheduled = true;
		this.enqueue(async () => {
			this.writeScheduled = false;
			await this.persist();
		});
	}

	/**
	 * Loads the journal into memory once. A missing, corrupt, or
	 * unreadable file starts from an empty journal - for mutations the
	 * recording data matters more than preserving unreadable history.
	 */
	private async ensureLoaded(): Promise<void> {
		if (this.state || !this.journalPath) {
			return;
		}
		try {
			if (!(await this.app.vault.adapter.exists(this.journalPath))) {
				this.state = { version: JOURNAL_VERSION, sessions: [] };
				return;
			}
			const raw = await this.app.vault.adapter.read(this.journalPath);
			const parsed: unknown = JSON.parse(raw);
			this.state = isValidJournal(parsed)
				? parsed
				: { version: JOURNAL_VERSION, sessions: [] };
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to load the recording journal; starting empty:`,
				error,
			);
			this.state = { version: JOURNAL_VERSION, sessions: [] };
		}
	}

	/**
	 * Writes the in-memory state to disk. An empty journal removes the
	 * file (falling back to writing an empty journal when the removal
	 * fails, so a stale journal never triggers a bogus recovery).
	 */
	private async persist(): Promise<void> {
		if (!this.journalPath || !this.state || !this.dirty) {
			return;
		}
		this.dirty = false;
		const path = this.journalPath;
		if (this.state.sessions.length === 0) {
			try {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
				return;
			} catch (removeError) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to remove the empty recording journal:`,
					removeError,
				);
				// Fall through to writing the empty journal instead
			}
		}
		await this.app.vault.adapter.write(path, JSON.stringify(this.state));
	}
}
