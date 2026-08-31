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
 * Describes the parts that went missing, or nothing when none did.
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
			`> [!warning] Transcription incomplete: ${labels} could not ` +
			`be transcribed and ${verb} missing below.\n\n`,
		notice:
			`Some audio could not be transcribed (${labels}) and is missing ` +
			'from the transcript; saving the parts that succeeded. ' +
			(missingParts[0]?.message ?? ''),
	};
}
