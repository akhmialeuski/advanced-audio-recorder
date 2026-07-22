/**
 * Locates and reads a recording's existing transcript as timed lines for
 * chapter generation, with no stored state: the transcript sidecar files
 * next to the recording (JSON, SRT, VTT, TXT) and, failing those, the
 * notes whose timecode links resolve to this audio (the default "insert
 * into the note" destination writes no sidecar). Returning null means the
 * recording has no readable transcript anywhere - the caller's cue to ask
 * the user to transcribe first instead of sending an empty prompt.
 * @module chapters/transcriptSources
 */

import { parseLinktext } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	findReferencingNotes,
	findTranscriptSidecarFiles,
} from '../speakers/applySpeakerRenames';
import type {
	Transcript,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import { parseTimecode } from '../utils/TimeUtils';
import type { TimedLine } from './chapterGeneration';

/** A located transcript, as timed lines plus where they came from. */
export interface TranscriptLinesSource {
	/** Timed lines sorted ascending by time. */
	lines: TimedLine[];
	/** Human-readable origin, for log/notice context (e.g. a file path). */
	origin: string;
	/**
	 * Detected/declared transcript language (BCP-47 / ISO code) when the
	 * source carried one, which only the JSON sidecar does. Fed to the chapter
	 * prompt so generated titles come out in the transcript's language instead
	 * of a language the model guesses.
	 */
	language?: string;
}

/** Parsed sidecar content: timed lines and the language when the format has one. */
interface SidecarParse {
	lines: TimedLine[];
	language?: string;
}

/**
 * Renders an in-memory transcript as timed lines, one per segment, with
 * the speaker prefixed when known so the model sees speaker turns.
 * @param transcript - Source transcript
 */
export function timedLinesFromTranscript(transcript: Transcript): TimedLine[] {
	const lines: TimedLine[] = [];
	for (const segment of transcript.segments) {
		const text = segment.speaker
			? `${segment.speaker}: ${segment.text}`
			: segment.text;
		if (text.trim()) {
			lines.push({ time: segment.start, text: text.trim() });
		}
	}
	return lines;
}

/**
 * Parses a JSON transcript sidecar (the shape written by
 * `serializeTranscriptFile`) into timed lines and its detected language.
 * Entries missing a numeric start or a string text are skipped; a
 * non-transcript JSON yields no lines.
 * @param content - Raw sidecar content
 */
function linesFromTranscriptJson(content: string): SidecarParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { lines: [] };
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return { lines: [] };
	}
	const record = parsed as { segments?: unknown; language?: unknown };
	const segments = record.segments;
	if (!Array.isArray(segments)) {
		return { lines: [] };
	}
	const language =
		typeof record.language === 'string' && record.language.trim()
			? record.language.trim()
			: undefined;
	const lines: TimedLine[] = [];
	for (const entry of segments) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const start = record.start;
		const text = record.text;
		if (typeof start !== 'number' || !Number.isFinite(start)) {
			continue;
		}
		if (typeof text !== 'string' || !text.trim()) {
			continue;
		}
		const speaker =
			typeof record.speaker === 'string' && record.speaker
				? `${record.speaker}: `
				: '';
		lines.push({ time: Math.max(0, start), text: speaker + text.trim() });
	}
	return { lines, ...(language ? { language } : {}) };
}

/** Matches a subtitle cue timing line, capturing the start time parts. */
const SUBTITLE_TIMING_PATTERN = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/;

/**
 * Parses an SRT or WebVTT sidecar into timed lines: each cue's start time
 * plus its following text lines. Index lines, the WEBVTT header, and cue
 * settings after `-->` are ignored, which both formats tolerate.
 * @param content - Raw sidecar content
 */
function linesFromSubtitles(content: string): TimedLine[] {
	const lines: TimedLine[] = [];
	let currentTime: number | null = null;
	let currentText: string[] = [];
	const flush = (): void => {
		if (currentTime !== null && currentText.length > 0) {
			lines.push({ time: currentTime, text: currentText.join(' ') });
		}
		currentTime = null;
		currentText = [];
	};
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		const timing = SUBTITLE_TIMING_PATTERN.exec(line);
		if (timing) {
			flush();
			currentTime =
				Number(timing[1]) * 3600 +
				Number(timing[2]) * 60 +
				Number(timing[3]) +
				Number(timing[4]) / 1000;
			continue;
		}
		if (!line) {
			flush();
			continue;
		}
		if (currentTime !== null) {
			currentText.push(line);
		}
	}
	flush();
	return lines;
}

/**
 * Parses a plain-text sidecar (`[m:ss] Speaker: text` lines) into timed
 * lines. Lines without a leading bracketed timecode are skipped.
 * @param content - Raw sidecar content
 */
