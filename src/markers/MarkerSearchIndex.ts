/**
 * A vault-wide index of every marker and chapter, so a name can be searched
 * for without knowing which recording carries it. Built on the first search
 * and kept in memory from then on: the sidecar store caches every document it
 * parses, so the build costs one read per sidecar per session and typing into
 * the search reads nothing at all.
 * @module markers/MarkerSearchIndex
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import type { MarkerKind, PlayerMarker } from './markerModel';
import { sortMarkers } from './markerModel';

/** One marker, with the recording it belongs to. */
export interface MarkerHit {
	/** Vault-relative path of the recording that carries the marker. */
	recordingPath: string;
	/** The recording's own name, without folder or extension. */
	recordingName: string;
	/** Marker id, unique within its recording. */
	id: string;
	/** Offset into the recording, in seconds. */
	time: number;
	/** The marker's name. */
	label: string;
	/** Whether this is a bookmark or a chapter. */
	kind: MarkerKind;
	/** The note written on the marker, or '' when it has none. */
	note: string;
}

/**
 * The recording's own name, without its folder or extension.
 * @param path - Vault-relative recording path
 * @returns The file name with no directory and no extension
 */
function recordingName(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Holds every marker in the vault, keyed by the recording that carries it.
 */
export class MarkerSearchIndex {
	/** Markers per recording path, time-sorted; empty until the first build. */
	private readonly byRecording = new Map<string, MarkerHit[]>();

	/** Whether the vault has been scanned yet this session. */
	private built = false;

	/** The build in flight, so two searches at once scan the vault once. */
	private building: Promise<void> | null = null;

	/**
	 * @param store - The sidecar store that owns the marker documents
	 */
	constructor(private readonly store: RecordingSidecarStore) {}

	/**
	 * Every marker in the vault, built on first use. Recordings are returned
	 * in path order and their markers in time order, so the result a search
	 * filters is stable between calls.
	 * @returns One entry per marker in the vault
	 */
	async all(): Promise<MarkerHit[]> {
		await this.build();
		return [...this.byRecording.keys()].sort().flatMap(
			// The key came from the map, so the lookup cannot miss.
			(path) => this.byRecording.get(path) ?? [],
		);
	}

	/**
	 * Re-reads one recording's markers, or drops it when it no longer has
	 * any. A no-op before the first build: there is no index to keep current
	 * yet, and the build will read the recording anyway.
	 * @param path - Vault-relative recording path
	 */
	async refresh(path: string): Promise<void> {
		if (!this.built) {
			return;
		}
		try {
			this.put(path, await this.store.getMarkers(path));
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to re-read the markers of ${path} for the search index:`,
				error,
			);
		}
	}

	/**
	 * Moves a recording's markers to its new path, so a rename does not cost
	 * a rebuild and does not leave the old path in the results.
	 * @param oldPath - Path the recording had
	 * @param newPath - Path it now has
	 */
	rename(oldPath: string, newPath: string): void {
		const markers = this.byRecording.get(oldPath);
		this.byRecording.delete(oldPath);
		if (markers) {
			// Re-entered rather than moved, so every entry carries the new
			// path and the new display name.
			this.put(newPath, markers);
		}
	}

	/**
	 * Drops a deleted recording from the index.
	 * @param path - Vault-relative recording path
	 */
	remove(path: string): void {
		this.byRecording.delete(path);
	}

	/** Forgets everything, so the next search scans the vault again. */
	clear(): void {
		this.byRecording.clear();
		this.built = false;
		this.building = null;
	}

	/**
	 * Scans the vault once. Concurrent callers share one scan, so opening the
	 * search twice in quick succession does not read every sidecar twice.
	 */
	private async build(): Promise<void> {
		if (this.built) {
			return;
		}
		this.building ??= this.scan();
		await this.building;
	}

	/** Reads every sidecar in the vault into the index. */
	private async scan(): Promise<void> {
		try {
			for (const { path, sidecar } of await this.store.allRecordings()) {
				this.put(path, sidecar.markers);
			}
			this.built = true;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to index the vault's markers:`,
				error,
			);
		} finally {
			this.building = null;
		}
	}

	/**
	 * Replaces one recording's entries, dropping it when it has no markers so
	 * the index never carries an empty list.
	 * @param path - Vault-relative recording path
	 * @param markers - The recording's markers
	 */
	private put(
		path: string,
		markers: readonly (PlayerMarker | MarkerHit)[],
	): void {
		if (markers.length === 0) {
			this.byRecording.delete(path);
			return;
		}
		const name = recordingName(path);
		this.byRecording.set(
			path,
			sortMarkers(markers).map((marker) => ({
				recordingPath: path,
				recordingName: name,
				id: marker.id,
				time: marker.time,
				label: marker.label,
				kind: marker.kind,
				note: marker.note ?? '',
			})),
		);
	}
}
