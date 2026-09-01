/**
 * Control keys for the rows that address an entry of a list rather than a
 * settings property.
 *
 * A track and a profile are entries, so their rows cannot be keyed by a
 * property name the way every other row is. Both encode the entry they address
 * into the key itself, and both need to be read back out of it when a value is
 * written, so the pair of builder and parser lives together here and is
 * re-exported from the definitions module the tab already imports.
 * @module settings/sections/controlKeys
 */

/** Highest track count the multi-track section offers. */
export const MAX_TRACK_COUNT = 8;

/** One field of a track's audio source that a settings row addresses. */
export type TrackControlField = 'deviceId' | 'channelMode' | 'gainDb' | 'pan';

/** Control key for one field of one track's audio source. */
export const trackControlKey = (
	track: number,
	field: TrackControlField,
): string => `track.${String(track)}.${field}`;

/**
 * Reads a track control key back into the track and field it addresses.
 * @param key - A key produced by {@link trackControlKey}
 * @returns The track number and field, or undefined for any other key
 */
export function parseTrackControlKey(
	key: string,
): { track: number; field: TrackControlField } | undefined {
	const match = /^track\.(\d+)\.(deviceId|channelMode|gainDb|pan)$/.exec(key);
	if (!match) {
		return undefined;
	}
	return {
		track: Number(match[1]),
		field: match[2] as TrackControlField,
	};
}

/**
 * Control key for one field of one profile. A profile is an entry in a stored
 * list rather than a settings property, so the key carries the id of the entry
 * it addresses, the way a track control key carries its track number.
 * @param base - Key naming the field, e.g. `dictionaryProfile.terms`
 * @param id - Id of the profile the field belongs to
 */
export const profileControlKey = (base: string, id: string): string =>
	`${base}#${id}`;

/**
 * Reads a profile control key back into the field and the profile it addresses.
 * @param key - A key produced by {@link profileControlKey}
 * @returns The base key and the profile id, or undefined for any other key
 */
export function parseProfileControlKey(
	key: string,
): { base: string; id: string } | undefined {
	const separator = key.indexOf('#');
	if (separator <= 0 || separator === key.length - 1) {
		return undefined;
	}
	return {
		base: key.slice(0, separator),
		id: key.slice(separator + 1),
	};
}
