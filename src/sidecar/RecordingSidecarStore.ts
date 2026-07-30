/**
 * Persistence for the per-recording sidecar document: player markers plus the
 * transcript section (speaker roster, written outputs, rename history). One
 * store instance owns every sidecar file, caches whole documents per path,
 * and serializes all mutations through a single promise chain, so a marker
 * edit and a transcript write can never interleave and clobber each other -
 * each write persists the entire document from the cache. Reads hand out
 * snapshots, never the cached objects, so no caller can alias the cache.
 * Rename and delete of the recording are mirrored onto the sidecar (with the
 * cache re-adopted inside the write chain, so a mutation queued before the
 * rename can never fork the document), renames of written outputs update the
 * recorded paths, and an unreadable sidecar blocks writes instead of being
 * silently overwritten with an empty document.
 * @module sidecar/RecordingSidecarStore
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { PlayerMarker } from '../markers/markerModel';
import { serializeMarkers } from '../markers/markerModel';
import { mergeParticipantNames } from '../speakers/participantRoster';
import { TRANSCRIPT_FILE_FORMATS } from '../transcription/TranscriptTypes';
import {
	cloneSpeakerEntry,
	cloneTranscriptSection,
	emptyRecordingSidecar,
	isSidecarEmpty,
	parseRecordingSidecar,
	serializeRecordingSidecar,
	SIDECAR_HISTORY_LIMIT,
	type FileOutput,
	type NoteOutput,
	type ParticipantUpdate,
	type RecordingSidecar,
	type SpeakerEntry,
	type TranscriptProvenance,
	type TranscriptSection,
} from './recordingSidecarModel';

/** Suffix appended to a recording's path to form its sidecar path. */
const SIDECAR_SUFFIX = '.markers.json';

/**
 * File extensions a recorded output can have: notes plus the transcript file
 * formats. Renames of any other file can never touch a recorded path, so the
 * output-rename hook skips them without scanning anything.
 */
const RECORDABLE_OUTPUT_EXTENSIONS = new Set<string>([
	'md',
	...TRANSCRIPT_FILE_FORMATS,
]);

/** Whether a vault path could be a recorded transcript output. */
function isRecordableOutputPath(path: string): boolean {
	const dot = path.lastIndexOf('.');
	return (
		dot >= 0 &&
		RECORDABLE_OUTPUT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
	);
}

/**
 * Loads and saves per-recording sidecar documents (markers + transcript).
 */
export class RecordingSidecarStore {
	private readonly cache = new Map<string, RecordingSidecar>();
	/**
	 * Recording paths whose sidecar file exists but could not be read. While
	 * flagged, reads retry the file on every access (nothing is cached) and
	 * mutations reject instead of persisting, so the possibly intact file is
	 * never overwritten with a document derived from the empty fallback - the
	 * same protection the settings loader applies to an unreadable data.json.
	 * Invariant: a path with a cached document is never flagged (a stray flag
	 * next to valid cached data would silently drop every write forever).
	 */
	private readonly corruptPaths = new Set<string>();
	/** Serializes mutations so concurrent saves never interleave. */
	private writeChain: Promise<void> = Promise.resolve();

	/**
	 * @param app - Obsidian App instance
	 */
	constructor(private readonly app: App) {}

	/**
	 * Returns a snapshot of the markers stored for a recording path, or an
	 * empty array when none exist. Results are cached after the first read.
	 * @param path - Vault-relative recording path
	 */
	async getMarkers(path: string): Promise<PlayerMarker[]> {
		return serializeMarkers((await this.load(path)).markers);
	}

	/**
	 * Replaces the markers for a recording and persists the whole document,
	 * leaving the transcript section untouched.
	 * @param path - Vault-relative recording path
	 * @param markers - Markers to store
	 */
	async setMarkers(
		path: string,
		markers: readonly PlayerMarker[],
	): Promise<void> {
		const serialized = serializeMarkers(markers);
		return this.mutate(path, (sidecar) => {
			sidecar.markers = serialized;
		});
	}

	/**
	 * Applies an atomic read-modify-write to a recording's markers inside the
	 * write chain, so two concurrent updates can never merge against the same
	 * stale base and lose each other (the get-merge-set pattern would).
	 * @param path - Vault-relative recording path
	 * @param update - Pure update over the current markers
	 * @returns A snapshot of the markers after the update; rejects when the
	 *   write was refused (corrupt sidecar), so a caller can never mistake a
	 *   dropped update for an empty marker list
	 */
	async updateMarkers(
		path: string,
		update: (markers: PlayerMarker[]) => readonly PlayerMarker[],
	): Promise<PlayerMarker[]> {
		let result: PlayerMarker[] = [];
		await this.mutate(path, (sidecar) => {
			result = serializeMarkers(
				update(serializeMarkers(sidecar.markers)),
			);
			sidecar.markers = result;
		});
		return serializeMarkers(result);
	}

