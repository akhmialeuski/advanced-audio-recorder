/**
 * Judges a part's transcript against the stretch of the recording it was sent
 * for, for an engine whose timecodes are written by the model rather than
 * measured on the audio. Such a model can place lines past the end of the
 * audio it was given, or stop well before it, and neither shows as an error:
 * the answer parses, and the lines land on the recording's timeline at the
 * wrong place or not at all. Kept pure so the bounds are tested on their own,
 * apart from the run that decides what to do about them.
 * @module transcription/partTimeline
 */

import type { TranscriptSegment } from './TranscriptTypes';
import { formatTimecode } from '../utils/TimeUtils';

/**
 * How far past the end of its part a line may end, in seconds, before the
 * answer is judged to have left the part. A last line rounded up to the next
 * second, or ending on the final breath, is the model being imprecise rather
 * than shifted.
 */
export const PART_OVERRUN_TOLERANCE_SECONDS = 5;

/**
 * Longest stretch at the end of a part, in seconds, that may go without a
 * line before the answer is judged to have stopped early. A pause of a
 * minute inside a conversation is rare, while a model that lost the second
 * half of a part leaves minutes.
 */
export const PART_SILENT_TAIL_MAX_SECONDS = 60;

/** The stretch of the recording a part covers, as the judgement needs it. */
export interface PartSpan {
	/** How long the part is, in seconds. */
	readonly durationSeconds: number;
	/**
	 * Whether the part ends where the recording does. A recording often runs
	 * on after the conversation ends, so its last part is never judged short.
	 */
	readonly isLast: boolean;
}

/** The ways an answer can disagree with the part it was sent for. */
export const TimelineFaultKind = {
	/** A line ends past the end of the part. */
	Overrun: 'overrun',
	/** The lines stop well before the end of the part. */
	Short: 'short',
} as const;

/** One way an answer disagrees (derived from {@link TimelineFaultKind}). */
export type TimelineFaultKind =
	(typeof TimelineFaultKind)[keyof typeof TimelineFaultKind];

/** What was wrong with an answer, in the part's own seconds. */
export interface TimelineFault {
	readonly kind: TimelineFaultKind;
	/** Where the answer's lines end, in seconds from the start of the part. */
	readonly reachedSeconds: number;
}

/**
 * Says whether a part's lines stay inside it and reach close to its end.
 * @param segments - The part's lines, timed from the start of the part
 * @param span - The part they were transcribed from
 * @returns What is wrong with them, or null when nothing is
 */
export function judgePartTimeline(
	segments: readonly TranscriptSegment[],
	span: PartSpan,
): TimelineFault | null {
	const reachedSeconds = Math.max(
		0,
		...segments.map((segment) => segment.end),
	);
	if (
		reachedSeconds >
		span.durationSeconds + PART_OVERRUN_TOLERANCE_SECONDS
	) {
		return { kind: TimelineFaultKind.Overrun, reachedSeconds };
	}
	if (
		!span.isLast &&
		span.durationSeconds - reachedSeconds > PART_SILENT_TAIL_MAX_SECONDS
	) {
		return { kind: TimelineFaultKind.Short, reachedSeconds };
	}
	return null;
}

/**
 * The lines that start inside the part, each ending at its end at the latest.
 * What is left of an answer that overran: a line placed past the end of the
 * audio cannot be put anywhere on the recording that is known to be right.
 * @param segments - The part's lines, timed from the start of the part
 * @param durationSeconds - How long the part is
 * @returns The lines that fit
 */
export function trimToPart(
	segments: readonly TranscriptSegment[],
	durationSeconds: number,
): TranscriptSegment[] {
	return segments
		.filter((segment) => segment.start < durationSeconds)
		.map((segment) =>
			segment.end > durationSeconds
				? { ...segment, end: durationSeconds }
				: segment,
		);
}

/**
 * What became of the request that sent a part again. When it came back, the
 * reason names what was wrong with the first answer too. When it failed, the
 * first answer is the one kept and the reason names the failure.
 */
export type SecondAttempt =
	{ readonly firstFault: TimelineFault } | { readonly retryFailure: string };

/**
 * The reason a part is reported with once its answer is kept although it
 * does not fit, in the words the note and the notice show.
 * @param fault - What was wrong with the answer that was kept
 * @param span - The part it was sent for
 * @param engine - The engine's name, as the user knows it
 * @param attempt - The fault of the first answer when the second came back,
 *   or why sending the part again failed when the first answer is kept
 * @returns The sentence naming the fault and what was kept, followed by the
 *   failure of the second request when there was one
 */
export function timelineFaultMessage(
	fault: TimelineFault,
	span: PartSpan,
	engine: string,
	attempt: SecondAttempt,
): string {
	const first = 'firstFault' in attempt ? attempt.firstFault : fault;
	const reference = Math.max(
		fault.reachedSeconds,
		first.reachedSeconds,
		span.durationSeconds,
	);
	const at = (seconds: number): string => formatTimecode(seconds, reference);
	const length = at(span.durationSeconds);
	let attempts: string;
	if ('retryFailure' in attempt) {
		attempts = 'and sending the part again failed';
	} else if (first.kind === fault.kind) {
		attempts = 'on both attempts';
	} else {
		attempts =
			first.kind === TimelineFaultKind.Overrun
				? `after a first answer that placed lines up to ${at(first.reachedSeconds)}`
				: `after a first answer that stopped at ${at(first.reachedSeconds)}`;
	}
	const sentence =
		fault.kind === TimelineFaultKind.Overrun
			? `${engine} placed lines up to ${at(fault.reachedSeconds)} in a part ${length} long, ${attempts}, so the lines past ${length} were dropped.`
			: `${engine} stopped at ${at(fault.reachedSeconds)} in a part ${length} long, ${attempts}, so the rest of the part may be missing.`;
	return 'retryFailure' in attempt
		? `${sentence} ${attempt.retryFailure}`
		: sentence;
}
