/**
 * Pure helpers for placing markers during a recording session. A marker is
 * captured live at the instant the user triggers it; its position is stored
 * as a (part ordinal, within-part offset) pair so it can be resolved to the
 * right final file once the session is finalized - correctly across plain,
 * auto-split, and multi-track recordings.
 *
 * Everything here is pure (no DOM, no I/O, no clock) so the position and
 * file-resolution arithmetic can be unit tested directly.
 * @module recording/recordingMarkers
 */

import type { MarkerKind } from '../player/markers/markerModel';
import type { TrackFileGroup } from '../types';

/**
 * A marker captured during recording, before it is resolved to a file.
 * `offsetSeconds` is the offset from the START of its part (auto-split) or
 * from the start of the recording (no split); `partOrdinal` is the 0-based
 * index of the part that was recording when the marker was dropped.
 */
export interface RecordingMarkerDraft {
	/** Stable id, reused as the persisted marker id. */
	id: string;
	/** 0-based part index that was recording at trigger time. */
	partOrdinal: number;
	/** Offset in seconds from the start of that part. */
	offsetSeconds: number;
	/** Whether this is a bookmark or a chapter. */
	kind: MarkerKind;
	/** User-facing label (default, then editable in the modal). */
	label: string;
}

/**
 * Editing handle returned when a marker is captured during recording. The
 * draft is already frozen in the session buffer at the captured time; the
 * modal uses this to fill the default label, commit the user's edits, or
 * discard the draft if cancelled.
 */
export interface RecordingMarkerHandle {
	/** The session's last-used kind, used to preselect the modal. */
	initialKind: MarkerKind;
	/** Default label for a kind, numbered excluding this draft. */
	defaultLabelFor(kind: MarkerKind): string;
	/** Commits the user's label and kind onto the buffered draft. */
	commit(label: string, kind: MarkerKind): void;
	/** Discards the buffered draft (modal cancelled or closed unconfirmed). */
	cancel(): void;
}

/**
 * Snapshot of the rotation controller's active-time accounting needed to
 * derive a marker position. The caller folds the live (since-anchor) term
 * into both ms values before calling so this stays clock-free.
 */
export interface PartPositionState {
	/** Whether the session captures raw PCM for WAV output. */
	isWavPcm: boolean;
	/** Whether auto-split is active for the session. */
	splitEnabled: boolean;
	/** Auto-split part duration in minutes. */
	partMinutes: number;
	/** Active (unpaused) ms accumulated in the current part. */
	partActiveMs: number;
	/** Active (unpaused) ms accumulated across the whole session. */
	sessionActiveMs: number;
	/** Count of completed part rotations (current part index). */
	sessionPartOrdinal: number;
}

/** A resolved marker position: which part and the offset within it. */
export interface PartPosition {
	partOrdinal: number;
	offsetSeconds: number;
}

/**
 * Derives the current (part ordinal, within-part offset) from the session's
 * active-time accounting. Without auto-split there is a single part, so the
 * offset is the whole-session active time. With auto-split the boundaries are
 * synchronized by audio time across all tracks: compressed sessions reset the
 * per-part clock on each rotation (so the part ordinal comes from the rotation
 * counter), while PCM sessions split sample-exact at exactly partMinutes of
 * audio, so the ordinal is derived from the session clock.
 *
 * For PCM the session clock is wall-clock active time, used as a proxy for
 * captured-sample time. The two can drift by the audio-hardware-vs-system
 * clock skew (well under a second per part in practice), so a marker dropped
 * within that skew of a part boundary may resolve to the neighbouring part;
 * `resolvePartFileIndex` then clamps it into a real file. This is accepted in
 * exchange for one position mechanism shared by compressed and PCM sessions.
 * @param state - Active-time snapshot with the live term already folded in
 */
export function computePartPosition(state: PartPositionState): PartPosition {
	if (!state.splitEnabled) {
		return { partOrdinal: 0, offsetSeconds: state.sessionActiveMs / 1000 };
	}
	if (state.isWavPcm) {
		const totalSeconds = state.sessionActiveMs / 1000;
		const partSeconds = state.partMinutes * 60;
		const partOrdinal = Math.floor(totalSeconds / partSeconds);
		return {
			partOrdinal,
			offsetSeconds: totalSeconds - partOrdinal * partSeconds,
		};
	}
	return {
		partOrdinal: state.sessionPartOrdinal,
		offsetSeconds: state.partActiveMs / 1000,
	};
}

/**
 * Resolves which file in a track's ordered part list a marker belongs to.
 * Clamps to the last file so a marker whose part failed to save (its audio
 * was carried into a later part) still lands in a real file, and returns -1
 * when the track produced no files at all.
 * @param partOrdinal - 0-based part index captured at trigger time
 * @param fileCount - Number of files this track produced
 */
export function resolvePartFileIndex(
	partOrdinal: number,
	fileCount: number,
): number {
	if (fileCount <= 0) {
		return -1;
	}
	return Math.min(Math.max(0, partOrdinal), fileCount - 1);
}

/**
 * A marker destined for one file's sidecar. Carries the originating draft's
 * id so the same logical marker keeps a stable identity across the tracks it
 * fans out to, and can still be found and edited after it is persisted.
 */
export interface MarkerFileWrite {
	path: string;
	markers: { id: string; time: number; label: string; kind: MarkerKind }[];
}

/**
 * Groups buffered markers by the final file they belong to. Every marker
 * fans out to each track at the file resolved for its part ordinal, since
 * all tracks share one timeline. Tracks that produced no files contribute
 * nothing. Insertion order of files is preserved for deterministic output.
 * @param drafts - Markers captured during the session
 * @param groups - Per-track ordered file lists from finalization
 */
export function groupMarkersByFile(
	drafts: readonly RecordingMarkerDraft[],
	groups: readonly TrackFileGroup[],
): MarkerFileWrite[] {
	const byPath = new Map<string, MarkerFileWrite>();
	const order: string[] = [];
	for (const group of groups) {
		for (const draft of drafts) {
			const fileIndex = resolvePartFileIndex(
				draft.partOrdinal,
				group.files.length,
			);
			if (fileIndex === -1) {
				continue;
			}
			const path = group.files[fileIndex];
			let entry = byPath.get(path);
			if (!entry) {
				entry = { path, markers: [] };
				byPath.set(path, entry);
				order.push(path);
			}
			entry.markers.push({
				id: draft.id,
				time: draft.offsetSeconds,
				label: draft.label,
				kind: draft.kind,
			});
		}
	}
	return order.map((path) => {
		const entry = byPath.get(path);
		if (!entry) {
			// Unreachable: every path in `order` was just inserted.
			return { path, markers: [] };
		}
		return entry;
	});
}
