/**
 * Marker CRUD for one player: the authoritative marker list for the file,
 * its persistence to the sidecar store, and chapter navigation lookups.
 * How markers are displayed (ticks, list, active highlight) stays with the
 * player and its MarkerListView.
 * @module player/PlayerMarkerController
 */

import { Notice } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { formatTimecode } from '../utils/TimeUtils';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import {
	addMarker,
	chapters,
	nextChapterTime,
	previousChapterTime,
	removeMarker,
	updateMarker,
	type MarkerKind,
	type PlayerMarker,
} from '../markers/markerModel';
import { defaultMarkerLabel, generateMarkerId } from '../markers/markerFactory';

/** Lifecycle and display hooks the controller needs from the player. */
export interface PlayerMarkerHost {
	/** True once the player is torn down; async work must stop. */
	isUnloaded(): boolean;
	/** Re-renders the marker ticks and list from the current data. */
	renderMarkers(): void;
	/**
	 * Refreshes the ticks only, leaving the list untouched so the input
	 * the user is typing in keeps focus (the rename path).
	 */
	refreshTicks(): void;
	/**
	 * Refreshes other live players of this file (e.g. the reading-view
	 * copy) so a change shows everywhere without re-opening.
	 */
	notifyOthers(): void;
}

/**
 * Owns the marker data and persistence for one player.
 */
export class PlayerMarkerController {
	/** Authoritative marker list for this file; the view renders from it. */
	private markers: PlayerMarker[] = [];

	constructor(
		private readonly markerStore: RecordingSidecarStore,
		private readonly filePath: string,
		private readonly host: PlayerMarkerHost,
	) {}

	/** The current markers (rendered by the player's view). */
	get all(): PlayerMarker[] {
		return this.markers;
	}

	/** Drops the in-memory markers (markers window disabled). */
	clear(): void {
		this.markers = [];
	}

	/**
	 * Loads persisted markers for this file and renders them.
	 */
	async load(): Promise<void> {
		try {
			const stored = await this.markerStore.getMarkers(this.filePath);
			if (this.host.isUnloaded()) {
				return;
			}
			this.markers = stored;
			this.host.renderMarkers();
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to load markers for ${this.filePath}:`,
				error,
			);
		}
	}

	/**
	 * Adds a marker or chapter at the given time with a default label,
	 * persists it, and re-renders. The user can rename it afterwards in
	 * the marker list.
	 * @param time - Offset in seconds
	 * @param kind - Whether to add a bookmark or a chapter
	 */
	async addAt(time: number, kind: MarkerKind): Promise<void> {
		const safeTime = Math.max(0, time);
		const label = defaultMarkerLabel(this.markers, kind);
		const marker = {
			id: generateMarkerId(),
			time: safeTime,
			label,
			kind,
		};
		this.markers = addMarker(this.markers, marker);
		this.host.renderMarkers();
		// The success notice is earned by the persist: announcing an add whose
		// write was refused would report a marker that does not exist.
		if (await this.persist((stored) => addMarker(stored, marker))) {
			new Notice(`${label} added at ${formatTimecode(safeTime)}`);
		}
	}

	/**
	 * Removes a marker by id, persists, and re-renders.
	 * @param id - Marker identifier
	 */
	async remove(id: string): Promise<void> {
		this.markers = removeMarker(this.markers, id);
		this.host.renderMarkers();
		await this.persist((stored) => removeMarker(stored, id));
	}

	/**
	 * Renames a marker, persists, and refreshes the ticks. The list is not
	 * rebuilt so the input the user is typing in keeps focus.
	 * @param id - Marker identifier
	 * @param label - New label
	 */
	async rename(id: string, label: string): Promise<void> {
		this.markers = updateMarker(this.markers, id, { label });
		this.host.refreshTicks();
		await this.persist((stored) => updateMarker(stored, id, { label }));
	}

	/**
	 * The next chapter boundary after the given position, or null.
	 * @param currentTime - Current playback position in seconds
	 */
	nextChapter(currentTime: number): number | null {
		return nextChapterTime(chapters(this.markers), currentTime);
	}

	/**
	 * The previous chapter boundary before the given position (or the
	 * start of the current one shortly after its boundary), or null.
	 * @param currentTime - Current playback position in seconds
	 */
	previousChapter(currentTime: number): number | null {
		return previousChapterTime(chapters(this.markers), currentTime);
	}

	/**
	 * Persists one marker operation through the store's atomic
	 * read-modify-write, so a concurrent writer (a recording-session flush,
	 * auto chapters) merged between this player's read and write is never
	 * clobbered. The merged result becomes the authoritative list; a change
	 * another writer contributed triggers a re-render. A refused write (the
	 * store rejects for a corrupt sidecar) is surfaced with a Notice and the
	 * view is re-synced with the store, so an optimistic edit never stays on
	 * screen pretending it was saved.
	 * @param update - The same pure operation, applied to the stored list
	 * @returns True when the operation was persisted
	 */
	private async persist(
		update: (stored: PlayerMarker[]) => readonly PlayerMarker[],
	): Promise<boolean> {
		try {
			const merged = await this.markerStore.updateMarkers(
				this.filePath,
				update,
			);
			if (this.host.isUnloaded()) {
				return true;
			}
			if (!sameMarkers(this.markers, merged)) {
				this.markers = merged;
				this.host.renderMarkers();
			} else {
				this.markers = merged;
			}
			// Refresh other live players of this file (e.g. the reading-view
			// copy) so the change shows everywhere without re-opening
			this.host.notifyOthers();
			return true;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to save markers for ${this.filePath}:`,
				error,
			);
			if (!this.host.isUnloaded()) {
				const message =
					error instanceof Error ? error.message : String(error);
				new Notice(`Markers could not be saved: ${message}`);
				await this.load();
			}
			return false;
		}
	}
}

/** Whether two marker lists are identical in ids, times, labels, and kinds. */
function sameMarkers(
	a: readonly PlayerMarker[],
	b: readonly PlayerMarker[],
): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return a.every((marker, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			marker.id === other.id &&
			marker.time === other.time &&
			marker.label === other.label &&
			marker.kind === other.kind
		);
	});
}
