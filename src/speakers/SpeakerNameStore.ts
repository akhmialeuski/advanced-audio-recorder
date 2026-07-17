/**
 * Persistence for speaker names. Each recording stores its speaker roster
 * and label-to-name mapping in a sidecar file next to it in the vault,
 * named `<recording><suffix>` (for example `rec.wav.speakers.json`).
 * Living in the vault means the names survive a plugin reinstall and
 * travel with the vault; rename and delete of the recording are mirrored
 * onto the sidecar so the names stay attached and do not orphan. Reads
 * are cached per path and writes are serialized through a promise chain
 * so concurrent edits cannot interleave. Mirrors the MarkerStore pattern.
 * @module speakers/SpeakerNameStore
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	emptySpeakerNames,
	hasSpeakerData,
	parseSpeakerNames,
	serializeSpeakerNames,
	type SpeakerNames,
} from './speakerNameModel';

/** Suffix appended to a recording's path to form its sidecar path. */
const SIDECAR_SUFFIX = '.speakers.json';

/** Current on-disk sidecar schema version. */
const SIDECAR_VERSION = 1;

/** Shape of a persisted sidecar file. */
interface SpeakerSidecarFile {
	version: number;
	speakers: string[];
	names: Record<string, string>;
}

/**
 * Loads and saves per-recording speaker names as sidecar JSON files.
 */
export class SpeakerNameStore {
	private readonly cache = new Map<string, SpeakerNames>();
	/** Serializes writes so concurrent saves never interleave. */
	private writeChain: Promise<void> = Promise.resolve();

	/**
	 * @param app - Obsidian App instance
	 */
	constructor(private readonly app: App) {}

	/**
	 * Returns the speaker names stored for a recording path, or an empty
	 * state when none exist. Results are cached after the first read.
	 * @param path - Vault-relative recording path
	 */
	async get(path: string): Promise<SpeakerNames> {
		const cached = this.cache.get(path);
		if (cached) {
			return cached;
		}
		const names = await this.read(path);
		this.cache.set(path, names);
		return names;
	}

	/**
	 * Replaces the speaker names for a recording and persists its sidecar.
	 * An empty state removes the sidecar so the vault is not left with
	 * empty files.
	 * @param path - Vault-relative recording path
	 * @param value - Speaker names to store
	 */
	async set(path: string, value: SpeakerNames): Promise<void> {
		const serialized = serializeSpeakerNames(value);
		this.cache.set(path, serialized);
		return this.enqueue(async () => {
			const sidecar = this.sidecarPath(path);
			try {
				if (!hasSpeakerData(serialized)) {
					if (await this.app.vault.adapter.exists(sidecar)) {
						await this.app.vault.adapter.remove(sidecar);
					}
					return;
				}
				const payload: SpeakerSidecarFile = {
					version: SIDECAR_VERSION,
					speakers: serialized.speakers,
					names: serialized.names,
				};
				await this.app.vault.adapter.write(
					sidecar,
					JSON.stringify(payload),
				);
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to write speaker names for ${path}:`,
					error,
				);
			}
		});
	}

	/**
	 * Moves a recording's sidecar to follow a rename/move, so its speaker
	 * names stay attached instead of orphaning.
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
					`${PLUGIN_LOG_PREFIX} Failed to move speaker names ${oldPath} -> ${newPath}:`,
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
					`${PLUGIN_LOG_PREFIX} Failed to delete speaker names for ${path}:`,
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
	 * Reads and parses a recording's sidecar, mapping a missing or
	 * unreadable file to an empty state.
	 * @param path - Vault-relative recording path
	 */
	private async read(path: string): Promise<SpeakerNames> {
		const sidecar = this.sidecarPath(path);
		try {
			if (await this.app.vault.adapter.exists(sidecar)) {
				const raw = await this.app.vault.adapter.read(sidecar);
				return parseSpeakerNames(JSON.parse(raw));
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read speaker names for ${path}; starting empty:`,
				error,
			);
		}
		return emptySpeakerNames();
	}

	/**
	 * Queues a write behind any in-flight write so concurrent saves never
	 * interleave.
	 * @param task - Async write to run
	 */
	private enqueue(task: () => Promise<void>): Promise<void> {
		this.writeChain = this.writeChain.then(task);
		return this.writeChain;
	}
}
