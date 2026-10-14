/**
 * Adds one marker to a recording's sidecar, from outside any player: the
 * player's own menu, the palette over the playing position, the command line
 * at a typed time. The id and the default label come from the same factory
 * the player's own add uses, so a marker added any of these ways is
 * indistinguishable from one added with the player's button.
 * @module markers/addRecordingMarker
 */

import { addMarker, type MarkerKind, type PlayerMarker } from './markerModel';
import { defaultMarkerLabel, generateMarkerId } from './markerFactory';
import type { RecordingSidecarStore } from '../sidecar/RecordingSidecarStore';

/**
 * Adds a marker at a time, numbered after the markers the sidecar holds
 * when the write runs rather than when it was asked for, so two adds in a
 * row never carry the same default label.
 * @param store - The sidecar store
 * @param path - Vault path of the recording
 * @param seconds - Where the marker goes; a negative time is clamped to 0
 * @param kind - Bookmark or chapter
 * @param label - The label, or null for the default one
 * @returns The marker as written
 * @throws When the sidecar refused the write
 */
export async function addRecordingMarker(
	store: Pick<RecordingSidecarStore, 'updateMarkers'>,
	path: string,
	seconds: number,
	kind: MarkerKind,
	label: string | null,
): Promise<PlayerMarker> {
	const id = generateMarkerId();
	const time = Math.max(0, seconds);
	// Set inside the write, where the markers it is numbered after are read.
	let written = label ?? '';
	await store.updateMarkers(path, (markers) => {
		written = label ?? defaultMarkerLabel(markers, kind);
		return addMarker(markers, { id, time, label: written, kind });
	});
	return { id, time, label: written, kind };
}
