/**
 * Measures and removes the drift of a part's timecodes, for an engine whose
 * model writes them rather than measuring them on the audio.
 *
 * Such a model keeps time well near the start of the audio it is given and
 * can lose it further on: on a 24-minute lesson, the middle part of two runs
 * of gemini-4-hydrogen ran 8 to 10 s late by its end, while the first lines
 * of every part stayed within about a second of the audio. A later part
 * hears the end of the part before it again, so the lines both answers hold
 * show how late the earlier part had become by the seam. Its lines are moved
 * back by that much at the seam and by nothing at its own start, in
 * proportion to the time elapsed in between, which halved the error of the
 * drifted part on both runs and left the parts that had kept time alone.
 * @module transcription/seamDrift
 */

import type { TranscriptSegment } from './TranscriptTypes';
import { similarity } from '../utils/similarity';

/**
 * Shortest line, in characters, that can show the same spoken line in two
 * answers. A short reply such as "Mhm." or "Tak, tak, tak." is in every
 * answer many times over, and opens many longer lines.
 */
const DRIFT_LINE_MIN_CHARS = 16;

/** How alike two lines' texts have to be to count as the same spoken line. */
const DRIFT_TEXT_SIMILARITY = 0.8;

/**
 * How far before the stretch both parts heard a line of the earlier part is
 * still looked at, in seconds: a drifted line sits away from where it was
 * spoken by as much as the drift.
 */
const DRIFT_SEARCH_SECONDS = 60;

/** How far two lines' measures of the drift may differ and still agree. */
const DRIFT_AGREEMENT_SECONDS = 2;

/**
 * Smallest drift that is corrected, in seconds. Two answers that both kept
 * time place a shared line up to about two seconds apart, as far as either
 * places it from the audio, so a smaller difference shows no drift.
 */
const DRIFT_MIN_SECONDS = 3;

/** A line with the recording's own seconds beside it. */
export interface PlacedLine {
	readonly segment: TranscriptSegment;
	readonly start: number;
	readonly end: number;
}

/** The stretch the later part heard again, on the recording's timeline. */
export interface SharedStretch {
	/** Where the later part's audio starts. */
	readonly from: number;
	/** Where the earlier part's audio ends. */
	readonly seam: number;
}

/**
 * The middle value of a list of numbers.
 * @param values - The numbers, at least one
 * @returns Their median
 */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * How alike two lines are where they start: the shorter one against as much
 * of the longer one. A line one answer splits in two starts where the other
 * answer's whole line starts, and it is the start that is compared.
 * @param a - One line's text
 * @param b - The other line's text
 * @returns Their similarity over the shorter one's length
 */
function openingSimilarity(a: string, b: string): number {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return similarity(shorter, longer.slice(0, shorter.length));
}

/**
 * How much later the earlier part places a line of the later part's lead-in.
 * @param line - A line of the later part's lead-in
 * @param earlier - The earlier part's lines near the stretch
 * @returns Seconds the earlier part is late by, or null when it holds no
 *   line alike enough to be the same one
 */
function lateness(
	line: PlacedLine,
	earlier: readonly PlacedLine[],
): number | null {
	let best: PlacedLine | null = null;
	let bestScore = DRIFT_TEXT_SIMILARITY;
	for (const candidate of earlier) {
		const score = openingSimilarity(
			candidate.segment.text.trim(),
			line.segment.text.trim(),
		);
		if (score >= bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best ? best.start - line.start : null;
}

/**
 * How many seconds late the earlier part had become by the seam, measured
 * on the lines both parts transcribed in the stretch the later one heard
 * again. Zero unless at least two lines agree on a drift of three seconds or
 * more, so a line matched by mistake, or the second or so two sound answers
 * differ by, moves nothing.
 * @param earlier - The earlier part's lines, as joined
 * @param later - The later part's lines
 * @param stretch - The stretch both heard
 * @returns The drift, negative when the earlier part ran early
 */
export function seamDrift(
	earlier: readonly PlacedLine[],
	later: readonly PlacedLine[],
	stretch: SharedStretch,
): number {
	const near = earlier.filter(
		(line) =>
			line.start >= stretch.from - DRIFT_SEARCH_SECONDS &&
			line.segment.text.trim().length >= DRIFT_LINE_MIN_CHARS,
	);
	const measures = later
		.filter(
			(line) =>
				line.start < stretch.seam &&
				line.segment.text.trim().length >= DRIFT_LINE_MIN_CHARS,
		)
		.map((line) => lateness(line, near))
		.filter((value): value is number => value !== null);
	if (measures.length === 0) {
		return 0;
	}
	const typical = median(measures);
	const agreeing = measures.filter(
		(value) => Math.abs(value - typical) <= DRIFT_AGREEMENT_SECONDS,
	);
	const drift = agreeing.length >= 2 ? median(agreeing) : 0;
	return Math.abs(drift) >= DRIFT_MIN_SECONDS ? drift : 0;
}

/**
 * The earlier part's lines with its drift taken out: a line is moved back by
 * the share of the drift that the time elapsed since the part's own start
 * makes up of the time up to the seam, so the first lines stay where they
 * are and the last ones move by the whole drift.
 * @param lines - The earlier part's lines, as joined
 * @param ownStart - Where the earlier part's own audio starts
 * @param seam - Where its audio ends
 * @param drift - How late it had become by the seam (see {@link seamDrift})
 * @returns The lines on the corrected timeline, the same ones for no drift
 */
export function withoutDrift(
	lines: readonly PlacedLine[],
	ownStart: number,
	seam: number,
	drift: number,
): PlacedLine[] {
	if (drift === 0 || seam <= ownStart) {
		return [...lines];
	}
	const shift = (at: number): number =>
		drift * Math.min(1, Math.max(0, (at - ownStart) / (seam - ownStart)));
	return lines.map((line) => {
		const startShift = shift(line.start);
		const endShift = shift(line.end);
		return {
			start: line.start - startShift,
			end: line.end - endShift,
			segment: {
				...line.segment,
				start: line.segment.start - startShift,
				end: line.segment.end - endShift,
			},
		};
	});
}
