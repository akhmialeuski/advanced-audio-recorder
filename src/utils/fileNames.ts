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
	const cleaned = sanitizeFileNameSegment(text)
		.replace(/\./g, '-')
		.replace(/-+/g, '-')
		.replace(/^[\s-]+|[\s-]+$/g, '')
		.trim();
	return cleaned || fallback;
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
