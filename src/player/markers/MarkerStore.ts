/**
 * Persistence for player markers and chapters. Markers are stored in a
 * single index file inside the plugin folder, keyed by the audio file's
 * vault path, so the vault is never cluttered with sidecar files. Reads
 * are cached after the first load and writes are serialized through a
 * promise chain so concurrent edits from several players cannot
 * interleave and corrupt the index.
 * @module player/markers/MarkerStore
 */

import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../../constants';
import {
	parseMarkers,
	serializeMarkers,
	type PlayerMarker,
} from './markerModel';

/** Current on-disk index schema version. */
const INDEX_VERSION = 1;

/** Shape of the persisted marker index file. */
interface MarkerIndexFile {
	version: number;
	files: Record<string, PlayerMarker[]>;
}

/**
 * Loads and saves per-file marker lists from a JSON index file.
 */
export class MarkerStore {
	private cache: Map<string, PlayerMarker[]> | null = null;
	private loadPromise: Promise<Map<string, PlayerMarker[]>> | null = null;
	/** Serializes writes so concurrent saves never interleave. */
	private writeChain: Promise<void> = Promise.resolve();
	/** Ensures the memory-only-storage warning is logged at most once. */
	private warnedNoIndexPath = false;

	/**
	 * @param app - Obsidian App instance
	 * @param indexPath - Vault-relative path of the index file, or null
	 * when the plugin folder is unknown (markers then stay in memory)
	 */
	constructor(
		private readonly app: App,
		private readonly indexPath: string | null,
	) {}

	/**
	 * Returns the markers stored for an audio file path, or an empty
	 * array when none exist.
	 * @param path - Vault-relative audio file path
	 */
	async get(path: string): Promise<PlayerMarker[]> {
		const cache = await this.ensureLoaded();
		return cache.get(path) ?? [];
	}

	/**
	 * Replaces the markers for an audio file path and persists the index.
	 * An empty list drops the path entry to keep the index compact.
	 * @param path - Vault-relative audio file path
	 * @param markers - Markers to store
	 */
	async set(path: string, markers: readonly PlayerMarker[]): Promise<void> {
		const cache = await this.ensureLoaded();
		if (markers.length === 0) {
			cache.delete(path);
		} else {
			cache.set(path, serializeMarkers(markers));
		}
		await this.persist(cache);
	}

	/**
	 * Drops all cached markers so a reload re-reads from disk. Used when
	 * the feature is torn down.
	 */
	clearCache(): void {
		this.cache = null;
		this.loadPromise = null;
	}

	/**
	 * Loads the index once, mapping a missing or unreadable file to an
	 * empty cache. Concurrent callers share the same in-flight load.
	 */
	private ensureLoaded(): Promise<Map<string, PlayerMarker[]>> {
		if (this.cache) {
			return Promise.resolve(this.cache);
		}
		if (this.loadPromise) {
			return this.loadPromise;
		}
		this.loadPromise = this.load();
		return this.loadPromise;
	}

	/**
	 * Reads and parses the index file into the cache.
	 */
	private async load(): Promise<Map<string, PlayerMarker[]>> {
		const cache = new Map<string, PlayerMarker[]>();
		if (this.indexPath) {
			try {
				if (await this.app.vault.adapter.exists(this.indexPath)) {
					const raw = await this.app.vault.adapter.read(
						this.indexPath,
					);
					const parsed = JSON.parse(raw) as Partial<MarkerIndexFile>;
					const files = parsed.files ?? {};
					for (const [path, markers] of Object.entries(files)) {
						const valid = parseMarkers(markers);
						if (valid.length > 0) {
							cache.set(path, valid);
						}
					}
				}
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to read marker index; starting empty:`,
					error,
				);
			}
		}
		this.cache = cache;
		return cache;
	}

	/**
	 * Writes the cache to disk, queued behind any in-flight write. A
	 * failure only logs a warning: markers are an enhancement and must
	 * not break playback.
	 * @param cache - Cache to serialize
	 */
	private persist(cache: Map<string, PlayerMarker[]>): Promise<void> {
		if (!this.indexPath) {
			if (!this.warnedNoIndexPath) {
				this.warnedNoIndexPath = true;
				console.warn(
					`${PLUGIN_LOG_PREFIX} Plugin folder is unknown; player markers are kept in memory only and will not survive a reload.`,
				);
			}
			return Promise.resolve();
		}
		const indexPath = this.indexPath;
		this.writeChain = this.writeChain.then(async () => {
			const files: Record<string, PlayerMarker[]> = {};
			for (const [path, markers] of cache.entries()) {
				files[path] = markers;
			}
			const payload: MarkerIndexFile = { version: INDEX_VERSION, files };
			try {
				await this.app.vault.adapter.write(
					indexPath,
					JSON.stringify(payload),
				);
			} catch (error) {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Failed to write marker index:`,
					error,
				);
			}
		});
		return this.writeChain;
	}
}