function linesFromPlainText(content: string): TimedLine[] {
	const lines: TimedLine[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const match = /^\[([^\]]+)\]\s*(.+)$/.exec(raw.trim());
		if (!match) {
			continue;
		}
		const time = parseTimecode(match[1] ?? '');
		const text = (match[2] ?? '').trim();
		if (time === null || !text) {
			continue;
		}
		lines.push({ time, text });
	}
	return lines;
}

/** Parses one sidecar's content into timed lines (and language) by format. */
function linesFromSidecar(
	format: TranscriptFileFormat,
	content: string,
): SidecarParse {
	switch (format) {
		case 'json':
			return linesFromTranscriptJson(content);
		case 'srt':
		case 'vtt':
			return { lines: linesFromSubtitles(content) };
		case 'txt':
			return { lines: linesFromPlainText(content) };
		default: {
			const exhaustive: never = format;
			throw new Error(
				`Unsupported transcript file format: ${String(exhaustive)}`,
			);
		}
	}
}

/** Whether a parsed link subpath is a timecode subpath (`#t=<seconds>`). */
function timecodeSubpathSeconds(subpath: string): number | null {
	const stripped = subpath.replace(/^#/, '');
	if (!stripped.startsWith('t=')) {
		return null;
	}
	const seconds = Number(stripped.slice(2));
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Maps each note line that carries a timecode link resolving to the audio
 * onto that link's seconds (the earliest when a line carries several).
 * @param app - Obsidian App
 * @param note - Note to inspect
 * @param audioPath - Vault path of the audio file
 */
function audioLineTimes(
	app: App,
	note: TFile,
	audioPath: string,
): Map<number, number> {
	const times = new Map<number, number>();
	const cache = app.metadataCache.getFileCache(note);
	if (!cache) {
		return times;
	}
	const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];
	for (const ref of refs) {
		const { path, subpath } = parseLinktext(ref.link);
		const seconds = timecodeSubpathSeconds(subpath);
		if (seconds === null) {
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(path, note.path);
		if (dest?.path !== audioPath) {
			continue;
		}
		const line = ref.position.start.line;
		const existing = times.get(line);
		if (existing === undefined || seconds < existing) {
			times.set(line, seconds);
		}
	}
	return times;
}

/**
 * Strips the rendered transcript line down to readable text for the LLM:
 * wikilinks reduce to their alias (the timecode label), Markdown links to
 * their label, and bold markers around speaker names are removed.
 * @param line - Raw note line
 */
function cleanNoteLine(line: string): string {
	return line
		.replace(/!?\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
		.replace(/!?\[\[[^\]]*\]\]/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\*\*/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Reads a note's transcript lines for one recording: the lines whose
 * timecode links resolve to the audio, each stamped with its link's time.
 * @param app - Obsidian App
 * @param note - Note carrying the rendered transcript
 * @param audioPath - Vault path of the audio file
 */
async function linesFromNote(
	app: App,
	note: TFile,
	audioPath: string,
): Promise<TimedLine[]> {
	const times = audioLineTimes(app, note, audioPath);
	if (times.size === 0) {
		return [];
	}
	const content = await app.vault.read(note);
	const noteLines = content.split('\n');
	const lines: TimedLine[] = [];
	for (const [index, time] of times) {
		const text = cleanNoteLine(noteLines[index] ?? '');
		if (text) {
			lines.push({ time, text });
		}
	}
	return lines;
}

/**
 * Finds a recording's existing transcript and returns it as timed lines,
 * or null when no transcript exists anywhere. Sidecar files are preferred
 * (canonical, in format order JSON > SRT > VTT > TXT); when none parses to
 * any lines, the referencing notes are searched and the note with the most
 * timecode-linked transcript lines wins. Unreadable outputs are logged and
 * skipped rather than failing the search.
 * @param app - Obsidian App
 * @param audioFile - Recording whose transcript is sought
 */
export async function loadTranscriptLines(
	app: App,
	audioFile: TFile,
): Promise<TranscriptLinesSource | null> {
	for (const { file, format } of findTranscriptSidecarFiles(app, audioFile)) {
		try {
			const { lines, language } = linesFromSidecar(
				format,
				await app.vault.read(file),
			);
			if (lines.length > 0) {
				lines.sort((a, b) => a.time - b.time);
				return {
					lines,
					origin: file.path,
					...(language ? { language } : {}),
				};
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read transcript from ${file.path}:`,
				error,
			);
		}
	}
	let best: TranscriptLinesSource | null = null;
	for (const note of findReferencingNotes(app, audioFile.path)) {
		try {
			const lines = await linesFromNote(app, note, audioFile.path);
			if (lines.length > (best?.lines.length ?? 0)) {
				lines.sort((a, b) => a.time - b.time);
				best = { lines, origin: note.path };
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read transcript from ${note.path}:`,
				error,
			);
		}
	}
	return best;
}
