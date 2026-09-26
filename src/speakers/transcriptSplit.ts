/**
 * Pure model for splitting one rendered transcript line between speakers.
 *
 * Diarization sometimes hands two people's words to one speaker - they talk
 * over each other, or the engine simply guesses wrong - and the timestamps of
 * such a turn are off with it. The user selects the part of the line that
 * belongs to someone else, and this module answers everything the split needs
 * short of touching the vault: which text lies before, inside and after the
 * selection, which transcript segments sit behind the line (grouped exactly as
 * the renderer grouped them), where the selection most likely starts and ends
 * on the timeline, which speakers can be picked and which new roster entries a
 * pick creates, and the transcript with that row replaced by its pieces.
 *
 * Every piece is carried as a transcript segment, so the note lines are
 * rendered by the very renderer that wrote the transcript and the JSON output
 * is rewritten from the same pieces - the two can never disagree about what
 * the split produced. No DOM or I/O; unit tested directly.
 * @module speakers/transcriptSplit
 */

import type {
	NoteOutputTemplates,
	SpeakerEntry,
} from '../sidecar/recordingSidecarModel';
import {
	continuesSpeakerRow,
	restoreWikilinks,
	transcriptMarkdownOptions,
	type ParsedTranscriptLine,
	type TranscriptMarkdownOptions,
	type TranscriptMarkdownSettings,
} from '../transcription/transcriptFormat';
import {
	collectSpeakers,
	normalizeWhitespace,
} from '../transcription/transcriptModel';
import type {
	Transcript,
	TranscriptSegment,
	TranscriptWord,
} from '../transcription/TranscriptTypes';
import { formatTimecode, parseTimecode } from '../utils/TimeUtils';

/**
 * The rendering options a note's transcript was written with: the templates
 * its output recorded, the settings for whatever an older record did not
 * store, and the current settings alone for a note the sidecar never
 * recorded. Speakers are always rendered, since assigning one is the point of
 * a split.
 * @param templates - Templates the note output recorded, if any
 * @param settings - Current plugin settings
 */
export function noteMarkdownOptions(
	templates: NoteOutputTemplates | undefined,
	settings: TranscriptMarkdownSettings,
): TranscriptMarkdownOptions {
	const current = transcriptMarkdownOptions(settings);
	if (!templates) {
		return { ...current, includeSpeakers: true };
	}
	return {
		...current,
		includeSpeakers: true,
		includeTimestamps: templates.includeTimestamps,
		timestampLinks: templates.timestampLinks,
		mergeConsecutiveSpeaker: templates.mergeConsecutiveSpeaker,
		speakerFormat: templates.speakerFormat,
		lineFormat: templates.lineFormat,
		timestampFormat: templates.timestampFormat ?? current.timestampFormat,
	};
}

/** The spoken text of a line cut at the selection, each part trimmed. */
export interface SplitTexts {
	/** Text before the selection ('' when the selection starts the text). */
	before: string;
	/** The selected text. */
	selected: string;
	/** Text after the selection ('' when the selection ends the text). */
	after: string;
}

/**
 * Cuts a line's spoken text at the selection. A selection reaching into the
 * timestamp or the speaker label is clamped to the text, so selecting "from
 * here to the end" generously still means the text.
 * @param line - The rendered line
 * @param parsed - Where its parts sit
 * @param from - Selection start column
 * @param to - Selection end column
 * @returns The three parts, or null when no spoken text is selected
 */
export function splitLineText(
	line: string,
	parsed: ParsedTranscriptLine,
	from: number,
	to: number,
): SplitTexts | null {
	const start = Math.min(Math.max(from, parsed.textStart), parsed.textEnd);
	const end = Math.min(Math.max(to, parsed.textStart), parsed.textEnd);
	const selected = line.slice(start, end).trim();
	if (selected.length === 0) {
		return null;
	}
	return {
		before: line.slice(parsed.textStart, start).trim(),
		selected,
		after: line.slice(end, parsed.textEnd).trim(),
	};
}

/** Inclusive index range of the transcript segments behind one note line. */
export interface RowSpan {
	/** Index of the row's first segment. */
	first: number;
	/** Index of the row's last segment. */
	last: number;
}

