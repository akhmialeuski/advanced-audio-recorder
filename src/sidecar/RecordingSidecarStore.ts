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
 *
 * A sidecar is an ordinary file in the vault, so every operation on it goes
 * through the Vault and FileManager API rather than the raw adapter: the
 * vault index, the other plugins listening to vault events and the user's
 * "Deleted files" preference all see it the way they see any other file. A
 * deleted recording's sidecar therefore goes to the same trash as the
 * recording, and restoring both brings the markers and transcript data back.
 * @module sidecar/RecordingSidecarStore
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { PlayerMarker } from '../markers/markerModel';
import type { PartFailure } from '../transcription/partFailure';
import { serializeMarkers } from '../markers/markerModel';
import { mergeParticipantNames } from '../speakers/participantRoster';
import { TranscriptFileFormat } from '../transcription/TranscriptTypes';
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
	type FailedPartsSection,
	type PlaybackState,
	type RecordingSidecar,
	type SpeakerEntry,
	type TranscriptProvenance,
	type TranscriptSection,
} from './recordingSidecarModel';

/** Suffix appended to a recording's path to form its sidecar path. */
export const SIDECAR_SUFFIX = '.markers.json';

/**
 * Where a sidecar file stands when it exists on disk but the vault index does
 * not list it. Obsidian builds its index while plugins load (it fires `create`
 * for every existing file during that scan), so a read or a write early in
 * startup can ask for a file the index has not reached yet. Taking such a
 * file for absent would hide its markers, and let the next write replace it
 * with a document built from nothing, so reads and writes reach it through
 * the adapter instead - the only API that can.
 */
const UNINDEXED = Symbol('unindexed');

/** A sidecar file as {@link RecordingSidecarStore} finds it, or null when absent. */
type LocatedSidecar = TFile | typeof UNINDEXED | null;

/**
 * How many times one mutation is applied before the store gives up on a
 * sidecar file that keeps appearing under it. The second attempt reads the
 * file that appeared, so it only fails again when that file vanished and
 * another took its place in between; a third would be chasing a sync loop.
 */
const MAX_WRITE_ATTEMPTS = 2;

/**
 * File extensions a recorded output can have: notes plus the transcript file
 * formats. Renames of any other file can never touch a recorded path, so the
 * output-rename hook skips them without scanning anything.
 */
