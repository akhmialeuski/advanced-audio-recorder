/**
 * Shared factory helpers for creating player markers: id generation and
 * the default label scheme. Living in one module keeps the recording-time
 * marker capture and the in-player "add marker" action producing identical
 * ids and labels instead of drifting apart.
 * @module markers/markerFactory
 */

import { MARKER_KIND, type MarkerKind } from './markerModel';
import { randomToken } from '../utils/ids';

/**
 * Generates a short, collision-resistant marker id. Uses crypto.randomUUID
 * when available, falling back to a timestamp-and-random combination.
 */
export function generateMarkerId(): string {
	const cryptoApi = (
		activeWindow as Window & { crypto?: { randomUUID?: () => string } }
	).crypto;
	if (cryptoApi?.randomUUID) {
		return cryptoApi.randomUUID();
	}
	return `${String(Date.now())}-${randomToken()}`;
}

/**
 * Builds the default label for a new marker of the given kind, numbered
 * after the existing markers of the same kind (Bookmark/chapter counts are
 * independent). Accepts anything carrying a `kind` so both PlayerMarker
 * lists and recording-time drafts can be counted.
 * @param markers - Existing markers to count by kind
 * @param kind - Kind of the marker being created
 */
export function defaultMarkerLabel(
	markers: readonly { kind: MarkerKind }[],
	kind: MarkerKind,
): string {
	const sameKindCount = markers.filter(
		(marker) => marker.kind === kind,
	).length;
	return kind === MARKER_KIND.chapter
		? `Chapter ${String(sameKindCount + 1)}`
		: `Marker ${String(sameKindCount + 1)}`;
}
