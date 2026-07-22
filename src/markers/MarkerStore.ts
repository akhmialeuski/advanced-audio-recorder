/**
 * Marker-facing facade over the shared per-recording sidecar store. The
 * sidecar file next to each recording (`<recording>.markers.json`) now holds
 * markers and transcript data together; this class keeps the marker API its
 * callers were built against (`get`/`set`/`handleRename`/`handleDelete`/
 * `clearCache`) while delegating storage to the one
 * {@link RecordingSidecarStore} instance the plugin owns, so marker edits and
 * transcript writes share a cache and a serialized write chain and can never
 * clobber each other.
 * @module markers/MarkerStore
 */

import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { PlayerMarker } from './markerModel';

/**
 * Loads and saves per-recording marker lists through the shared sidecar store.
 */
export class MarkerStore {
	/**
	 * @param store - The plugin's shared recording sidecar store
	 */
	constructor(private readonly store: RecordingSidecarStore) {}

	/**
	 * Returns the markers stored for a recording path, or an empty array
	 * when none exist. Results are cached after the first read.
	 * @param path - Vault-relative recording path
	 */
	async get(path: string): Promise<PlayerMarker[]> {
		return this.store.getMarkers(path);
	}

	/**
	 * Replaces the markers for a recording and persists its sidecar. The
	 * sidecar file is removed only when the whole document (markers and
	 * transcript data) is empty, so the vault is not left with empty files.
	 * @param path - Vault-relative recording path
	 * @param markers - Markers to store
	 */
	async set(path: string, markers: readonly PlayerMarker[]): Promise<void> {
		return this.store.setMarkers(path, markers);
	}

	/**
	 * Moves a recording's sidecar to follow a rename/move, so its markers
	 * stay attached instead of orphaning.
	 * @param oldPath - Previous recording path
	 * @param newPath - New recording path
	 */
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		return this.store.handleRename(oldPath, newPath);
	}

	/**
	 * Removes a recording's sidecar when the recording is deleted, so no
	 * orphan sidecar is left behind.
	 * @param path - Deleted recording path
	 */
	async handleDelete(path: string): Promise<void> {
		return this.store.handleDelete(path);
	}

	/**
	 * Drops the in-memory cache so later reads re-read from disk. Used when
	 * the feature is torn down.
	 */
	clearCache(): void {
		this.store.clearCache();
	}
}