/** What identifies a rendered line among the transcript's segments. */
export interface RowLocation {
	/** Whole seconds the line's timecode link points at. */
	seconds: number;
	/** Speaker the line shows (restored from the note), if any. */
	speaker: string | undefined;
	/**
	 * Whole seconds of the next line of the same recording in the note, which
	 * is where this line's segments end; null for the last line.
	 */
	nextSeconds: number | null;
	/** Whether the note merged consecutive same-speaker segments. */
	merge: boolean;
	/** The spoken text the line shows (restored from the note's escaping). */
	text: string;
}

/**
 * Finds the segments a rendered line was built from. A timecode link carries
 * whole seconds, so the line starts at a segment in that second with the
 * speaker it shows, and runs on the way the renderer merged it - while the
 * same speaker continues - but never into the second the next line of the
 * note starts in. Bounding by the next line is what keeps a line found after an
 * earlier split, whose pieces the note shows apart but the transcript holds
 * next to a neighbour of the same speaker.
 *
 * The second and the speaker do not tell a line apart on their own: a short
 * turn interrupted by another speaker puts two lines of one speaker in one
 * second. So a run counts only when its text reads as the line's text, and
 * the line is found only when exactly one run does - a line edited by hand, or
 * one of two identical lines, is not guessed at, since splitting the wrong
 * segments would rewrite another turn in every transcript file.
 * @param transcript - The transcript the line was rendered from
 * @param location - What identifies the line
 * @returns The segments behind the line, or null when not exactly one run of
 *   them matches it
 */
export function locateRowSegments(
	transcript: Transcript,
	location: RowLocation,
): RowSpan | null {
	const { segments } = transcript;
	const text = normalizeWhitespace(location.text);
	const matches: RowSpan[] = [];
	segments.forEach((head, first) => {
		if (
			Math.floor(head.start) !== location.seconds ||
			(location.speaker !== undefined &&
				head.speaker !== location.speaker)
		) {
			return;
		}
		// Joined the way the renderer merges a row, so the text compares
		// with what the note line was written from.
		let joined = head.text;
		let match = normalizeWhitespace(joined) === text ? first : null;
		for (
			let index = first + 1;
			location.merge && index < segments.length;
			index++
		) {
			const segment = segments[index];
			if (
				!segment ||
				!continuesSpeakerRow(head.speaker, segment) ||
				(location.nextSeconds !== null &&
					Math.floor(segment.start) >= location.nextSeconds)
			) {
				break;
			}
			joined = `${joined} ${segment.text}`;
			if (normalizeWhitespace(joined) === text) {
				match = index;
			}
		}
		if (match !== null) {
			matches.push({ first, last: match });
		}
	});
	const [only, ...others] = matches;
	return only && others.length === 0 ? only : null;
}

/** Where a line sits on the timeline, as far as it is known. */
export interface RowTiming {
	/** Offset the line starts at. */
	start: number;
	/** Offset the line ends at, or null when nothing tells. */
	end: number | null;
	/** Word timings of the line's segments, when the engine gave them. */
	words?: TranscriptWord[];
}

/**
 * The timing of the segments behind a line: from the first one's start to the
 * last one's end, with every word timing they carry.
 * @param transcript - The transcript the line was rendered from
 * @param span - The line's segments
 */
export function rowTiming(transcript: Transcript, span: RowSpan): RowTiming {
	const segments = transcript.segments.slice(span.first, span.last + 1);
	const words = segments.flatMap((segment) => segment.words ?? []);
	return {
		start: Math.min(...segments.map((segment) => segment.start)),
		end: Math.max(...segments.map((segment) => segment.end)),
		...(words.length > 0 ? { words } : {}),
	};
}

/** A stretch of the timeline, in seconds. */
export interface SplitTimes {
	/** Offset the selection starts at. */
	start: number;
	/** Offset the selection ends at. */
	end: number;
}

