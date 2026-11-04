/**
 * Turning free text into something a vault path can carry.
 *
 * Two callers need the same thing for different reasons: a recording named
 * from a template, and a split part named after the chapter it holds. One
 * rule for both, so a character that is safe in one place cannot be unsafe in
 * the other.
 * @module utils/fileNames
 */

/** Characters a vault path cannot carry, in any of the platforms Obsidian runs on. */
const ILLEGAL_PATH_CHARACTERS = /[\\/:*?"<>|]/g;

/**
 * Replaces the characters a file name cannot hold with a dash.
 *
 * The dot is left alone: it is legal inside a name, and the callers that care
 * about the extension boundary handle it themselves.
 * @param text - Free text to put in a file name
 * @returns The text with the illegal characters replaced
 */
export function sanitizeFileNameSegment(text: string): string {
	return text.replace(ILLEGAL_PATH_CHARACTERS, '-');
}

/**
 * Turns free text into a file-name segment: illegal characters replaced, dots
 * folded in (a dot would read as an extension boundary), and the run of
 * separators collapsed so a title of punctuation does not become a row of
 * dashes.
 * @param text - Free text, such as a chapter title
 * @param fallback - What to use when nothing usable survives
 * @returns A segment safe to put in a file name
 */
export function toFileNameSegment(text: string, fallback: string): string {
	return foldSeparators(
		sanitizeFileNameSegment(text).replace(/\./g, '-'),
		fallback,
	);
}

/**
 * Collapses a run of dashes into one and trims the dashes and spaces off both
 * ends, so a name built from parts that may be empty never shows the seam.
 * @param text - Text whose separators to fold
 * @param fallback - What to use when nothing is left
 * @returns The folded text
 */
export function foldSeparators(text: string, fallback: string): string {
	const folded = text
		.replace(/-+/g, '-')
		.replace(/^[\s-]+|[\s-]+$/g, '')
		.trim();
	return folded || fallback;
}

/**
 * Size of a text as UTF-8 bytes, which is what a file system that counts
 * bytes limits a name by. Counted by code point, so it needs no `TextEncoder`,
 * which a test environment may not provide.
 * @param text - Any text
 * @returns Its length in bytes
 */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (const character of text) {
		// A character of two UTF-16 units is a surrogate pair, which is four
		// bytes. A lone surrogate counts as three, the size of its replacement.
		if (character.length === 2) {
			bytes += 4;
			continue;
		}
		const code = character.charCodeAt(0);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * Cuts a text to at most the given number of UTF-8 bytes, never in the middle
 * of a character.
 * @param text - Text to cut
 * @param maxBytes - The most bytes the result may take
 * @returns The longest start of the text that fits
 */
export function truncateToBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = '';
	for (const character of text) {
		bytes += utf8ByteLength(character);
		if (bytes > maxBytes) {
			break;
		}
		result += character;
	}
	return result;
}

/**
 * Makes a name unique among those already taken, by appending a number.
 *
 * Two chapters can carry the same title, and two files cannot carry the same
 * name; numbering the second is what lets a recording be split by chapters
 * whatever the user called them.
 * @param name - The name wanted
 * @param taken - The names already used; the returned one is added to it
 * @returns The name, numbered when it was already taken
 */
export function uniqueName(name: string, taken: Set<string>): string {
	let candidate = name;
	let counter = 2;
	while (taken.has(candidate)) {
		candidate = `${name}-${String(counter)}`;
		counter++;
	}
	taken.add(candidate);
	return candidate;
}