	/**
	 * Returns a snapshot of the transcript section stored for a recording
	 * path (empty when none exists). The snapshot stays stable while the
	 * store keeps mutating; write through the store's mutators.
	 * @param path - Vault-relative recording path
	 */
	async getTranscript(path: string): Promise<TranscriptSection> {
		return cloneTranscriptSection((await this.load(path)).transcript);
	}

	/**
	 * Whether the last read of this recording's sidecar found a file that
	 * exists but could not be read (I/O error or invalid JSON). Callers can
	 * then distinguish "nothing stored" from "stored data unreachable".
	 * Current only after a read - call getMarkers/getTranscript first.
	 * @param path - Vault-relative recording path
	 */
	isSidecarCorrupt(path: string): boolean {
		return this.corruptPaths.has(path);
	}

	/**
	 * Replaces the speaker roster: the given entries become the head of the
	 * roster in their order (each replacing any stored entry with the same
	 * label, name included or removed as given), while stored entries whose
	 * labels are not mentioned are kept after them - a label that vanished
	 * from the last transcription keeps its assigned name for the future.
	 *
	 * A participant update is applied in the SAME mutation, so a transcription
	 * that carries a profile's names into the recording persists the roster
	 * and the names it was assigned from in one write.
	 * @param path - Vault-relative recording path
	 * @param entries - New roster in first-seen order
	 * @param participants - Names to merge into the recording's roster, and the
	 *   profile they came from; omitted leaves the participants untouched
	 */
	async setSpeakers(
		path: string,
		entries: readonly SpeakerEntry[],
		participants?: ParticipantUpdate,
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			replaceSpeakers(sidecar, entries);
			applyParticipants(sidecar, participants);
		});
	}

	/**
	 * Commits an applied rename atomically: the new roster, its history entry,
	 * and any participant names the rename introduced are written in one
	 * mutation, so a failure can never persist the roster without the history
	 * entry (which would corrupt the undo baseline) or vice versa.
	 * @param path - Vault-relative recording path
	 * @param entries - New roster in first-seen order
	 * @param names - Full label-to-name assignment after the apply
	 * @param participants - Names to merge into the recording's roster, and the
	 *   profile they came from; omitted leaves the participants untouched
	 */
	async commitRename(
		path: string,
		entries: readonly SpeakerEntry[],
		names: Record<string, string>,
		participants?: ParticipantUpdate,
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			replaceSpeakers(sidecar, entries);
			applyParticipants(sidecar, participants);
			sidecar.transcript.history = [
				...sidecar.transcript.history,
				{ at: new Date().toISOString(), names: { ...names } },
			].slice(-SIDECAR_HISTORY_LIMIT);
		});
	}

	/**
	 * Records (or updates, keyed by the note path) one note output of a
	 * transcription run.
	 * @param path - Vault-relative recording path
	 * @param output - The written note output
	 */
	async recordNoteOutput(path: string, output: NoteOutput): Promise<void> {
		return this.mutate(path, (sidecar) => {
			sidecar.transcript.noteOutputs = upsertByPath(
				sidecar.transcript.noteOutputs,
				{ ...output, templates: { ...output.templates } },
			);
		});
	}

	/**
	 * Records (or updates, keyed by the file path) one transcript file output
	 * of a transcription run.
	 * @param path - Vault-relative recording path
	 * @param output - The written file output
	 */
	async recordFileOutput(path: string, output: FileOutput): Promise<void> {
		return this.mutate(path, (sidecar) => {
			sidecar.transcript.fileOutputs = upsertByPath(
				sidecar.transcript.fileOutputs,
				{ ...output },
			);
		});
	}

	/**
	 * Records the provenance of the run that last wrote outputs.
	 * @param path - Vault-relative recording path
	 * @param provenance - Language/engine/timestamp of the run
	 */
	async recordProvenance(
		path: string,
		provenance: TranscriptProvenance,
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			sidecar.transcript.provenance = { ...provenance };
		});
	}

	/**
	 * Removes the newest rename-history entry (an undo consumed it). A no-op
	 * on an empty history.
	 * @param path - Vault-relative recording path
	 */
	async popHistory(path: string): Promise<void> {
		return this.mutate(path, (sidecar) => {
			if (sidecar.transcript.history.length === 0) {
				return false;
			}
			sidecar.transcript.history = sidecar.transcript.history.slice(
				0,
				-1,
			);
			return true;
		});
	}

	/**
	 * Moves a recording's sidecar to follow a rename/move, so its markers and
	 * transcript data stay attached instead of orphaning. The cache entry is
	 * moved twice: synchronously, so readers see the document under its new
	 * path at once, and again inside the queued task, adopting any state a
	 * mutation queued before this rename re-established under the old path -
	 * without that, the new path would keep serving a pre-mutation snapshot.
	 * @param oldPath - Previous recording path
	 * @param newPath - New recording path
	 */
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		this.moveCacheEntry(oldPath, newPath);
		return this.enqueue(async () => {
			const from = this.sidecarPath(oldPath);
			const to = this.sidecarPath(newPath);
			try {
				if (await this.app.vault.adapter.exists(from)) {
					await this.app.vault.adapter.rename(from, to);
				}
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to move sidecar ${oldPath} -> ${newPath}:`,
					error,
				);
			}
			// A mutation queued before this task re-read the old path and
			// re-cached (and updated) the document there; its write also
			// preceded the rename above, so the moved file carries it. Adopt
			// that newest state so the new path never serves a stale copy and
			// no zombie entry lingers under the old path.
			this.moveCacheEntry(oldPath, newPath);
		});
	}

	/**
	 * Removes a recording's sidecar when the recording is deleted, so no
	 * orphan sidecar is left behind. The cache is evicted twice: synchronously
	 * for immediate readers, and again inside the queued task, purging any
	 * entry a mutation queued before this delete re-established - without
	 * that, a recording re-created at this path would resurrect the dead
	 * document.
	 * @param path - Deleted recording path
	 */
	async handleDelete(path: string): Promise<void> {
		this.cache.delete(path);
		this.corruptPaths.delete(path);
		return this.enqueue(async () => {
			const sidecar = this.sidecarPath(path);
			try {
				if (await this.app.vault.adapter.exists(sidecar)) {
					await this.app.vault.adapter.remove(sidecar);
				}
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to delete sidecar for ${path}:`,
					error,
				);
			}
			// Purge both again: a mutation queued before this delete may have
			// re-established either (the corrupt flag included - its load of
			// the now-deleted path can have failed and re-flagged it).
			this.cache.delete(path);
			this.corruptPaths.delete(path);
		});
	}

	/**
	 * Follows a rename/move of a written transcript output (a note or a
	 * transcript file): every recording sidecar that records the old path is
	 * updated to the new one, so speaker renaming keeps reaching the moved
	 * output instead of skipping it as missing forever. Sidecar files
	 * themselves are ignored (they follow their recording, not this hook).
	 * @param oldPath - Previous output path
	 * @param newPath - New output path
	 */
	async handleOutputRename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath.endsWith(SIDECAR_SUFFIX)) {
			return;
		}
		// Only notes and transcript files can ever be recorded outputs; a
		// rename of anything else (image, PDF, ...) can be skipped without
		// scanning a single sidecar.
		if (
			!isRecordableOutputPath(oldPath) &&
			!isRecordableOutputPath(newPath)
		) {
			return;
		}
		for (const recording of await this.recordingsReferencing(oldPath)) {
			try {
				await this.mutate(recording, (sidecar) => {
					const notes = renameOutputPath(
						sidecar.transcript.noteOutputs,
						oldPath,
						newPath,
					);
					const files = renameOutputPath(
						sidecar.transcript.fileOutputs,
						oldPath,
						newPath,
					);
					if (!notes && !files) {
						return false;
					}
					if (notes) {
						sidecar.transcript.noteOutputs = notes;
					}
					if (files) {
						sidecar.transcript.fileOutputs = files;
					}
					return true;
				});
			} catch (error) {
				// Path maintenance is best-effort: one corrupt sidecar must
				// not stop the rename from reaching the other recordings.
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to update the recorded output path in the sidecar of ${recording}:`,
					error,
				);
			}
		}
	}

	/**
	 * Drops the in-memory cache so later reads re-read from disk. Used when
	 * the feature is torn down.
	 */
	clearCache(): void {
		this.cache.clear();
		this.corruptPaths.clear();
	}

	/**
	 * Finds the recordings whose sidecar (cached or on disk) records the
	 * given output path. On-disk candidates are read through {@link load}, so
	 * each sidecar is parsed and cached at most once - later scans check the
	 * cache only and never touch the disk again.
	 * @param outputPath - Output path to search for
	 */
	private async recordingsReferencing(outputPath: string): Promise<string[]> {
		const hits = new Set<string>();
		const references = (doc: RecordingSidecar): boolean =>
			doc.transcript.noteOutputs.some((o) => o.path === outputPath) ||
			doc.transcript.fileOutputs.some((o) => o.path === outputPath);
		for (const [recording, doc] of this.cache) {
			if (references(doc)) {
				hits.add(recording);
			}
		}
		// Whether a sidecar records this output cannot be known without reading
		// it, so every not-yet-cached one is read - but concurrently rather than
		// one await at a time, which turned a rename in a vault with hundreds of
		// recordings into hundreds of serialized disk round-trips. load() caches
		// and is race-safe, so this costs one read per sidecar per session; a
		// later rename finds them all cached and touches the disk not at all.
		const uncached = this.app.vault
			.getFiles()
			.filter((file) => file.path.endsWith(SIDECAR_SUFFIX))
			.map((file) => file.path.slice(0, -SIDECAR_SUFFIX.length))
			.filter((recording) => !this.cache.has(recording));
		const loaded = await Promise.all(
			uncached.map(async (recording) => ({
				recording,
				doc: await this.load(recording),
			})),
		);
		for (const { recording, doc } of loaded) {
			if (references(doc)) {
				hits.add(recording);
			}
		}
		return [...hits];
	}

	/**
	 * Moves the cache entry (and the corrupt flag) from one recording path to
	 * another, keeping whichever document is newest under the old path. The
	 * invariant "a cached document is never flagged corrupt" is preserved: a
	 * document moved into place is authoritative for its new path, and the
	 * flag is only carried over when the new path holds no document (a stray
	 * flag next to a valid cache entry would silently drop every write).
	 */
	private moveCacheEntry(oldPath: string, newPath: string): void {
		const cached = this.cache.get(oldPath);
		this.cache.delete(oldPath);
		const wasCorrupt = this.corruptPaths.delete(oldPath);
		if (cached) {
			this.cache.set(newPath, cached);
			this.corruptPaths.delete(newPath);
		} else if (wasCorrupt && !this.cache.has(newPath)) {
			this.corruptPaths.add(newPath);
		}
	}

	/**
	 * Resolves the sidecar path for a recording.
	 * @param path - Vault-relative recording path
	 */
	private sidecarPath(path: string): string {
		return `${path}${SIDECAR_SUFFIX}`;
	}

	/**
	 * Returns the cached document for a path, reading and parsing it on the
	 * first access. A missing file maps to an empty document. A file that
	 * exists but cannot be read maps to an empty document too, but is NOT
	 * cached and flags the path corrupt, so every later access retries the
	 * read and mutations refuse to overwrite the possibly intact file.
	 * @param path - Vault-relative recording path
	 */
	private async load(path: string): Promise<RecordingSidecar> {
		const cached = this.cache.get(path);
		if (cached) {
			// A cached document is authoritative, so any corrupt flag next to
			// it is stale (e.g. left by a read that lost a race against a
			// successful one) and must not keep dropping writes.
			this.corruptPaths.delete(path);
			return cached;
		}
		const file = this.sidecarPath(path);
		let sidecar = emptyRecordingSidecar();
		try {
			if (await this.app.vault.adapter.exists(file)) {
				const raw = await this.app.vault.adapter.read(file);
				sidecar = parseRecordingSidecar(JSON.parse(raw));
			}
		} catch (error) {
			// A concurrent load may have read the file successfully while
			// this one failed (reads are not serialized on the write chain);
			// its cached document wins and the path must not be flagged, or
			// every later write would be dropped despite valid cached data.
			const raced = this.cache.get(path);
			if (raced) {
				return raced;
			}
			console.warn(
				`${PLUGIN_LOG_PREFIX} Sidecar for ${path} exists but could not be read; treating as empty and protecting the file from writes:`,
				error,
			);
			this.corruptPaths.add(path);
			return emptyRecordingSidecar();
		}
		this.corruptPaths.delete(path);
		// A concurrent load may have cached the document first; keep the
		// existing instance so queued mutations and readers share one object.
		const raced = this.cache.get(path);
		if (raced) {
			return raced;
		}
		this.cache.set(path, sidecar);
		return sidecar;
	}

	/**
	 * Runs one mutation against the cached document and persists the whole
	 * document, serialized behind any in-flight write. Load, mutation, and
	 * write all happen inside the chain so two concurrent mutations of
	 * different sections can never lose each other's change. A mutation
	 * returning false is a no-op and skips the write. While the sidecar is
	 * flagged corrupt the change is refused and the returned promise
	 * rejects: the mutation did not happen, and pretending otherwise would
	 * let callers present unsaved state as saved. (A failed disk write after
	 * a successful mutation only warns - the cache did change, so reads stay
	 * consistent and the next write retries the file.)
	 * @param path - Vault-relative recording path
	 * @param change - Mutation applied to the cached document; return false
	 *   to signal nothing changed
	 */
	private async mutate(
		path: string,
		change: (sidecar: RecordingSidecar) => void | boolean,
	): Promise<void> {
		let blocked = false;
		await this.enqueue(async () => {
			const sidecar = await this.load(path);
			if (this.corruptPaths.has(path)) {
				blocked = true;
				return;
			}
			if (change(sidecar) === false) {
				return;
			}
			const file = this.sidecarPath(path);
			try {
				if (isSidecarEmpty(sidecar)) {
					if (await this.app.vault.adapter.exists(file)) {
						await this.app.vault.adapter.remove(file);
					}
					return;
				}
				await this.app.vault.adapter.write(
					file,
					JSON.stringify(serializeRecordingSidecar(sidecar)),
				);
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to write sidecar for ${path}:`,
					error,
				);
			}
		});
		// Thrown outside the queued task, so the write chain itself stays
		// alive while the caller receives the rejection.
		if (blocked) {
			throw new Error(
				`The sidecar file ${this.sidecarPath(path)} exists but could not be read; ` +
					'writes to it are paused so the stored data is not overwritten. ' +
					'Restore or remove the file to resume.',
			);
		}
	}

	/**
	 * Queues a task behind any in-flight write so concurrent saves never
	 * interleave. A task failure is contained so the chain stays usable.
	 * @param task - Async task to run
	 */
	private enqueue(task: () => Promise<void>): Promise<void> {
		this.writeChain = this.writeChain.then(task).catch((error: unknown) => {
			console.warn(`${PLUGIN_LOG_PREFIX} Sidecar write failed:`, error);
		});
		return this.writeChain;
	}
}

