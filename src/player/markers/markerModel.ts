/**
 * Marker and chapter data model for the enhanced audio player. A marker
 * is a labelled point in time; a chapter is a labelled point that also
 * acts as the start of a navigable segment. Both share one structure and
 * differ only by `kind`, which keeps storage and editing uniform while
 * letting the player present them differently.
 *
 * Every function here is pure (no DOM, no I/O) so the ordering,
 * navigation, and (de)serialization logic can be unit tested directly.
 * @module player/markers/markerModel
 */

/**
 * The marker kinds the player supports, as named constants so call sites
 * reference MARKER_KIND.bookmark instead of repeating the literal - which
 * also pins the persisted `kind` value in one place.
 */
export const MARKER_KIND = {
	bookmark: 'bookmark',
	chapter: 'chapter',
} as const;

/** Distinguishes a jump-to bookmark from a chapter boundary. */
export type MarkerKind = (typeof MARKER_KIND)[keyof typeof MARKER_KIND];

/**
 * Tolerance for time comparisons so a marker positioned exactly at the
 * playhead counts as reached despite floating point drift.
 */
const TIME_EPSILON_SECONDS = 1e-6;

/**
 * Lead-in window for the "previous chapter" action: pressing it within this
 * many seconds after a chapter boundary jumps to the previous chapter rather
 * than restarting the current one.
 */
const CHAPTER_LEAD_IN_SECONDS = 2;

/**
 * A labelled point in an audio file.
 */
export interface PlayerMarker {
	/** Stable identifier, unique within a file's marker list. */
	id: string;
	/** Offset in seconds from the start of the file. */
	time: number;
	/** User-facing label. */
	label: string;
	/** Whether the marker is a bookmark or a chapter boundary. */
	kind: MarkerKind;
}

/**
 * Returns a new list sorted by time ascending. Ties keep their relative
 * order so editing a label never reorders equal-time markers.
 * @param markers - Markers to sort
 */
export function sortMarkers(markers: readonly PlayerMarker[]): PlayerMarker[] {
	return [...markers].sort((a, b) => a.time - b.time);
}

/**
 * Adds a marker and returns a new, time-sorted list.
 * @param markers - Existing markers
 * @param marker - Marker to add
 */
export function addMarker(
	markers: readonly PlayerMarker[],
	marker: PlayerMarker,
): PlayerMarker[] {
	return sortMarkers([...markers, marker]);
}

/**
 * Removes the marker with the given id.
 * @param markers - Existing markers
 * @param id - Identifier to remove
 */
export function removeMarker(
	markers: readonly PlayerMarker[],
	id: string,
): PlayerMarker[] {
	return markers.filter((marker) => marker.id !== id);
}

/**
 * Applies a partial update to the marker with the given id, re-sorting
 * when the time changes.
 * @param markers - Existing markers
 * @param id - Identifier to update
 * @param patch - Fields to overwrite
 */
export function updateMarker(
	markers: readonly PlayerMarker[],
	id: string,
	patch: Partial<Omit<PlayerMarker, 'id'>>,
): PlayerMarker[] {
	const updated = markers.map((marker) =>
		marker.id === id ? { ...marker, ...patch } : marker,
	);
	return sortMarkers(updated);
}

/**
 * Returns the time-sorted chapters from a marker list.
 * @param markers - Markers to filter
 */
export function chapters(markers: readonly PlayerMarker[]): PlayerMarker[] {
	return sortMarkers(markers.filter((m) => m.kind === MARKER_KIND.chapter));
}

/**
 * Returns the start time of the next chapter after the given time, or
 * null when the time is at or past the last chapter.
 * @param sortedChapters - Chapters sorted by time ascending
 * @param time - Playback offset in seconds
 */
export function nextChapterTime(
	sortedChapters: readonly PlayerMarker[],
	time: number,
): number | null {
	for (const chapter of sortedChapters) {
		if (chapter.time > time + TIME_EPSILON_SECONDS) {
			return chapter.time;
		}
	}
	return null;
}

/**
 * Returns the target time for a "previous chapter" action: the start of
 * the current chapter when playback is past it, otherwise the start of
 * the preceding chapter, or null when already before the first chapter.
 * A small lead-in window means pressing "previous" just after a chapter
 * boundary jumps to the previous chapter rather than restarting the
 * current one.
 * @param sortedChapters - Chapters sorted by time ascending
 * @param time - Playback offset in seconds
 */
