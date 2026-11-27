/**
 * Joins the parts of a recording whose later parts were each sent with the
 * end of the part before them. An engine that numbers speakers per request
 * calls the same person "Speaker 2" in one part and "Olga" in the next, and
 * nothing in either answer says so. The stretch both requests heard does:
 * whoever speaks in it speaks at the same seconds in both answers, so the
 * later part's labels are renamed to the earlier part's, and the stretch is
 * then kept once. Kept pure so the matching is tested on its own, apart from
 * the run that sends the parts.
 * @module transcription/partSeams
 */

import type { Transcript, TranscriptSegment } from './TranscriptTypes';
import { buildTranscript } from './transcriptModel';

/**
 * How close to the seam a line of the later part has to end, in seconds, to
 * be the line the seam fell in. A model times a line to the second, so a line
 * that ends on the seam may be written half a second short of it.
 */
const SEAM_REACH_SECONDS = 0.5;

/** Label an engine gives a speaker it did not name, before its number. */
const SPEAKER_LABEL_PREFIX = 'Speaker ';

/** One transcribed part, as much of it as joining needs. */
export interface SeamPart {
	/** Where the audio this part was sent with starts, on the recording. */
	readonly offsetSeconds: number;
	/** How much of that audio belongs to the part before it. */
	readonly leadInSeconds?: number;
	/** Where the part ends on the recording, when it was measured. */
	readonly endSeconds?: number;
	/** The part's lines, timed from {@link offsetSeconds}. */
	readonly transcript: Transcript;
}

/** A line with the recording's own seconds beside it. */
interface PlacedLine {
	readonly segment: TranscriptSegment;
	readonly start: number;
	readonly end: number;
}

/**
 * Puts a part's lines on the recording's timeline.
 * @param part - The transcribed part
 * @returns Its lines with their seconds from the start of the recording
 */
function placed(part: SeamPart): PlacedLine[] {
	return part.transcript.segments.map((segment) => ({
		segment,
		start: segment.start + part.offsetSeconds,
		end: segment.end + part.offsetSeconds,
	}));
}

/**
 * How long each label of the later part speaks at the same time as each
 * label of the earlier part, inside the stretch both parts heard.
 * @param earlier - The earlier part's lines, already renamed
 * @param later - The later part's lines
 * @param from - Where the shared stretch starts
 * @param to - Where it ends
 * @returns Seconds spoken together, by later label and then earlier label
 */
function sharedSeconds(
	earlier: readonly PlacedLine[],
	later: readonly PlacedLine[],
	from: number,
	to: number,
): Map<string, Map<string, number>> {
	const shared = new Map<string, Map<string, number>>();
	for (const next of later) {
		const nextLabel = next.segment.speaker;
		if (!nextLabel) {
			continue;
		}
		for (const previous of earlier) {
			const previousLabel = previous.segment.speaker;
			if (!previousLabel) {
				continue;
			}
			const seconds =
				Math.min(next.end, previous.end, to) -
				Math.max(next.start, previous.start, from);
			if (seconds <= 0) {
				continue;
			}
			const row = shared.get(nextLabel) ?? new Map<string, number>();
			row.set(previousLabel, (row.get(previousLabel) ?? 0) + seconds);
			shared.set(nextLabel, row);
		}
	}
	return shared;
}

/**
 * Pairs the labels that speak together the longest, each label once.
 * @param shared - Seconds spoken together (see {@link sharedSeconds})
 * @returns The earlier part's label for each later label that was matched
 */