const RECORDABLE_OUTPUT_EXTENSIONS = new Set<string>([
	'md',
	...Object.values(TranscriptFileFormat),
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
	/**
	 * Cached documents that no file stands behind: read as absent, or left
	 * behind when the store removed their emptied file. Before such a
	 * document is written the store makes sure no file has appeared at its
	 * path in the meantime - typically sync delivering the sidecar of a
	 * recording that arrived a moment earlier. If one has, the change is
	 * applied to that file's document instead of replacing it with one built
	 * from nothing, which would erase markers made on another device. Tracked
	 * per document rather than per path, so the mark travels with a document
	 * through a rename and is dropped with it on eviction.
	 */
	private readonly unbacked = new WeakSet<RecordingSidecar>();
	/** Serializes mutations so concurrent saves never interleave. */
	private writeChain: Promise<void> = Promise.resolve();
	/** Readers told which recording's document just changed. */
	private readonly listeners = new Set<(path: string) => void>();
	/**
	 * Sidecar moves still queued, by the recording path they move to. A read
	 * of that path waits for its move: the document is not on disk there yet,
	 * and caching the empty answer would let the next write replace the moved
	 * document with it.
	 */
	private readonly pendingMoves = new Map<string, Promise<void>>();

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
		return serializeMarkers((await this.loadAfterMoves(path)).markers);
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
	 * Returns the parts the last run could not transcribe, or null when it
	 * came back whole (or nothing has been transcribed yet).
	 * @param path - Vault-relative recording path
	 */
	async getFailedParts(path: string): Promise<FailedPartsSection | null> {
		const stored = (await this.loadAfterMoves(path)).failedParts;
		return stored
			? {
					recordedAt: stored.recordedAt,
					parts: stored.parts.map((part) => ({ ...part })),
				}
			: null;
	}

	/**
	 * Records what a run could not transcribe, or clears the record when it
	 * came back whole. Every run writes this, so an absent record always
	 * means "nothing is missing" and never "nobody looked".
	 * @param path - Vault-relative recording path
	 * @param parts - The parts that failed; an empty list clears the record
	 */
	async setFailedParts(
		path: string,
		parts: readonly PartFailure[],
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			if (parts.length === 0) {
				if (!sidecar.failedParts) {
					return false;
				}
				delete sidecar.failedParts;
				return true;
			}
			sidecar.failedParts = {
				parts: parts.map((part) => ({ ...part })),
				recordedAt: new Date().toISOString(),
			};
			return true;
		});
	}

	/**
	 * Returns the remembered playback position for a recording, or null when
	 * none is stored.
	 * @param path - Vault-relative recording path
	 */
	async getPlayback(path: string): Promise<PlaybackState | null> {
		const stored = (await this.loadAfterMoves(path)).playback;
		return stored ? { ...stored } : null;
	}

	/**
	 * Stores or clears the remembered playback position. Writing the position
	 * the document already holds is skipped, so the repeated saves a pause
	 * produces do not each rewrite the file.
	 * @param path - Vault-relative recording path
	 * @param state - Position to remember, or null to forget it
	 */
	async setPlayback(
		path: string,
		state: PlaybackState | null,
	): Promise<void> {
		// Written on every pause, and shown by no reader that listens, so it
		// is not announced: a reader would re-read the document for nothing.
		return this.mutate(
			path,
			(sidecar) => {
				if (!state) {
					if (!sidecar.playback) {
						return false;
					}
					delete sidecar.playback;
					return true;
				}
				if (sidecar.playback?.position === state.position) {
					return false;
				}
				sidecar.playback = { ...state };
				return true;
			},
			false,
		);
	}

	/**
	 * Returns a snapshot of the transcript section stored for a recording
	 * path (empty when none exists). The snapshot stays stable while the
	 * store keeps mutating; write through the store's mutators.
	 * @param path - Vault-relative recording path
	 */
	async getTranscript(path: string): Promise<TranscriptSection> {
		return cloneTranscriptSection(
			(await this.loadAfterMoves(path)).transcript,
		);
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
	 * Appends speakers to the end of the roster inside one mutation, leaving
	 * every stored entry as it is. A speaker created after the transcription
	 * (a transcript line split off to a new speaker) thereby joins the roster
	 * without writing back the rest of it as the caller last read it, which
	 * would undo a name assigned since. An entry whose label is already
	 * stored is skipped rather than replacing that speaker.
	 * @param path - Vault-relative recording path
	 * @param entries - Speakers to append, in order
	 */
	async addSpeakers(
		path: string,
		entries: readonly SpeakerEntry[],
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			const stored = new Set(
				sidecar.transcript.speakers.map((entry) => entry.label),
			);
			const added = entries.filter((entry) => !stored.has(entry.label));
			if (added.length === 0) {
				return false;
			}
			sidecar.transcript.speakers = [
				...sidecar.transcript.speakers,
				...added.map(cloneSpeakerEntry),
			];
			return true;
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
	 *
	 * The file is moved with `Vault.rename`, not `FileManager.renameFile`:
	 * the latter exists to rewrite the links pointing at a file, and nothing
	 * links to a sidecar - the notes link to the recording, whose own rename
	 * already updated them - so it would only scan the link graph for
	 * nothing. The rename event the vault fires for the sidecar reaches the
	 * output-rename hook, which ignores sidecar paths.
	 * @param oldPath - Previous recording path
	 * @param newPath - New recording path
	 */
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		this.moveCacheEntry(oldPath, newPath);
		const carried = this.cache.get(newPath);
		const moved = this.enqueue(async () => {
			try {
				await this.moveSidecarFile(
					this.sidecarPath(oldPath),
					this.sidecarPath(newPath),
				);
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
			// no zombie entry lingers under the old path. A document cached
			// under the new path that is not the one carried over was read
			// while the file was still on its way - as absent, or as the
			// orphan the move just replaced - so it is dropped too, and the
			// next read sees the file that is there now.
			if (
				this.cache.has(oldPath) ||
				this.corruptPaths.has(oldPath) ||
				this.cache.get(newPath) !== carried
			) {
				this.moveCacheEntry(oldPath, newPath);
			}
			// Only this move's own entry: a later move to the same path may
			// have replaced it, and that one is still to run.
			if (this.pendingMoves.get(newPath) === moved) {
				this.pendingMoves.delete(newPath);
			}
		});
		this.pendingMoves.set(newPath, moved);
		return moved;
	}

	/**
	 * Sends a recording's sidecar to the trash when the recording is deleted,
	 * so no orphan sidecar is left behind. `FileManager.trashFile` follows
	 * the user's "Deleted files" preference, exactly as the deletion of the
	 * recording itself did, so a recording restored from the system or the
	 * Obsidian trash can be restored together with its markers and
	 * transcript data instead of coming back without them. The cache is
	 * evicted twice: synchronously for immediate readers, and again inside
	 * the queued task, purging any entry a mutation queued before this
	 * delete re-established - without that, a recording re-created at this
	 * path would resurrect the dead document.
	 *
	 * Only a sidecar the vault index lists is trashed (see
	 * {@link moveSidecarFile} for why the adapter is not consulted here).
	 * @param path - Deleted recording path
	 */
	async handleDelete(path: string): Promise<void> {
		this.forget(path);
		return this.enqueue(async () => {
			const sidecar = this.app.vault.getFileByPath(
				this.sidecarPath(path),
			);
			try {
				if (sidecar) {
					await this.app.fileManager.trashFile(sidecar);
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
			this.forget(path);
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
	 * Subscribes to changes of any recording's document. The vault does
	 * raise events for the sidecar file, but under the sidecar's own path
	 * and only once the write has landed, so a reader that shows sidecar
	 * data - the recording panel - learns of a new transcript, a renamed
	 * speaker, or a new chapter from here, under the recording's path, as
	 * soon as the cached document changes. Renames and deletes of the
	 * recording itself are not announced: they are vault events, and a
	 * reader hears of them there. Neither is a playback position, which no
	 * reader shows.
	 * @param listener - Called with the recording path after each change
	 * @returns Unsubscribes the listener
	 */
	onChange(listener: (path: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Every recording in the vault that has a sidecar, with the document it
	 * holds. One pass over the vault's files, and each sidecar is parsed and
	 * cached at most once through {@link loadAfterMoves} - a later call finds them all
	 * cached and touches the disk not at all. The reads run concurrently
	 * rather than one await at a time, which is what keeps a vault with
	 * hundreds of recordings from paying hundreds of serialized round-trips.
	 *
	 * A sidecar that cannot be read yields an empty document and is flagged
	 * corrupt, exactly as a single read would, so one broken file never takes
	 * the scan down with it.
	 * @returns One entry per recording with a sidecar, in no particular order
	 */
	async allRecordings(): Promise<
		{ path: string; sidecar: RecordingSidecar }[]
	> {
		const recordings = this.app.vault
			.getFiles()
			.filter((file) => file.path.endsWith(SIDECAR_SUFFIX))
			.map((file) => file.path.slice(0, -SIDECAR_SUFFIX.length));
		return Promise.all(
			recordings.map(async (path) => ({
				path,
				sidecar: await this.loadAfterMoves(path),
			})),
		);
	}

	/**
	 * Finds the recordings whose sidecar (cached or on disk) records the
	 * given output path.
	 * @param outputPath - Output path to search for
	 */
	private async recordingsReferencing(outputPath: string): Promise<string[]> {
		const hits = new Set<string>();
		const references = (doc: RecordingSidecar): boolean =>
			doc.transcript.noteOutputs.some((o) => o.path === outputPath) ||
			doc.transcript.fileOutputs.some((o) => o.path === outputPath);
		// The cache is checked as well as the scan: a recording whose sidecar
		// has not been written yet lives only there, and has no file for
		// allRecordings to find.
		for (const [recording, doc] of this.cache) {
			if (references(doc)) {
				hits.add(recording);
			}
		}
		for (const { path, sidecar } of await this.allRecordings()) {
			if (references(sidecar)) {
				hits.add(path);
			}
		}
		return [...hits];
	}

	/**
	 * Hands the state held under one recording path - the cached document or
	 * the corrupt flag - over to another, replacing whatever the new path
	 * held. What was cached under the new path describes the file that used
	 * to live there, not the one the rename puts in its place, so it never
	 * survives the move. The invariant "a cached document is never flagged
	 * corrupt" is preserved, since at most one of the two is carried over (a
	 * stray flag next to a valid cache entry would silently drop every
	 * write).
	 */
	private moveCacheEntry(oldPath: string, newPath: string): void {
		const cached = this.cache.get(oldPath);
		const wasCorrupt = this.corruptPaths.has(oldPath);
		this.forget(oldPath);
		this.forget(newPath);
		if (cached) {
			this.cache.set(newPath, cached);
		} else if (wasCorrupt) {
			this.corruptPaths.add(newPath);
		}
	}

	/** Drops everything the store holds for a recording path. */
	private forget(path: string): void {
		this.cache.delete(path);
		this.corruptPaths.delete(path);
	}

	/**
	 * Moves a sidecar file to follow its recording.
	 *
	 * Only a file the vault index lists is moved. This runs in answer to a
	 * vault event about the recording, and the vault only fires those for
	 * files it has indexed, so a sidecar it does not list at that moment is
	 * one it has already carried along - a renamed or trashed folder moves
	 * its children and fires an event for each - or is about to. Moving it
	 * through the adapter as well would race the vault's own move, while
	 * leaving it alone loses nothing.
	 *
	 * A file already sitting at the destination cannot belong to the
	 * recording, which did not exist under that name until now: it is an
	 * orphan, left by a recording deleted outside Obsidian. It goes to the
	 * trash rather than blocking the move, so the recording keeps its own
	 * data and the orphan can still be recovered.
	 * @param from - Current sidecar path
	 * @param to - Sidecar path of the renamed recording
	 */
	private async moveSidecarFile(from: string, to: string): Promise<void> {
		const { vault } = this.app;
		const file = vault.getFileByPath(from);
		if (!file) {
			return;
		}
		const occupant = vault.getFileByPath(to);
		// The same file can answer for both paths on a case-insensitive
		// file system, when the rename only changed the case.
		if (occupant && occupant !== file) {
			await this.app.fileManager.trashFile(occupant);
		}
		await vault.rename(file, to);
	}

	/**
	 * Resolves the sidecar path for a recording.
	 * @param path - Vault-relative recording path
	 */
	private sidecarPath(path: string): string {
		return `${path}${SIDECAR_SUFFIX}`;
	}

	/**
	 * Returns the document for a reader outside the write chain, after any
	 * queued move of the sidecar to this path. Tasks inside the chain call
	 * {@link load} directly: the chain already runs them after every move
	 * queued before them, and one queued before a move must not wait on it.
	 * @param path - Vault-relative recording path
	 */
	private async loadAfterMoves(path: string): Promise<RecordingSidecar> {
		const move = this.pendingMoves.get(path);
		if (move && !this.cache.has(path)) {
			await move;
		}
		return this.load(path);
	}

	/**
	 * Finds a sidecar file: the vault's own file when the index lists it,
	 * {@link UNINDEXED} when only the disk has it, or null when there is none.
	 * The disk is asked only after the index came up empty, so a sidecar the
	 * vault knows costs no I/O to find.
	 * @param filePath - Vault-relative sidecar path
	 */
	private async locate(filePath: string): Promise<LocatedSidecar> {
		const file = this.app.vault.getFileByPath(filePath);
		if (file) {
			return file;
		}
		return (await this.app.vault.adapter.exists(filePath))
			? UNINDEXED
			: null;
	}

	/**
	 * Returns the cached document for a path, reading and parsing it on the
	 * first access. A missing file maps to an empty document, and so does a
	 * file that exists but cannot be read (see {@link tryLoad}).
	 * @param path - Vault-relative recording path
	 */
	private async load(path: string): Promise<RecordingSidecar> {
		return (await this.tryLoad(path)) ?? emptyRecordingSidecar();
	}

	/**
	 * Returns the cached document for a path, reading and parsing it on the
	 * first access. A missing file maps to an empty document. A file that
	 * exists but cannot be read maps to null, is NOT cached and flags the
	 * path corrupt, so every later access retries the read and mutations
	 * refuse to overwrite the possibly intact file. Answering null rather
	 * than leaving the caller to consult the flag keeps the verdict tied to
	 * this read: a concurrent load finishing in between cannot clear it.
	 * @param path - Vault-relative recording path
	 */
	private async tryLoad(path: string): Promise<RecordingSidecar | null> {
		const cached = this.cache.get(path);
		if (cached) {
			// A cached document is authoritative, so any corrupt flag next to
			// it is stale (e.g. left by a read that lost a race against a
			// successful one) and must not keep dropping writes.
			this.corruptPaths.delete(path);
			return cached;
		}
		return this.read(path, false);
	}

	/**
	 * Reads a sidecar file and caches its document.
	 *
	 * The text comes from `Vault.cachedRead`. The vault refreshes that cache
	 * whenever it learns of a change to the file - its own writes, and the
	 * modify events its watcher raises for an edit made by sync or another
	 * program - so the only content it can miss is a change the vault has
	 * not been told about yet, a window of milliseconds. `Vault.read` would
	 * close that window and nothing more: once read, the document is cached
	 * for the session and stays authoritative over the file, which is what
	 * lets queued mutations and readers share one object. A file that is
	 * unreadable mid-sync is flagged corrupt and re-read on every access, and
	 * by the time sync has finished writing it the vault has refreshed it.
	 * @param path - Vault-relative recording path
	 * @param replace - Whether the document read replaces one already cached
	 *   (a mutation re-reading a file that appeared under a document no file
	 *   stood behind), instead of yielding to it (a concurrent first load)
	 * @returns The document, or null when the file exists but cannot be read
	 */
	private async read(
		path: string,
		replace: boolean,
	): Promise<RecordingSidecar | null> {
		const filePath = this.sidecarPath(path);
		let sidecar = emptyRecordingSidecar();
		let backed = false;
		try {
			const located = await this.locate(filePath);
			if (located !== null) {
				const raw =
					located === UNINDEXED
						? await this.app.vault.adapter.read(filePath)
						: await this.app.vault.cachedRead(located);
				sidecar = parseRecordingSidecar(JSON.parse(raw));
				backed = true;
			}
		} catch (error) {
			// A concurrent load may have read the file successfully while
			// this one failed (reads are not serialized on the write chain);
			// its cached document wins and the path must not be flagged, or
			// every later write would be dropped despite valid cached data.
			const raced = this.cache.get(path);
			if (raced && !replace) {
				return raced;
			}
			console.warn(
				`${PLUGIN_LOG_PREFIX} Sidecar for ${path} exists but could not be read; treating as empty and protecting the file from writes:`,
				error,
			);
			// A replacing read drops the document it was meant to replace:
			// that one was built without the file, which now exists and has
			// to be protected like any other unreadable sidecar.
			this.cache.delete(path);
			this.corruptPaths.add(path);
			return null;
		}
		this.corruptPaths.delete(path);
		// A concurrent load may have cached the document first; keep the
		// existing instance so queued mutations and readers share one object.
		const raced = this.cache.get(path);
		if (raced && !replace) {
			return raced;
		}
		if (!backed) {
			this.unbacked.add(sidecar);
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
	 *
	 * When a file turns up under a document no file stood behind, nothing is
	 * written: the document is dropped, the file is read in its place, and
	 * the change is applied again to what the file holds. A change only reads
	 * and edits the document it is handed, so running it a second time on
	 * another document is safe, where writing the first one would not be.
	 * @param path - Vault-relative recording path
	 * @param change - Mutation applied to the cached document; return false
	 *   to signal nothing changed
	 * @param announce - Whether listeners hear of the change
	 */
	private async mutate(
		path: string,
		change: (sidecar: RecordingSidecar) => void | boolean,
		announce = true,
	): Promise<void> {
		let blocked = false;
		await this.enqueue(async () => {
			let changed = false;
			try {
				let sidecar = await this.tryLoad(path);
				for (let attempt = 1; sidecar; attempt++) {
					if (change(sidecar) === false) {
						return;
					}
					changed = true;
					try {
						if (await this.persist(path, sidecar)) {
							return;
						}
					} catch (error) {
						console.warn(
							`${PLUGIN_LOG_PREFIX} Failed to write sidecar for ${path}:`,
							error,
						);
						return;
					}
					if (attempt === MAX_WRITE_ATTEMPTS) {
						console.warn(
							`${PLUGIN_LOG_PREFIX} Gave up writing the sidecar for ${path}: a file kept appearing at its path while the store wrote it.`,
						);
						return;
					}
					sidecar = await this.read(path, true);
				}
				blocked = true;
			} finally {
				// Once, after the mutation settled on the document that stays
				// cached: an attempt that is retried changed a document the
				// retry throws away. Also after a failed disk write, because
				// reads answer from the cache, which did change.
				if (changed && announce) {
					this.notify(path);
				}
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
	 * Tells every listener a recording's document changed. A listener that
	 * throws is logged and skipped, so one broken reader can neither fail the
	 * mutation nor keep the others from hearing of it.
	 * @param path - Vault-relative recording path
	 */
	private notify(path: string): void {
		for (const listener of this.listeners) {
			try {
				listener(path);
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} A sidecar change listener failed:`,
					error,
				);
			}
		}
	}

	/**
	 * Puts a document on disk, or removes its file once the document holds
	 * nothing worth keeping.
	 * @param path - Vault-relative recording path
	 * @param sidecar - The cached document to persist
	 * @returns false when a file turned up at the sidecar path while no file
	 *   stood behind the document: nothing was written, and the caller has
	 *   to read that file before writing anything over it
	 */
	private async persist(
		path: string,
		sidecar: RecordingSidecar,
	): Promise<boolean> {
		const filePath = this.sidecarPath(path);
		if (isSidecarEmpty(sidecar)) {
			return this.removeFile(filePath, sidecar);
		}
		return this.writeFile(
			filePath,
			sidecar,
			JSON.stringify(serializeRecordingSidecar(sidecar)),
		);
	}

	/**
	 * Writes a document through the vault: `Vault.modify` for a file the
	 * vault lists, `Vault.create` for a new one. A read-modify-write through
	 * `Vault.process` would not fit, because the base of every mutation is
	 * the cached document rather than the file's text - that is what keeps a
	 * marker edit and a transcript write from clobbering each other - so the
	 * text it hands over would only be thrown away.
	 *
	 * `Vault.create` refuses a path that is taken, and one can be taken by
	 * the time it runs even though the lookup just found nothing: sync can
	 * deliver the file in between, and early in startup the file can exist
	 * on disk before the index lists it. What happens then depends on what
	 * the document is. One no file stood behind was built without the file
	 * that appeared, so writing it would erase that file; it is handed back
	 * to be re-read. One read from a file is the store's own state for that
	 * file and simply replaces it, through the vault when the index has
	 * caught up and through the adapter while it has not.
	 * @returns false when a file appeared under a document no file stood behind
	 */
	private async writeFile(
		filePath: string,
		sidecar: RecordingSidecar,
		data: string,
	): Promise<boolean> {
		const { vault } = this.app;
		const unbacked = this.unbacked.has(sidecar);
		const existing = vault.getFileByPath(filePath);
		if (existing) {
			if (unbacked) {
				return false;
			}
			await vault.modify(existing, data);
		} else {
			try {
				await vault.create(filePath, data);
			} catch (error) {
				const located = await this.locate(filePath);
				if (located === null) {
					throw error;
				}
				if (unbacked) {
					return false;
				}
				await (located === UNINDEXED
					? vault.adapter.write(filePath, data)
					: vault.modify(located, data));
			}
		}
		this.unbacked.delete(sidecar);
		return true;
	}

	/**
	 * Removes the file of a document that became empty because the user
	 * cleared the last thing in it, with `Vault.delete` rather than
	 * `FileManager.trashFile`. This is the store tidying its own data, not a
	 * user deleting a file: what the user removed was a marker, a position or
	 * a record, each through its own control, and the file only goes because
	 * nothing is left to keep in it. It happens routinely - a sidecar holding
	 * only a playback position is emptied every time a recording is heard to
	 * the end - so trashing it would leave a stray JSON file in the user's
	 * trash after every finished listen. The vault still fires its delete
	 * event, which is what takes the recording out of the marker search.
	 * The obsidianmd `prefer-file-manager-trash-file` lint warning on the call
	 * is expected: the rule's config forbids silencing it inline, and the
	 * advice it gives is right for a file the user deletes, which this is not.
	 *
	 * A file that turned up under a document no file stood behind is left
	 * alone, for the same reason {@link writeFile} will not overwrite it: the
	 * store has not read it, so it cannot know the file is empty too.
	 * @returns false when a file appeared under a document no file stood behind
	 */
	private async removeFile(
		filePath: string,
		sidecar: RecordingSidecar,
	): Promise<boolean> {
		const located = await this.locate(filePath);
		if (located !== null) {
			if (this.unbacked.has(sidecar)) {
				return false;
			}
			await (located === UNINDEXED
				? this.app.vault.adapter.remove(filePath)
				: this.app.vault.delete(located));
		}
		this.unbacked.add(sidecar);
		return true;
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
