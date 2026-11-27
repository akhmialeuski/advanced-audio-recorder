/**
 * How alike two strings are, for matching names and lines that two answers
 * of a model wrote a little differently.
 * @module utils/similarity
 */

/**
 * Normalized Levenshtein similarity in [0, 1], case-insensitive: 1 for equal
 * strings, 0 for nothing in common. Cheap two-row dynamic programming, ample
 * for term-sized inputs.
 * @param a - First string
 * @param b - Second string
 * @returns Similarity ratio
 */
export function similarity(a: string, b: string): number {
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	if (left === right) {
		return 1;
	}
	// Two empty strings are equal, so the check above already returned for
	// them: maxLength is positive from here and the division below is safe.
	const maxLength = Math.max(left.length, right.length);
	let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 1; i <= left.length; i++) {
		previous = nextRow(previous, left[i - 1], right, i);
	}
	return 1 - (previous[right.length] ?? 0) / maxLength;
}

/**
 * One row of the edit-distance table: the distance from the left string's
 * first characters, through the given one, to every prefix of the right one.
 * @param previous - The row for the left string's characters before this one
 * @param char - The left string's character this row adds
 * @param right - The right string
 * @param index - How many left characters the row covers
 * @returns The new row
 */
function nextRow(
	previous: readonly number[],
	char: string | undefined,
	right: string,
	index: number,
): number[] {
	const current = [index];
	for (let j = 1; j <= right.length; j++) {
		current[j] = Math.min(
			(previous[j] ?? 0) + 1,
			(current[j - 1] ?? 0) + 1,
			(previous[j - 1] ?? 0) + (char === right[j - 1] ? 0 : 1),
		);
	}
	return current;
}
