/**
 * Transcript fixtures shared by the suites that work on a written transcript.
 * @module tests/helpers/transcriptFixtures
 */

import type { TranscriptWord } from 'src/transcription/TranscriptTypes';

/**
 * Word timings for a text, one second per word, starting at the given offset,
 * so a test can say exactly where each word is spoken.
 * @param text - Words separated by single spaces
 * @param from - Offset of the first word, in seconds
 * @returns One timing per word
 */
export function wordsOf(text: string, from: number): TranscriptWord[] {
	return text.split(' ').map((word, index) => ({
		start: from + index,
		end: from + index + 1,
		text: word,
	}));
}

/** A link as the metadata cache lists it, on one line of a note. */
export interface CachedLinkFixture {
	link: string;
	position: {
		start: { line: number; col: number; offset: number };
		end: { line: number; col: number; offset: number };
	};
}

/**
 * A link the metadata cache lists for a note, such as the timecode link a
 * transcript line starts with.
 * @param link - The link target, subpath included (`rec.m4a#t=5`)
 * @param line - Zero-based line it is on
 * @param startCol - Column it starts at
 * @param endCol - Column just past it
 * @returns The cached link
 */
export function cachedLink(
	link: string,
	line: number,
	startCol: number,
	endCol: number,
): CachedLinkFixture {
	return {
		link,
		position: {
			start: { line, col: startCol, offset: 0 },
			end: { line, col: endCol, offset: 0 },
		},
	};
}
