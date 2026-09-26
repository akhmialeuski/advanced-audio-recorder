/**
 * Pure model of rendered transcript lines, shared by the edits that rewrite
 * them in place - a line split between speakers and consecutive lines merged
 * into one: the templates a note's lines were written with, the transcript
 * segments behind a line (grouped exactly as the renderer grouped them), where
 * those segments sit on the timeline, which speakers an edited line can be
 * given and which roster entries a pick creates, and the transcript with the
 * segments behind lines replaced by the ones they become.
 *
 * Both edits carry what they produce as transcript segments, so the note lines
 * are rendered by the very renderer that wrote the transcript and the JSON
 * output is rewritten from the same segments - the two can never disagree.
 * No DOM or I/O; unit tested directly.
 * @module speakers/transcriptRows
 */

import type {
	NoteOutputTemplates,
	SpeakerEntry,
} from '../sidecar/recordingSidecarModel';
import {
	continuesSpeakerRow,
	transcriptMarkdownOptions,
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
import { formatTimecode } from '../utils/TimeUtils';

/**
 * The rendering options a note's transcript was written with: the templates
 * its output recorded, the settings for whatever an older record did not
 * store, and the current settings alone for a note the sidecar never
 * recorded. Speakers are always rendered, since assigning one is the point of
 * an edit.
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
 * one of two identical lines, is not guessed at, since editing the wrong
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
export interface TimelineSpan {
	/** Offset the stretch starts at. */
	start: number;
	/** Offset the stretch ends at. */
	end: number;
}

/**
 * Formats an offset for the dialog's time fields: the plugin's usual timecode,
 * with tenths of a second when there are any, which the timecode parser reads
 * back.
 * @param seconds - Offset in seconds
 */
export function formatLineTime(seconds: number): string {
	const tenths = Math.round(seconds * 10);
	const whole = Math.floor(tenths / 10);
	const fraction = tenths % 10;
	const timecode = formatTimecode(whole);
	return fraction > 0 ? `${timecode}.${String(fraction)}` : timecode;
}

/** One speaker a part of the line can be given. */
export type LineSpeakerChoice =
	/** A speaker the transcript already shows, by the name it shows. */
	| { kind: 'existing'; name: string }
	/** A participant of the recording no speaker is named after yet. */
	| { kind: 'participant'; name: string }
	/** A speaker the transcript has no label for yet. */
	| { kind: 'new' }
	/** No speaker at all, which only an undiarized line starts out with. */
	| { kind: 'none' };

/** One entry of the dialog's speaker dropdowns. */
export interface LineSpeakerOption {
	/** Dropdown value, unique among the options. */
	value: string;
	/** What the dropdown shows. */
	title: string;
	/** What picking it means. */
	choice: LineSpeakerChoice;
}

/** Engine labels a speaker created by an edit is numbered after. */
const NEW_SPEAKER_PREFIX = 'Speaker';

/**
 * The first "Speaker N" no speaker is labelled or named yet, which is the label
 * a speaker created by an edit gets - the shape the engines label speakers in,
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
export interface LineSpeakerSources {
	/** The recording's stored speaker roster. */
	roster: readonly SpeakerEntry[];
	/** The recording's participant names. */
	participants: readonly string[];
	/** Speaker names the transcript shows (its segments and the line). */
	shown: readonly string[];
}

/** Every label and name the sources already use. */
function takenNames(sources: LineSpeakerSources): Set<string> {
	return new Set([
		...sources.roster.flatMap((entry) =>
			entry.name ? [entry.label, entry.name] : [entry.label],
		),
		...sources.shown,
	]);
}

/** The names the transcript can show, roster order first, each once. */
function existingNames(sources: LineSpeakerSources): string[] {
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
export function lineSpeakerOptions(
	sources: LineSpeakerSources,
): LineSpeakerOption[] {
	const existing = existingNames(sources);
	const shown = new Set(existing);
	return [
		...existing.map(
			(name): LineSpeakerOption => ({
				value: `existing:${name}`,
				title: name,
				choice: { kind: 'existing', name },
			}),
		),
		...sources.participants
			.filter((name) => !shown.has(name))
			.map(
				(name): LineSpeakerOption => ({
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
export interface LineSpeakerRequest {
	/** The speaker picked. */
	choice: LineSpeakerChoice;
	/** Where the part is spoken, the first turn a new speaker is given. */
	times: TimelineSpan;
}

/** The names the parts are shown under, and the roster entries that adds. */
export interface ResolvedLineSpeakers {
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
export function resolveLineSpeakers(
	sources: LineSpeakerSources,
	requests: readonly LineSpeakerRequest[],
): ResolvedLineSpeakers {
	const taken = takenNames(sources);
	const added: SpeakerEntry[] = [];
	/** Name per created speaker, keyed by the pick that created it. */
	const created = new Map<string, string>();
	const create = (
		key: string,
		name: string | undefined,
		times: TimelineSpan,
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