export function previousChapterTime(
	sortedChapters: readonly PlayerMarker[],
	time: number,
): number | null {
	let target: number | null = null;
	for (const chapter of sortedChapters) {
		if (chapter.time < time - CHAPTER_LEAD_IN_SECONDS) {
			target = chapter.time;
		} else {
			break;
		}
	}
	return target;
}

/**
 * Serializes markers to a plain array for JSON storage.
 * @param markers - Markers to serialize
 */
export function serializeMarkers(
	markers: readonly PlayerMarker[],
): PlayerMarker[] {
	return markers.map((marker) => ({
		id: marker.id,
		time: marker.time,
		label: marker.label,
		kind: marker.kind,
	}));
}

/**
 * Parses an unknown value (e.g. JSON from disk) into a valid marker
 * list, discarding entries that do not match the expected shape so a
 * corrupt or hand-edited store can never crash the player.
 * @param value - Raw parsed value
 */
export function parseMarkers(value: unknown): PlayerMarker[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: PlayerMarker[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const time = record.time;
		const label = record.label;
		const id = record.id;
		const kind = record.kind;
		if (
			typeof time !== 'number' ||
			!Number.isFinite(time) ||
			typeof id !== 'string' ||
			(kind !== MARKER_KIND.bookmark && kind !== MARKER_KIND.chapter)
		) {
			continue;
		}
		result.push({
			id,
			time: Math.max(0, time),
			label: typeof label === 'string' ? label : '',
			kind,
		});
	}
	return sortMarkers(result);
}

/**
 * The actions a marker-list row can carry, as named constants so the
 * dataset values written and read back by the view never drift (those
 * reads are plain strings the type system cannot check).
 */
export const MARKER_ROW_ACTION = {
	jump: 'jump',
	rename: 'rename',
	delete: 'delete',
} as const;

/** Action available on a marker-list row. */
export type MarkerRowAction =
	(typeof MARKER_ROW_ACTION)[keyof typeof MARKER_ROW_ACTION];

/**
 * A marker-list row. The same markers appear in every render mode,
 * ordered by time regardless of kind; only the available actions differ.
 */
export interface MarkerRow {
	id: string;
	time: number;
	label: string;
	kind: MarkerKind;
	/** Actions offered on this row. */
	actions: MarkerRowAction[];
	/**
	 * Length of this marker's segment - the gap to the next marker, or to
	 * the end of the track for the last marker - or null when unknown
	 * (e.g. the duration is not available yet).
	 */
	segmentSeconds: number | null;
}

/**
 * Builds the marker-list rows: one list ordered purely by timestamp
 * regardless of kind, identical in every render mode. Editing actions
 * (rename, delete) are offered only when editable; otherwise the row is
 * jump-only. Each row also carries its segment length. This is the single
 * source of truth for what the list shows, so reading view and Live
 * Preview never diverge on content or ordering.
 * @param markers - Markers to list
 * @param editable - Whether editing actions are available
 * @param durationSeconds - Track duration, used for the last segment
 */
export function markerRows(
	markers: readonly PlayerMarker[],
	editable: boolean,
	durationSeconds: number | null = null,
): MarkerRow[] {
	const actions: MarkerRowAction[] = editable
		? [
				MARKER_ROW_ACTION.jump,
				MARKER_ROW_ACTION.rename,
				MARKER_ROW_ACTION.delete,
			]
		: [MARKER_ROW_ACTION.jump];
	const sorted = sortMarkers(markers);
	return sorted.map((marker, index) => {
		const next = sorted[index + 1];
		let segmentSeconds: number | null = null;
		if (next) {
			segmentSeconds = Math.max(0, next.time - marker.time);
		} else if (durationSeconds !== null && durationSeconds > marker.time) {
			segmentSeconds = durationSeconds - marker.time;
		}
		return {
			id: marker.id,
			time: marker.time,
			label: marker.label,
			kind: marker.kind,
			actions: [...actions],
			segmentSeconds,
		};
	});
}

/**
 * Returns the index of the marker whose segment contains the given time
 * (the last marker at or before it), or -1 when the time precedes the
 * first marker. Used to highlight the currently-playing segment.
 * @param sortedMarkers - Markers sorted by time ascending
 * @param time - Playback offset in seconds
 */
export function activeMarkerIndex(
	sortedMarkers: readonly PlayerMarker[],
	time: number,
): number {
	let index = -1;
	for (let i = 0; i < sortedMarkers.length; i++) {
		if (sortedMarkers[i].time <= time + TIME_EPSILON_SECONDS) {
			index = i;
		} else {
			break;
		}
	}
	return index;
}
