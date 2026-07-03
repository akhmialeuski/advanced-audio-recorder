/**
 * Persists probed media kinds (audio vs video vs unsupported) across
 * Obsidian sessions, so a file probed once never causes a probe - or the
 * embed swap that follows it - in a later session (issue #39: the
 * in-memory cache alone made the first open of each file repeat every
 * session). Entries are validated by file mtime and size, so an edited
 * or replaced file is transparently re-probed.
 *
 * The cache lives in its own JSON file in the plugin folder, NOT in
 * data.json: settings persistence carries backup/recovery machinery that
 * a frequently rewritten, losable cache must not trigger or block. A
 * missing or corrupt cache file is harmless - everything just re-probes.
 * @module player/MediaKindStore
 */

import { debounce } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { MEDIA_KIND, type MediaKind } from './mediaProbe';

/** Cache file name inside the plugin folder. */
export const MEDIA_KIND_STORE_FILE = 'media-kinds.json';

/** Debounce window for writing the cache file after a change. */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Entry cap. Oldest entries are evicted first; an evicted file is simply
 * re-probed, so the cap only bounds the file size, never correctness.
 */
const MAX_ENTRIES = 2000;

/** On-disk format version, for future migrations. */
const STORE_VERSION = 1;

/** A persisted classification with the file stats that validate it. */
interface StoredEntry {
	kind: MediaKind;
	mtime: number;
	size: number;
}

/** Shape of the cache file. */
interface StoreFileShape {
	version: number;
	entries: Record<string, StoredEntry>;
}

/** Runtime guard for entries read from disk. */
function isValidEntry(entry: unknown): entry is StoredEntry {
	if (typeof entry !== 'object' || entry === null) {
		return false;
	}
	const candidate = entry as Partial<StoredEntry>;
	return (
		typeof candidate.mtime === 'number' &&
		typeof candidate.size === 'number' &&
		typeof candidate.kind === 'string' &&
		Object.values(MEDIA_KIND).includes(candidate.kind)
	);
}

/**
 * Media-kind cache persisted in the plugin folder and validated by file
 * mtime/size. Inert (never reads or writes) when constructed without a
 * file path, e.g. when the plugin directory is unknown.
 */
export class MediaKindStore {
	/** Entries in insertion order; the oldest is evicted at the cap. */
	private readonly entries = new Map<string, StoredEntry>();
	/** True while in-memory entries differ from the file on disk. */
	private dirty = false;
	/** Debounced write that coalesces a burst of probe results. */
	private readonly scheduleSave = debounce(
		() => {
			void this.save();
		},
		SAVE_DEBOUNCE_MS,
		true,
	);

	/**
	 * @param app - Obsidian App instance (for the vault adapter)
	 * @param filePath - Vault-relative cache file path, or null to disable
	 * persistence entirely
	 */
	constructor(
		private readonly app: App,
		private readonly filePath: string | null,
	) {}

	/**
	 * Loads the cache file. Entries set in this session before the load
	 * completes win over loaded ones (they are fresher). Any read or
	 * parse failure leaves the cache empty: files are just re-probed.
	 */
	async load(): Promise<void> {
		if (!this.filePath) {
			return;
		}
		try {
			if (!(await this.app.vault.adapter.exists(this.filePath))) {
				return;
			}
			const raw = await this.app.vault.adapter.read(this.filePath);
			const parsed = JSON.parse(raw) as Partial<StoreFileShape> | null;
			if (
				parsed?.version !== STORE_VERSION ||
				typeof parsed.entries !== 'object' ||
				parsed.entries === null
			) {
				return;
			}
			for (const [path, entry] of Object.entries(parsed.entries)) {
				if (!this.entries.has(path) && isValidEntry(entry)) {
					this.entries.set(path, entry);
				}
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the media-kind cache; media files will be re-probed.`,
				error,
			);
		}
	}

	/**
	 * The persisted kind for a file, or null when absent or stale. A
	 * stale entry (mtime or size changed since it was probed) is dropped
	 * so the caller re-probes the current content.
	 * @param file - Media file to look up
	 */
	get(file: TFile): MediaKind | null {
		const entry = this.entries.get(file.path);
		if (!entry) {
			return null;
		}
		if (entry.mtime !== file.stat.mtime || entry.size !== file.stat.size) {
			this.entries.delete(file.path);
			this.markDirty();
			return null;
		}
		return entry.kind;
	}

	/**
	 * Records a probed kind with the file's current stats. Re-inserting
	 * moves the entry to the back of the eviction order.
	 * @param file - The probed media file
	 * @param kind - Its probed kind (callers persist confident results only)
	 */
	set(file: TFile, kind: MediaKind): void {
		this.entries.delete(file.path);
		this.entries.set(file.path, {
			kind,
			mtime: file.stat.mtime,
			size: file.stat.size,
		});
		while (this.entries.size > MAX_ENTRIES) {
			const oldest: string | undefined = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
		this.markDirty();
	}

	/**
	 * Moves an entry to a file's new path. The content is unchanged by a
	 * rename, so the stored stats stay valid.
	 * @param oldPath - Previous vault path
	 * @param newPath - New vault path
	 */
	handleRename(oldPath: string, newPath: string): void {
		const entry = this.entries.get(oldPath);
		if (!entry) {
			return;
		}
		this.entries.delete(oldPath);
		this.entries.set(newPath, entry);
		this.markDirty();
	}

	/**
	 * Drops the entry of a deleted file.
	 * @param path - Vault path of the deleted file
	 */
	handleDelete(path: string): void {
		if (this.entries.delete(path)) {
			this.markDirty();
		}
	}

	/**
	 * Writes any pending change immediately. Called on plugin unload so a
	 * probe result from the final debounce window is not lost.
	 */
	flush(): void {
		this.scheduleSave.run();
	}

	/** Marks the cache changed and schedules the debounced write. */
	private markDirty(): void {
		if (!this.filePath) {
			return;
		}
		this.dirty = true;
		this.scheduleSave();
	}

	/**
	 * Writes the cache file. A failed write keeps the dirty flag so the
	 * next change retries; the cache is best-effort by design.
	 */
	private async save(): Promise<void> {
		if (!this.filePath || !this.dirty) {
			return;
		}
		this.dirty = false;
		const shape: StoreFileShape = {
			version: STORE_VERSION,
			entries: Object.fromEntries(this.entries),
		};
		try {
			await this.app.vault.adapter.write(
				this.filePath,
				JSON.stringify(shape),
			);
		} catch (error) {
			this.dirty = true;
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to write the media-kind cache.`,
				error,
			);
		}
	}
}
