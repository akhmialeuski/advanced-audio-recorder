/**
 * Marker and chapter data model for the enhanced audio player. A marker
 * is a labelled point in time; a chapter is a labelled point that also
 * acts as the start of a navigable segment. Both share one structure and
 * differ only by `kind`, which keeps storage and editing uniform while
 * letting the player present them differently.
 *
 * Every function here is pure (no DOM, no I/O) so the ordering,
 * navigation, and (de)serialization logic can be unit tested directly.
 * @module markers/markerModel
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
 * The colours a marker may carry.
 *
 * A closed set rather than a free colour: the list is drawn against the
 * reader's theme, and a chosen colour has to stay legible on both. Each name
 * maps to one of Obsidian's own accent variables in the stylesheet, so a marker
 * looks like part of the app rather than like a swatch pasted onto it.
 */
export const MARKER_COLORS = [
	'red',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
] as const;

/** One of {@link MARKER_COLORS}. */
export type MarkerColor = (typeof MARKER_COLORS)[number];

/**
 * Whether a value is one of the offered colours.
 * @param value - Value to test
 */
export function isMarkerColor(value: unknown): value is MarkerColor {
	return (
		typeof value === 'string' &&
		(MARKER_COLORS as readonly string[]).includes(value)
	);
}

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
	/**
	 * Free-form note explaining why the marker is here. Absent on a marker
	 * that carries none, so a file written by an older version round-trips
	 * unchanged and an empty marker list stays empty.
	 */
	note?: string;
	/** Colour shown on the timeline and in the list, when one was chosen. */
	color?: MarkerColor;
}

/**
 * A partial change to a marker.
 *
 * Written out rather than derived from `Partial` because the two optional
 * fields have to be clearable, and with exactOptionalPropertyTypes on that
 * needs an explicit undefined the derived type refuses.
 */
export interface MarkerPatch {
	/** New offset in seconds. */
	time?: number;
	/** New label. */
	label?: string;
	/** New kind. */
	kind?: MarkerKind;
	/** New note, or undefined to clear it. */
	note?: string | undefined;
	/** New colour, or undefined to clear it. */
	color?: MarkerColor | undefined;
}

/**
 * Applies a patch to one marker.
 *
 * Built field by field rather than spread, because a spread cannot express the
 * difference between "leave the note alone" and "remove it": both arrive as an
 * absent value, and only the presence of the key tells them apart.
 * @param marker - The marker to change
 * @param patch - Fields to overwrite, with undefined clearing a nullable one
 * @returns The changed marker
 */
function applyPatch(marker: PlayerMarker, patch: MarkerPatch): PlayerMarker {
	const note = 'note' in patch ? patch.note : marker.note;
	const color = 'color' in patch ? patch.color : marker.color;
	return {
		id: marker.id,
		time: patch.time ?? marker.time,
		label: patch.label ?? marker.label,
		kind: patch.kind ?? marker.kind,
		...(note !== undefined ? { note } : {}),
		...(color !== undefined ? { color } : {}),
	};
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
	patch: MarkerPatch,
): PlayerMarker[] {
	const updated = markers.map((marker) =>
		marker.id === id ? applyPatch(marker, patch) : marker,
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
		// Written only when set, so a marker made by an older version comes
		// back byte for byte and an otherwise empty sidecar stays empty.
		...(marker.note !== undefined ? { note: marker.note } : {}),
		...(marker.color !== undefined ? { color: marker.color } : {}),
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
		const note = record.note;
		const color = record.color;
		result.push({
			id,
			time: Math.max(0, time),
			label: typeof label === 'string' ? label : '',
			kind,
			// A field the file does not carry stays absent rather than
			// becoming an empty string, which is what keeps a marker written
			// by an older version identical after a read and a write.
			...(typeof note === 'string' && note !== '' ? { note } : {}),
			...(isMarkerColor(color) ? { color } : {}),
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
	editTime: 'edit-time',
	useCurrentTime: 'use-current-time',
	editNote: 'edit-note',
	setColor: 'set-color',
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
	/** The marker's note, when it carries one. */
	note?: string;
	/** The marker's colour, when one was chosen. */
	color?: MarkerColor;
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
				MARKER_ROW_ACTION.editTime,
				MARKER_ROW_ACTION.useCurrentTime,
				MARKER_ROW_ACTION.editNote,
				MARKER_ROW_ACTION.setColor,
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
			...(marker.note !== undefined ? { note: marker.note } : {}),
			...(marker.color !== undefined ? { color: marker.color } : {}),
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
		const marker = sortedMarkers[i];
		if (!marker) {
			break;
		}
		if (marker.time <= time + TIME_EPSILON_SECONDS) {
			index = i;
		} else {
			break;
		}
	}
	return index;
}

/** The stretch of a recording one chapter covers. */
export interface ChapterSpan {
	/** Start of the chapter, in seconds. */
	start: number;
	/**
	 * Start of the following chapter, or null for the last one, whose end is
	 * the end of the recording and is therefore not a marker time.
	 */
	end: number | null;
}

/**
 * Returns the chapter containing the given time, as the stretch it covers.
 * Null when the time falls before the first chapter, which is the answer for
 * a recording with no chapters at all.
 * @param sortedChapters - Chapters sorted by time ascending
 * @param time - Playback offset in seconds
 */
export function chapterSpan(
	sortedChapters: readonly PlayerMarker[],
	time: number,
): ChapterSpan | null {
	const index = activeMarkerIndex(sortedChapters, time);
	const current = index < 0 ? undefined : sortedChapters[index];
	if (!current) {
		return null;
	}
	return {
		start: current.time,
		end: sortedChapters[index + 1]?.time ?? null,
	};
}