/** Number of whitespace-separated words in a text. */
function wordCount(text: string): number {
	return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Where the selection most likely starts and ends, offered as the dialog's
 * starting point. With word timings that match the line word for word, the
 * selection's first and last words say it exactly; otherwise the line's span
 * is shared out by the length of each part, the way speech spreads over time.
 * A part that is empty takes the line's own bound, and a line whose end is
 * unknown can only offer its start.
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 */
export function estimateSplitTimes(
	timing: RowTiming,
	texts: SplitTexts,
): SplitTimes {
	const before = wordCount(texts.before);
	const selected = wordCount(texts.selected);
	const words = timing.words;
	if (words && words.length === before + selected + wordCount(texts.after)) {
		const spoken = words.slice(before, before + selected);
		const lastEnd = Math.max(...spoken.map((word) => word.end));
		return {
			start: texts.before
				? Math.min(...spoken.map((word) => word.start))
				: timing.start,
			end: texts.after ? lastEnd : (timing.end ?? lastEnd),
		};
	}
	if (timing.end === null || timing.end <= timing.start) {
		return { start: timing.start, end: timing.start };
	}
	const duration = timing.end - timing.start;
	const beforeLength = texts.before.length;
	const selectedLength = texts.selected.length;
	const total = beforeLength + selectedLength + texts.after.length;
	const at = (chars: number): number =>
		timing.start + (duration * chars) / total;
	return {
		start: at(beforeLength),
		end: texts.after ? at(beforeLength + selectedLength) : timing.end,
	};
}

/**
 * Formats an offset for the dialog's time fields: the plugin's usual timecode,
 * with tenths of a second when there are any, which the timecode parser reads
 * back.
 * @param seconds - Offset in seconds
 */
export function formatSplitTime(seconds: number): string {
	const tenths = Math.round(seconds * 10);
	const whole = Math.floor(tenths / 10);
	const fraction = tenths % 10;
	const timecode = formatTimecode(whole);
	return fraction > 0 ? `${timecode}.${String(fraction)}` : timecode;
}

/**
 * Reads the entered times and checks them against the line.
 * @param start - Text of the start field
 * @param end - Text of the end field
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 * @returns The times, or why they cannot split this line
 */
export function readSplitTimes(
	start: string,
	end: string,
	timing: RowTiming,
	texts: SplitTexts,
): SplitTimes | string {
	const times = { start: parseTimecode(start), end: parseTimecode(end) };
	if (times.start === null || times.end === null) {
		return 'Enter the start and the end as a timecode, for example 1:23 or 1:23.5.';
	}
	const read = { start: times.start, end: times.end };
	return splitTimesProblem(read, timing, texts) ?? read;
}

/**
 * Why the times cannot split this line, or null when they can. The part before
 * the selection has to keep some time, as has the part after it when the
 * line's end is known; the selection itself has to run forward.
 * @param times - Where the selection is said to be spoken
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 */
export function splitTimesProblem(
	times: SplitTimes,
	timing: RowTiming,
	texts: SplitTexts,
): string | null {
	const { start, end } = times;
	if (end <= start) {
		return 'The end of the selection has to come after its start.';
	}
	if (texts.before && start <= timing.start) {
		return `The selection has to start after the line does, at ${formatSplitTime(timing.start)}.`;
	}
	if (texts.after && timing.end !== null && end >= timing.end) {
		return `The selection has to end before the line does, at ${formatSplitTime(timing.end)}.`;
	}
	return null;
}

/** One speaker a part of the line can be given. */
export type SplitSpeakerChoice =
	/** A speaker the transcript already shows, by the name it shows. */
	| { kind: 'existing'; name: string }
	/** A participant of the recording no speaker is named after yet. */
	| { kind: 'participant'; name: string }
	/** A speaker the transcript has no label for yet. */
	| { kind: 'new' }
	/** No speaker at all, which only an undiarized line starts out with. */
	| { kind: 'none' };

/** One entry of the dialog's speaker dropdowns. */
export interface SplitSpeakerOption {
	/** Dropdown value, unique among the options. */
	value: string;
	/** What the dropdown shows. */
	title: string;
	/** What picking it means. */
	choice: SplitSpeakerChoice;
}

/** Engine labels a speaker created by a split is numbered after. */
const NEW_SPEAKER_PREFIX = 'Speaker';

/**
 * The first "Speaker N" no speaker is labelled or named yet, which is the label
 * a speaker created by a split gets - the shape the engines label speakers in,
 * so the rename dialog lists it beside theirs.
 * @param taken - Labels and names already in use
 */
export function nextSpeakerLabel(taken: ReadonlySet<string>): string {
	for (let number = 1; ; number++) {
		const label = `${NEW_SPEAKER_PREFIX} ${String(number)}`;
		if (!taken.has(label)) {
			return label;
		}
	}
}

/** What the transcript and the recording know about speakers. */
export interface SplitSpeakerSources {
	/** The recording's stored speaker roster. */
	roster: readonly SpeakerEntry[];
	/** The recording's participant names. */
	participants: readonly string[];
	/** Speaker names the transcript shows (its segments and the line). */
	shown: readonly string[];
}

/** Every label and name the sources already use. */
function takenNames(sources: SplitSpeakerSources): Set<string> {
	return new Set([
		...sources.roster.flatMap((entry) =>
			entry.name ? [entry.label, entry.name] : [entry.label],
		),
		...sources.shown,
	]);
}

/** The names the transcript can show, roster order first, each once. */
function existingNames(sources: SplitSpeakerSources): string[] {
	return [
		...new Set([
			...sources.roster.map((entry) => entry.name ?? entry.label),
			...sources.shown,
		]),
	];
}

/**
 * The speakers a part of the line can be given: every speaker the transcript
 * shows, then every participant of the recording no speaker is named after,
 * then a new speaker.
 * @param sources - What is known about the recording's speakers
 */
export function splitSpeakerOptions(
	sources: SplitSpeakerSources,
): SplitSpeakerOption[] {
	const existing = existingNames(sources);
	const shown = new Set(existing);
	return [
		...existing.map(
			(name): SplitSpeakerOption => ({
				value: `existing:${name}`,
				title: name,
				choice: { kind: 'existing', name },
			}),
		),
		...sources.participants
			.filter((name) => !shown.has(name))
			.map(
				(name): SplitSpeakerOption => ({
					value: `participant:${name}`,
					title: name,
					choice: { kind: 'participant', name },
				}),
			),
		{
			value: 'new',
			title: `New speaker (${nextSpeakerLabel(takenNames(sources))})`,
			choice: { kind: 'new' },
		},
	];
}

/** One part of the line and the speaker picked for it. */
export interface SplitSpeakerRequest {
	/** The speaker picked. */
	choice: SplitSpeakerChoice;
	/** Where the part is spoken, the first turn a new speaker is given. */
	times: SplitTimes;
}

/** The names the parts are shown under, and the roster entries that adds. */
export interface ResolvedSplitSpeakers {
	/** Name per request, in request order (undefined for no speaker). */
	names: (string | undefined)[];
	/** Roster entries the picks create, in the order they were created. */
	added: SpeakerEntry[];
}

/**
 * Turns the picks into the names the parts are shown under. A participant
 * nobody is named after, and a new speaker, become roster entries under the
 * next free "Speaker N" label - the participant named, so the rename dialog
 * lists them like any diarized speaker and a later rename reaches their lines.
 * Picking the same new speaker or participant twice means one speaker, and its
 * first turn is the first part picked for it.
 * @param sources - What is known about the recording's speakers
 * @param requests - The parts and their picks
 */
export function resolveSplitSpeakers(
	sources: SplitSpeakerSources,
	requests: readonly SplitSpeakerRequest[],
): ResolvedSplitSpeakers {
	const taken = takenNames(sources);
	const added: SpeakerEntry[] = [];
	/** Name per created speaker, keyed by the pick that created it. */
	const created = new Map<string, string>();
	const create = (
		key: string,
		name: string | undefined,
		times: SplitTimes,
	): string => {
		const existing = created.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const label = nextSpeakerLabel(taken);
		taken.add(label);
		added.push({
			label,
			...(name ? { name } : {}),
			firstStart: times.start,
			firstEnd: times.end,
		});
		const shown = name ?? label;
		created.set(key, shown);
		return shown;
	};
	const names = requests.map(({ choice, times }): string | undefined => {
		if (choice.kind === 'existing') {
			return choice.name;
		}
		if (choice.kind === 'participant') {
			return create(`participant:${choice.name}`, choice.name, times);
		}
		return choice.kind === 'new'
			? create('new', undefined, times)
			: undefined;
	});
	return { names, added };
}

/** The speakers the parts of a split line are shown under. */
export interface SplitPieceSpeakers {
	/** Speaker the line showed, which the text before the selection keeps. */
	row: string | undefined;
	/** Speaker of the selection. */
	selected: string | undefined;
	/** Speaker of the text after the selection. */
	after: string | undefined;
}

/**
 * Where the text after the selection is spoken: from the selection's end to
 * the line's, or nowhere past the selection when the line's end is unknown.
 * @param timing - Where the line sits
 * @param times - Where the selection is spoken
 */
export function afterSelection(
	timing: RowTiming,
	times: SplitTimes,
): SplitTimes {
	return {
		start: times.end,
		end: Math.max(times.end, timing.end ?? times.end),
	};
}

/**
 * Builds the pieces a line splits into, as transcript segments: the text
 * before the selection keeps the line's start and speaker and ends where the
 * selection starts, the selection spans the entered times, and the text after
 * it runs from there to the line's end. Texts are read from the note, so the
 * wikilink escaping the renderer added is taken back off.
 * @param timing - Where the line sits
 * @param texts - The line cut at the selection
 * @param times - Where the selection is spoken
 * @param speakers - Who each part is given to
 */
export function buildSplitPieces(
	timing: RowTiming,
	texts: SplitTexts,
	times: SplitTimes,
	speakers: SplitPieceSpeakers,
): TranscriptSegment[] {
	const piece = (
		start: number,
		end: number,
		text: string,
		speaker: string | undefined,
	): TranscriptSegment => ({
		start,
		end,
		text: restoreWikilinks(text),
		...(speaker === undefined ? {} : { speaker }),
	});
	const pieces: TranscriptSegment[] = [];
	if (texts.before) {
		pieces.push(
			piece(timing.start, times.start, texts.before, speakers.row),
		);
	}
	pieces.push(
		piece(times.start, times.end, texts.selected, speakers.selected),
	);
	if (texts.after) {
		const after = afterSelection(timing, times);
		pieces.push(piece(after.start, after.end, texts.after, speakers.after));
	}
	return pieces;
}

/**
 * Replaces the segments behind one or more note lines with the pieces they
 * become: the pieces a line was split into, or the one segment consecutive
 * lines were merged into. The word timings those segments carried go to the
 * piece whose span each word starts in, so a JSON transcript keeps them; the
 * speaker list is derived again, since a split can introduce a speaker and a
 * split or a merge can take the last line from one. The first piece keeps any
 * word that starts before it, and each piece the words up to where the next
 * one starts - so a single piece keeps every word.
 * @param transcript - The transcript the lines were rendered from
 * @param span - The lines' segments
 * @param pieces - The pieces, in timeline order
 * @returns The transcript with the segments replaced
 */
export function replaceTranscriptRow(
	transcript: Transcript,
	span: RowSpan,
	pieces: readonly TranscriptSegment[],
): Transcript {
	const replaced = transcript.segments.slice(span.first, span.last + 1);
	const words = replaced.flatMap((segment) => segment.words ?? []);
	const hadWords = replaced.some((segment) => segment.words);
	const withWords = pieces.map((piece, index): TranscriptSegment => {
		if (!hadWords) {
			return piece;
		}
		const next = pieces[index + 1];
		return {
			...piece,
			words: words.filter(
				(word) =>
					(index === 0 || word.start >= piece.start) &&
					(!next || word.start < next.start),
			),
		};
	});
	// Sorted again (stably) because an entered start may move the selection
	// before a neighbouring segment, and a transcript is kept in timeline order.
	const segments = [
		...transcript.segments.slice(0, span.first),
		...withWords,
		...transcript.segments.slice(span.last + 1),
	].sort((a, b) => a.start - b.start);
	return { ...transcript, segments, speakers: collectSpeakers(segments) };
}
