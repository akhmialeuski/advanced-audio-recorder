/**
 * A part a run could not transcribe, and what the user is told about it.
 *
 * A multi-part run salvages what it got: parts that failed are recorded rather
 * than throwing away a transcript the user already paid for. That makes the
 * failure list a result of the run, carried alongside the transcript, and it is
 * read in four places - the warning prepended to the note, the notice raised
 * once, the check that decides whether an advanced second pass came back
 * whole, and the record the recording's sidecar keeps so those parts can be
 * asked for again later. It is declared here so all four read the same shape.
 * @module transcription/partFailure
 */

/**
 * A stretch of a recording, in seconds from its start.
 *
 * The unit a top-up works in: the parts that failed are recorded as bounds,
 * exactly those bounds are sent again, and exactly those are replaced in the
 * transcript. Named here beside {@link PartFailure}, which is where every one
 * of them comes from.
 */
export interface RecordingRange {
	/** Where the stretch begins, in seconds. */
	startSeconds: number;
	/** Where it ends, in seconds. */
	endSeconds: number;
}

/**
 * Whether a timed span reaches into a stretch, which is how a top-up decides
 * what came back for the stretch and what the stretch held before.
 * @param span - Start and end of the span, in seconds
 * @param range - The stretch
 */
export function overlapsRange(
	span: { start: number; end: number },
	range: RecordingRange,
): boolean {
	return span.start < range.endSeconds && span.end > range.startSeconds;
}

/**
 * A part the run could not transcribe, named the way the user sees it and
 * carrying the reason the engine gave.
 */
export interface PartFailure {
	/** How the part is named to the user, e.g. a time range. */
	label: string;
	/** What the engine said went wrong. */
	message: string;
	/** Where the part starts on the recording timeline, in seconds. */
	startSeconds: number;
	/**
	 * Where it ends on that timeline. Absent on the whole-file path, whose
	 * true duration is never measured, and a part with no end is one that
	 * cannot be asked for again on its own.
	 */
	endSeconds?: number;
}

/** The two sentences a run with missing parts owes the user. */
export interface MissingPartsWarning {
	/** Callout prepended to the transcript, so the gap is visible in the note. */
	callout: string;
	/** Notice raised once, naming the parts and the first reason. */
	notice: string;
}

/**
 * How the incomplete-transcription callout opens. A top-up finds the callout
 * in a note by it, so the warning it writes and the one it replaces can never
 * drift apart.
 */
export const MISSING_PARTS_CALLOUT_HEAD =
	'> [!warning] Transcription incomplete:';

/** Said for a part whose engine gave no reason at all. */
const NO_REASON = 'The engine gave no reason.';

/**
 * One line of the callout naming a part and why it is missing. The reason is
 * kept on one line, because a line break in it would end the callout there.
 * @param part - The part that went missing
 * @returns The callout line
 */
function reasonLine(part: PartFailure): string {
	const label = part.label.charAt(0).toUpperCase() + part.label.slice(1);
	const reason = part.message.replace(/\s+/g, ' ').trim() || NO_REASON;
	return `> - ${label}: ${reason}\n`;
}

/**
 * Describes the parts that went missing, or nothing when none did.
 *
 * The callout names the reason of every part, because it is the one place the
 * reason stays in front of the user: the notice that also carries it is gone
 * a few seconds later.
 *
 * The callout is prepended only after post-processing: a cleanup or custom LLM
 * pass replaces the whole body and would otherwise strip the warning out of the
 * note it belongs to.
 * @param missingParts - Parts the run could not transcribe
 * @returns The callout and the notice, or null when the run was complete
 */
export function missingPartsWarning(
	missingParts: readonly PartFailure[],
): MissingPartsWarning | null {
	if (missingParts.length === 0) {
		return null;
	}
	const labels = missingParts.map((part) => part.label).join(', ');
	const verb = missingParts.length > 1 ? 'are' : 'is';
	return {
		callout:
			// "In whole or in part", because a part whose answer left its
			// bounds keeps the lines that fit and is listed here as well.
			`${MISSING_PARTS_CALLOUT_HEAD} ${labels} ${verb} ` +
			'missing from the transcript below, in whole or in part.\n' +
			missingParts.map(reasonLine).join('') +
			'\n',
		notice:
			`Some audio is missing from the transcript, in whole or in part ` +
			`(${labels}); saving what came back. ` +
			(missingParts[0]?.message ?? ''),
	};
}
