/**
 * Persistence for the per-recording sidecar document: player markers plus the
 * transcript section (speaker roster, written outputs, rename history). One
 * store instance owns every sidecar file, caches whole documents per path,
 * and serializes all mutations through a single promise chain, so a marker
 * edit and a transcript write can never interleave and clobber each other -
 * each write persists the entire document from the cache. Rename and delete
 * of the recording are mirrored onto the sidecar so it stays attached, and
 * every I/O failure degrades to a logged warning, never a thrown error.
 * @module sidecar/RecordingSidecarStore
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { PlayerMarker } from '../markers/markerModel';
import { serializeMarkers } from '../markers/markerModel';
import {
	emptyRecordingSidecar,
	isSidecarEmpty,
	parseRecordingSidecar,
	serializeRecordingSidecar,
	SIDECAR_HISTORY_LIMIT,
	type FileOutput,
	type NoteOutput,
	type RecordingSidecar,
	type SpeakerEntry,
	type TranscriptSection,
} from './recordingSidecarModel';

/** Suffix appended to a recording's path to form its sidecar path. */
const SIDECAR_SUFFIX = '.markers.json';

/**
 * Loads and saves per-recording sidecar documents (markers + transcript).
 */
export class RecordingSidecarStore {
	private readonly cache = new Map<string, RecordingSidecar>();
	/** Serializes mutations so concurrent saves never interleave. */
	private writeChain: Promise<void> = Promise.resolve();

	/**
	 * @param app - Obsidian App instance
	 */
	constructor(private readonly app: App) {}

	/**
	 * Returns the markers stored for a recording path, or an empty array
	 * when none exist. Results are cached after the first read.
	 * @param path - Vault-relative recording path
	 */
	async getMarkers(path: string): Promise<PlayerMarker[]> {
		return (await this.load(path)).markers;
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
	 * Returns the transcript section stored for a recording path (empty when
	 * none exists). The returned object is the cached document's section;
	 * callers must treat it as read-only and mutate through the store.
	 * @param path - Vault-relative recording path
	 */
	async getTranscript(path: string): Promise<TranscriptSection> {
		return (await this.load(path)).transcript;
	}

	/**
	 * Replaces the speaker roster: the given entries become the head of the
	 * roster in their order (each replacing any stored entry with the same
	 * label, name included or removed as given), while stored entries whose
	 * labels are not mentioned are kept after them - a label that vanished
	 * from the last transcription keeps its assigned name for the future.
	 * @param path - Vault-relative recording path
	 * @param entries - New roster in first-seen order
	 */
	async setSpeakers(
		path: string,
		entries: readonly SpeakerEntry[],
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			const mentioned = new Set(entries.map((entry) => entry.label));
			const kept = sidecar.transcript.speakers.filter(
				(entry) => !mentioned.has(entry.label),
			);
			sidecar.transcript.speakers = [
				...entries.map((entry) =>
					entry.name
						? { label: entry.label, name: entry.name }
						: { label: entry.label },
				),
				...kept,
			];
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
				output,
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
				output,
			);
		});
	}

	/**
	 * Appends an applied name mapping to the rename history, dropping the
	 * oldest entries beyond the cap.
	 * @param path - Vault-relative recording path
	 * @param names - Full label-to-name assignment after the apply
	 */
	async pushHistory(
		path: string,
		names: Record<string, string>,
	): Promise<void> {
		return this.mutate(path, (sidecar) => {
			sidecar.transcript.history = [
				...sidecar.transcript.history,
				{ at: new Date().toISOString(), names: { ...names } },
			].slice(-SIDECAR_HISTORY_LIMIT);
		});
	}

	/**
	 * Moves a recording's sidecar to follow a rename/move, so its markers and
	 * transcript data stay attached instead of orphaning.
	 * @param oldPath - Previous recording path
	 * @param newPath - New recording path
	 */
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		const cached = this.cache.get(oldPath);
		this.cache.delete(oldPath);
		if (cached) {
			this.cache.set(newPath, cached);
		}
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
		});
	}

	/**
	 * Removes a recording's sidecar when the recording is deleted, so no
	 * orphan sidecar is left behind.
	 * @param path - Deleted recording path
	 */
	async handleDelete(path: string): Promise<void> {
		this.cache.delete(path);
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
		});
	}

	/**
	 * Drops the in-memory cache so later reads re-read from disk. Used when
	 * the feature is torn down.
	 */
	clearCache(): void {
		this.cache.clear();
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
	 * first access. A missing, unreadable, or non-JSON file maps to an empty
	 * document, matching the marker store's degradation discipline.
	 * @param path - Vault-relative recording path
	 */
	private async load(path: string): Promise<RecordingSidecar> {
		const cached = this.cache.get(path);
		if (cached) {
			return cached;
		}
		let sidecar = emptyRecordingSidecar();
		const file = this.sidecarPath(path);
		try {
			if (await this.app.vault.adapter.exists(file)) {
				const raw = await this.app.vault.adapter.read(file);
				sidecar = parseRecordingSidecar(JSON.parse(raw));
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read sidecar for ${path}; starting empty:`,
				error,
			);
			sidecar = emptyRecordingSidecar();
		}
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
	 * different sections can never lose each other's change.
	 * @param path - Vault-relative recording path
	 * @param change - Mutation applied to the cached document
	 */
	private mutate(
		path: string,
		change: (sidecar: RecordingSidecar) => void,
	): Promise<void> {
		return this.enqueue(async () => {
			const sidecar = await this.load(path);
			change(sidecar);
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