function pairBySharedSeconds(
	shared: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, string> {
	const candidates: { later: string; earlier: string; seconds: number }[] =
		[];
	for (const [later, row] of shared) {
		for (const [earlier, seconds] of row) {
			candidates.push({ later, earlier, seconds });
		}
	}
	candidates.sort((a, b) => b.seconds - a.seconds);
	const renamed = new Map<string, string>();
	const taken = new Set<string>();
	for (const { later, earlier } of candidates) {
		if (!renamed.has(later) && !taken.has(earlier)) {
			renamed.set(later, earlier);
			taken.add(earlier);
		}
	}
	return renamed;
}

/**
 * The first "Speaker N" nobody is called yet.
 * @param used - Every label already in use
 * @returns A label not among them
 */
function freshLabel(used: ReadonlySet<string>): string {
	for (let number = 1; ; number++) {
		const label = `${SPEAKER_LABEL_PREFIX}${String(number)}`;
		if (!used.has(label)) {
			return label;
		}
	}
}

/**
 * The one item of a list that holds exactly one.
 * @param items - The list
 * @returns Its item, or undefined when it holds none or several
 */
function only<T>(items: readonly T[]): T | undefined {
	return items.length === 1 ? items[0] : undefined;
}

/**
 * Decides what the labels of a later part are called in the joined
 * transcript. A label missing from the answer keeps its own name.
 *
 * A label heard in the shared stretch takes the name of whoever spoke at the
 * same seconds in the earlier part. One label left over on each side is the
 * same person by elimination: a lesson has two voices, and when the stretch
 * held only one of them the other is all that is left. Any other label keeps
 * its own name, unless a matched label has just been given that name, in
 * which case it gets a number nobody has. With nothing matched there is
 * nothing to go by, and every label stays as it is.
 * @param known - Every label of the parts already joined
 * @param laterLabels - Every label of the later part
 * @param matched - Labels matched in the shared stretch
 * @returns The joined transcript's label for each label that changes
 */
function renameLabels(
	known: ReadonlySet<string>,
	laterLabels: readonly string[],
	matched: ReadonlyMap<string, string>,
): Map<string, string> {
	const renamed = new Map(matched);
	if (matched.size === 0) {
		return renamed;
	}
	const taken = new Set(matched.values());
	const unmatched = laterLabels.filter((label) => !renamed.has(label));
	const lone = only(unmatched);
	const spare = only([...known].filter((label) => !taken.has(label)));
	if (lone !== undefined && spare !== undefined) {
		renamed.set(lone, spare);
		return renamed;
	}
	const used = new Set([...known, ...laterLabels]);
	for (const label of unmatched) {
		if (taken.has(label)) {
			const fresh = freshLabel(used);
			used.add(fresh);
			renamed.set(label, fresh);
		}
	}
	return renamed;
}

/** For a part whose labels stay as they are. */
const NO_RENAMES: ReadonlyMap<string, string> = new Map();

/**
 * Rebuilds a part from the lines kept for it.
 * @param part - The part as it was transcribed
 * @param lines - The lines it keeps
 * @param renamed - What its labels are called from here on
 * @returns The part with those lines
 */
function rebuilt<T extends SeamPart>(
	part: T,
	lines: readonly PlacedLine[],
	renamed: ReadonlyMap<string, string>,
): T {
	const segments = lines.map(({ segment }) => {
		const speaker = segment.speaker && renamed.get(segment.speaker);
		return speaker ? { ...segment, speaker } : segment;
	});
	return {
		...part,
		transcript: { ...part.transcript, ...buildTranscript(segments) },
	};
}

/** The parts joined so far, and what the next one is matched against. */
interface Joined<T> {
	/** The joined parts, in timeline order (mutated). */
	readonly parts: T[];
	/** Every label the joined parts use (mutated). */
	readonly known: Set<string>;
	/** The lines of the last part, as joined, before any later part trims it. */
	lines: PlacedLine[];
	/** Where the last part ends on the recording, when it was measured. */
	endSeconds: number | undefined;
}

/**
 * Where the earlier part's line that the seam cut starts: the earliest start
 * of its lines that reach the seam, but no earlier than the later part's
 * audio, which cannot repeat what it never heard.
 *
 * When none of its lines reaches the seam, the earlier part is trusted only
 * up to where its lines end. A part that ran late placed its last sentence
 * past its own end, where it was trimmed away, so the stretch between its
 * last line and the seam is held by the later part alone.
 * @param earlier - The earlier part's lines, as joined
 * @param from - Where the later part's audio starts
 * @param seam - Where the earlier part's audio ends
 * @returns Where the later part should take over from, at the latest
 */
function cutLineStart(
	earlier: readonly PlacedLine[],
	from: number,
	seam: number,
): number {
	const heldUntil = earlier.reduce(
		(last, line) => Math.max(last, line.end),
		earlier.length > 0 ? from : seam,
	);
	const start = earlier
		.filter((line) => line.end > seam - SEAM_REACH_SECONDS)
		.reduce(
			(first, line) => Math.min(first, line.start),
			Math.min(seam, heldUntil),
		);
	return Math.max(start, from);
}

/**
 * The later part's lines from the first one that reaches a point on.
 * @param lines - The later part's lines
 * @param point - Where the earlier part stops being trusted
 * @returns Where the later part takes over, and the lines it keeps
 */
function takenOver(
	lines: readonly PlacedLine[],
	point: number,
): { takeover: number; kept: PlacedLine[] } {
	const takeover =
		lines.find((line) => line.end > point - SEAM_REACH_SECONDS)?.start ??
		point;
	return { takeover, kept: lines.filter((line) => line.start >= takeover) };
}

/**
 * Joins a part to the parts before it across the lead-in they share.
 *
 * The seam is moved to a line break. The earlier part's audio ends at the
 * seam, so the line spoken across it is cut off there, while the later part
 * heard that line whole in its lead-in, and may have split it in two. The
 * later part therefore takes over from the first of its lines that reaches
 * where the cut line starts, and the earlier part gives up the lines that
 * mostly lie after that point.
 *
 * A part whose earlier neighbour is missing (a part that failed, or a run
 * that asked for some stretches only) has nothing to be matched against: its
 * labels stay as they are and its lead-in is dropped.
 * @param joined - The parts joined so far
 * @param part - The part to join, which has a lead-in
 * @param leadIn - How long its lead-in is, in seconds
 * @returns The part as it joins: renamed, and without its lead-in
 */
function acrossSeam<T extends SeamPart>(
	joined: Joined<T>,
	part: T,
	leadIn: number,
): T {
	const lines = placed(part);
	const seam = part.offsetSeconds + leadIn;
	const earlier = joined.parts.at(-1);
	const reaches =
		Math.abs((joined.endSeconds ?? Number.NaN) - seam) <=
		SEAM_REACH_SECONDS;
	if (!earlier || !reaches) {
		return rebuilt(part, takenOver(lines, seam).kept, NO_RENAMES);
	}
	const { takeover, kept } = takenOver(
		lines,
		cutLineStart(joined.lines, part.offsetSeconds, seam),
	);
	const matched = pairBySharedSeconds(
		sharedSeconds(joined.lines, lines, part.offsetSeconds, seam),
	);
	// The earlier part's labels were settled when it was joined, so only its
	// lines past the takeover change here.
	joined.parts[joined.parts.length - 1] = rebuilt(
		earlier,
		placed(earlier).filter(
			(line) => (line.start + line.end) / 2 < takeover,
		),
		NO_RENAMES,
	);
	return rebuilt(
		part,
		kept,
		renameLabels(joined.known, part.transcript.speakers, matched),
	);
}

/**
 * Joins parts that overlap by a lead-in: renames each later part's speakers
 * to the earlier part's, and keeps the shared stretch once (see
 * {@link acrossSeam}). A part with no lead-in is taken as it is.
 * @param parts - The transcribed parts, in any order
 * @returns The parts in timeline order, renamed and no longer overlapping
 */
export function joinSeams<T extends SeamPart>(parts: readonly T[]): T[] {
	const joined: Joined<T> = {
		parts: [],
		known: new Set<string>(),
		lines: [],
		endSeconds: undefined,
	};
	const ordered = [...parts].sort(
		(a, b) => a.offsetSeconds - b.offsetSeconds,
	);
	for (const part of ordered) {
		const leadIn = part.leadInSeconds ?? 0;
		const next = leadIn > 0 ? acrossSeam(joined, part, leadIn) : part;
		joined.parts.push(next);
		joined.lines = placed(next);
		joined.endSeconds = part.endSeconds;
		for (const label of next.transcript.speakers) {
			joined.known.add(label);
		}
	}
	return joined.parts;
}