/**
 * Replaces the roster inside a sidecar document: the given entries become the
 * head of the roster in their order (each replacing any stored entry with the
 * same label, name included or removed as given), while stored entries whose
 * labels are not mentioned are kept after them - a label that vanished from
 * the last transcription keeps its assigned name for the future.
 */
function replaceSpeakers(
	sidecar: RecordingSidecar,
	entries: readonly SpeakerEntry[],
): void {
	const mentioned = new Set(entries.map((entry) => entry.label));
	const kept = sidecar.transcript.speakers.filter(
		(entry) => !mentioned.has(entry.label),
	);
	sidecar.transcript.speakers = [...entries.map(cloneSpeakerEntry), ...kept];
}

/**
 * Merges a participant update into a sidecar document: names are added to the
 * recording's roster (existing ones keep their order) and the originating
 * profile id is recorded so the rename dialog can re-select it. Names are only
 * ever added: a recording accumulates everyone who has been named in it, so
 * switching profiles between runs never loses the names of an earlier one.
 * A blank profile id clears the hint rather than storing an empty key.
 */
function applyParticipants(
	sidecar: RecordingSidecar,
	update: ParticipantUpdate | undefined,
): void {
	if (!update) {
		return;
	}
	sidecar.transcript.participants = mergeParticipantNames(
		sidecar.transcript.participants,
		update.names,
	);
	if (update.profileId) {
		sidecar.transcript.participantProfileId = update.profileId;
	} else {
		delete sidecar.transcript.participantProfileId;
	}
}

/** Replaces the entry with the same path, or appends when absent. */
function upsertByPath<T extends { path: string }>(
	list: readonly T[],
	entry: T,
): T[] {
	const index = list.findIndex((existing) => existing.path === entry.path);
	if (index < 0) {
		return [...list, entry];
	}
	const next = [...list];
	next[index] = entry;
	return next;
}

/**
 * Renames an output path inside a recorded list, or returns null when the
 * list does not record the old path. When the new path is already recorded
 * (the outputs were merged externally), the stale entry is dropped instead
 * of duplicating the path.
 */
function renameOutputPath<T extends { path: string }>(
	list: readonly T[],
	oldPath: string,
	newPath: string,
): T[] | null {
	if (!list.some((entry) => entry.path === oldPath)) {
		return null;
	}
	if (list.some((entry) => entry.path === newPath)) {
		return list.filter((entry) => entry.path !== oldPath);
	}
	return list.map((entry) =>
		entry.path === oldPath ? { ...entry, path: newPath } : entry,
	);
}
