/**
 * Session-scoped marker drafts for a live recording: buffers drafts while
 * the session runs, persists them into the final files' sidecars at stop,
 * and reconciles the race where a naming modal is still open after the
 * session has finalized (the edit or cancel must reach the already-saved
 * marker instead of being silently lost).
 * @module recording/RecordingMarkerCoordinator
 */

import { Notice } from 'obsidian';
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
 * Default label for a new marker of the given kind, numbered after the other
 * drafts of its session (excluding the given draft so it never counts itself).
 * @param drafts - The session's drafts
 * @param kind - Marker kind being labelled
 * @param excludeId - Draft id to exclude from the count, or null
 * @returns The label
 */
function nextLabel(
	drafts: readonly RecordingMarkerDraft[],
	kind: MarkerKind,
	excludeId: string | null,
): string {
	return defaultMarkerLabel(
		drafts.filter((entry) => entry.id !== excludeId),
		kind,
	);
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
	 * Hands the session's drafts over to its save and starts an empty buffer
	 * for whatever records next. The list handed over is the one the drafts'
	 * handles edit, so a name committed or a draft cancelled while the save
	 * waits still reaches it.
	 * @returns The session's drafts, in capture order
	 */
	takeDrafts(): RecordingMarkerDraft[] {
		const drafts = this.buffer;
		this.buffer = [];
		return drafts;
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
		// The session's own list, held rather than read back from the field:
		// a stop hands it to the save and the field moves on to the next
		// session while this draft's modal may still be open.
		const sessionDrafts = this.buffer;
		const draft: RecordingMarkerDraft = {
			id: generateMarkerId(),
			partOrdinal: position.partOrdinal,
			offsetSeconds: position.offsetSeconds,
			kind,
			label: nextLabel(sessionDrafts, kind, null),
		};
		sessionDrafts.push(draft);
		return {
			initialKind: draft.kind,
			defaultLabelFor: (kind: MarkerKind) =>
				nextLabel(sessionDrafts, kind, draft.id),
			commit: (label: string, kind: MarkerKind) => {
				draft.kind = kind;
				const trimmed = label.trim();
				draft.label =
					trimmed.length > 0
						? trimmed
						: nextLabel(sessionDrafts, kind, draft.id);
				this.lastKind = kind;
				// If the session finalized while the modal was open the draft
				// was already persisted with its default label; push the edit
				// through to the sidecar so the user's name/kind is not lost.
				void this.syncPersisted(draft);
			},
			cancel: () => {
				const index = sessionDrafts.findIndex(
					(entry) => entry.id === draft.id,
				);
				if (index !== -1) {
					sessionDrafts.splice(index, 1);
				}
				// Same race: a draft persisted before the modal closed must be
				// removed from its sidecar so cancelling truly discards it.
				void this.removePersisted(draft.id);
			},
		};
	}

	/**
	 * Writes a session's markers into the sidecars of its final files. Each
	 * marker resolves to its part's file per track and fans out to every
	 * track (they share one timeline). Never throws: a marker write failure
	 * must not break the save.
	 * @param drafts - The session's drafts, as {@link takeDrafts} handed them
	 * @param result - The finalized save result with per-track file groups
	 */
	async persistMarkers(
		drafts: readonly RecordingMarkerDraft[],
		result: RecordingSaveResult,
	): Promise<void> {
		if (drafts.length === 0) {
			return;
		}
		const groups: TrackFileGroup[] = result.trackFiles ?? [
			{ trackIndex: 0, files: result.audioPaths },
		];
		const writes = groupMarkersByFile(drafts, groups);
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
		let failed = 0;
		for (const { path, markers } of writes) {
			try {
				// Atomic read-modify-write: a marker another writer persisted
				// between this read and write is merged, not clobbered.
				await this.markerStore.updateMarkers(path, (existing) =>
					sortMarkers([...existing, ...markers]),
				);
			} catch (error) {
				failed++;
				console.error(
					`${PLUGIN_LOG_PREFIX} Failed to persist recording markers for ${path}:`,
					error,
				);
			}
		}
		// The session's markers exist only in this buffer; losing a write
		// must be said out loud, not just logged, or the user discovers the
		// loss days later when the player shows nothing.
		if (failed > 0) {
			new Notice(
				`Markers of this recording could not be saved for ${String(failed)} ` +
					'file(s); see the developer console for details.',
			);
		}
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
				await this.markerStore.updateMarkers(path, (existing) =>
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
				await this.markerStore.updateMarkers(path, (existing) =>
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
