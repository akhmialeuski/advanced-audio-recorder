/**
 * Session-scoped marker drafts for a live recording: buffers drafts while
 * the session runs, persists them into the final files' sidecars at stop,
 * and reconciles the race where a naming modal is still open after the
 * session has finalized (the edit or cancel must reach the already-saved
 * marker instead of being silently lost).
 * @module recording/RecordingMarkerCoordinator
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';
import {
	MARKER_KIND,
	removeMarker,
	sortMarkers,
	updateMarker,
	type MarkerKind,
} from '../markers/markerModel';
import { defaultMarkerLabel, generateMarkerId } from '../markers/markerFactory';
import {
	groupMarkersByFile,
	type RecordingMarkerDraft,
	type RecordingMarkerHandle,
} from './recordingMarkers';
import type { RecordingSaveResult, TrackFileGroup } from '../types';

/** Position of a marker inside the running session. */
export interface MarkerPosition {
	/** Ordinal of the auto-split part the marker falls into. */
	partOrdinal: number;
	/** Offset in seconds from the start of that part. */
	offsetSeconds: number;
}

/**
 * Buffers and persists the markers captured during one recording session.
 */
export class RecordingMarkerCoordinator {
	/** Markers captured during the current session, flushed at stop. */
	private buffer: RecordingMarkerDraft[] = [];
	/** Last marker kind chosen in the modal, preselected next time. */
	private lastKind: MarkerKind = MARKER_KIND.bookmark;
	/**
	 * Sidecar paths each persisted marker landed in, keyed by draft id.
	 * Populated at stop so a naming modal still open when the session ends
	 * can edit or discard the already-saved marker rather than silently
	 * losing the change. Reset when a new session starts.
	 */
	private readonly persistedPaths = new Map<string, string[]>();

	/**
	 * @param markerStore - Sidecar store the persisted markers are written to
	 */
	constructor(private readonly markerStore: RecordingSidecarStore) {}

	/**
	 * Resets the draft buffer and the persisted-path index for a new session.
	 */
	beginSession(): void {
		this.buffer = [];
		this.persistedPaths.clear();
	}

	/**
	 * Drops the buffered drafts. The persisted-path index is kept so a
	 * naming modal still open after stop can reach its saved marker.
	 */
	clearBuffer(): void {
		this.buffer = [];
	}

	/**
	 * Captures a marker at the given position and adds it to the session
	 * buffer immediately, so it survives even if the recording stops while
	 * the naming modal is still open. Returns an editing handle for the
	 * modal.
	 * @param position - Part ordinal and offset the marker was dropped at
	 * @param preselectKind - Marker kind fixed by the invoking command;
	 *   defaults to the kind last chosen in the modal
	 */
	captureDraft(
		position: MarkerPosition,
		preselectKind?: MarkerKind,
	): RecordingMarkerHandle {
		const kind = preselectKind ?? this.lastKind;
		const draft: RecordingMarkerDraft = {
			id: generateMarkerId(),
			partOrdinal: position.partOrdinal,
			offsetSeconds: position.offsetSeconds,
			kind,
			label: this.nextLabel(kind, null),
		};
		this.buffer.push(draft);
		return {
			initialKind: draft.kind,
			defaultLabelFor: (kind: MarkerKind) =>
				this.nextLabel(kind, draft.id),
			commit: (label: string, kind: MarkerKind) => {
				draft.kind = kind;
				const trimmed = label.trim();
				draft.label =
					trimmed.length > 0
						? trimmed
						: this.nextLabel(kind, draft.id);
				this.lastKind = kind;
				// If the session finalized while the modal was open the draft
				// was already persisted with its default label; push the edit
				// through to the sidecar so the user's name/kind is not lost.
				void this.syncPersisted(draft);
			},
			cancel: () => {
				const index = this.buffer.findIndex(
					(entry) => entry.id === draft.id,
				);
				if (index !== -1) {
					this.buffer.splice(index, 1);
				}
				// Same race: a draft persisted before the modal closed must be
				// removed from its sidecar so cancelling truly discards it.
				void this.removePersisted(draft.id);
			},
		};
	}

	/**
	 * Writes the session's buffered markers into the sidecars of the final
	 * files. Each marker resolves to its part's file per track and fans out
	 * to every track (they share one timeline). Never throws: a marker write
	 * failure must not break the stop sequence.
	 * @param result - The finalized save result with per-track file groups
	 */
	async persistMarkers(result: RecordingSaveResult): Promise<void> {
		if (this.buffer.length === 0) {
			return;
		}
		const groups: TrackFileGroup[] = result.trackFiles ?? [
			{ trackIndex: 0, files: result.audioPaths },
		];
		const writes = groupMarkersByFile(this.buffer, groups);
		// Record where each draft landed before any await runs, so a modal
		// still open can reach its persisted marker by id. Done in one
		// synchronous pass: no commit/cancel can interleave mid-write.
		for (const { path, markers } of writes) {
			for (const marker of markers) {
				const paths = this.persistedPaths.get(marker.id) ?? [];
				paths.push(path);
				this.persistedPaths.set(marker.id, paths);
			}
		}
		for (const { path, markers } of writes) {
			try {
				const existing = await this.markerStore.getMarkers(path);
				await this.markerStore.setMarkers(
					path,
					sortMarkers([...existing, ...markers]),
				);
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to persist recording markers for ${path}:`,
					error,
				);
			}
		}
	}

	/**
	 * Default label for a new marker of the given kind, numbered after the
	 * markers already buffered this session (excluding the given draft so it
	 * never counts itself).
	 * @param kind - Marker kind being labelled
	 * @param excludeId - Draft id to exclude from the count, or null
	 */
	private nextLabel(kind: MarkerKind, excludeId: string | null): string {
		const others = this.buffer.filter((entry) => entry.id !== excludeId);
		return defaultMarkerLabel(others, kind);
	}

	/**
	 * Pushes a draft's edited label and kind onto every sidecar it was
	 * already persisted to. No-op while the session is still active (the
	 * draft is then edited in place in the buffer instead). Never throws: a
	 * sidecar write failure must not surface from a UI commit handler.
	 * @param draft - The edited draft
	 */
	private async syncPersisted(draft: RecordingMarkerDraft): Promise<void> {
		const paths = this.persistedPaths.get(draft.id);
		if (!paths) {
			return;
		}
		for (const path of paths) {
			try {
				const existing = await this.markerStore.getMarkers(path);
				await this.markerStore.setMarkers(
					path,
					updateMarker(existing, draft.id, {
						label: draft.label,
						kind: draft.kind,
					}),
				);
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to update persisted marker for ${path}:`,
					error,
				);
			}
		}
	}

	/**
	 * Removes an already-persisted marker from every sidecar it landed in.
	 * No-op while the session is still active (the draft is just dropped from
	 * the buffer instead). Never throws.
	 * @param id - The draft/marker id to remove
	 */
	private async removePersisted(id: string): Promise<void> {
		const paths = this.persistedPaths.get(id);
		if (!paths) {
			return;
		}
		this.persistedPaths.delete(id);
		for (const path of paths) {
			try {
				const existing = await this.markerStore.getMarkers(path);
				await this.markerStore.setMarkers(
					path,
					removeMarker(existing, id),
				);
			} catch (error) {
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to remove persisted marker for ${path}:`,
					error,
				);
			}
		}
	}
}
