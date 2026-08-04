/**
 * Locates and reads a recording's existing transcript as timed lines for
 * chapter generation. The recording's sidecar is the source of truth: when
 * it records written outputs, those exact paths are read (transcript files
 * first, JSON preferred, then notes scoped by their timecode links). Only a
 * recording with no recorded outputs (transcribed before outputs were
 * recorded) falls back to discovering transcript files next to the audio
 * and scanning referencing notes. Returning null means the recording has no
 * readable transcript anywhere - the caller's cue to ask the user to
 * transcribe first instead of sending an empty prompt.
 * @module chapters/transcriptSources
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { audioTimecodeRefs } from '../obsidian/timecodeRefs';
import type { TranscriptSection } from '../sidecar/recordingSidecarModel';
import { buildTranscriptFilePath } from '../transcription/transcriptOutput';
import {
	TRANSCRIPT_FILE_FORMATS,
	type Transcript,
	type TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import { isAudioFile } from '../utils/audioFile';
import { directoryOf } from '../utils/paths';
import { escapeRegExp } from '../utils/regex';
import { parseTimecode } from '../utils/TimeUtils';
import type { TimedLine } from './chapterGeneration';

/** A transcript sidecar file discovered next to a recording. */
interface TranscriptSidecar {
	file: TFile;
	format: TranscriptFileFormat;
}

/**
 * Finds the notes that reference a recording (through the metadata cache, so
 * closed notes are covered too).
 * @param app - Obsidian App
 * @param audioPath - Vault path of the audio file
 */
function findReferencingNotes(app: App, audioPath: string): TFile[] {
	const notes: TFile[] = [];
	for (const [notePath, links] of Object.entries(
		app.metadataCache.resolvedLinks,
	)) {
		if (audioPath in links) {
			const note = app.vault.getFileByPath(notePath);
			if (note) {
				notes.push(note);
			}
		}
	}
	return notes;
}

/**
 * Finds the transcript sidecar files a recording actually has next to it,
 * matching the canonical name and the `_<n>` collision suffix the writer uses,
 * so a transcript written to a deduplicated path is still found. A `_<n>`
 * candidate that is instead a sibling recording's own canonical sidecar
 * (`rec_1.srt` next to `rec_1.wav`) is excluded, so chaptering `rec.wav`
 * never reads another recording's transcript.
 * @param app - Obsidian App
 * @param audioFile - Recording whose sidecars are sought
 */
function findTranscriptSidecarFiles(
	app: App,
	audioFile: TFile,
): TranscriptSidecar[] {
	const dir = directoryOf(audioFile.path);
	// One pass over the vault to collect the recording's own directory. A
	// transcript sidecar always sits next to its recording, so nothing outside
	// this directory can match - and scanning every file once per format
	// instead made the cost four full vault walks per chapter generation.
	const inDirectory = app.vault
		.getFiles()
		.filter((file) => directoryOf(file.path) === dir);
	// Other recordings sharing the directory own their own canonical sidecars;
	// those paths must not be attributed to this recording as collisions.
	const siblingAudio = inDirectory.filter(
		(file) => file.path !== audioFile.path && isAudioFile(file),
	);
	const sidecars: TranscriptSidecar[] = [];
	for (const format of TRANSCRIPT_FILE_FORMATS) {
		const canonical = buildTranscriptFilePath(audioFile.path, format);
		const canonicalName = canonical.slice(dir ? dir.length + 1 : 0);
		const dot = canonicalName.lastIndexOf('.');
		const stem = canonicalName.slice(0, dot);
		const ext = canonicalName.slice(dot + 1);
		const pattern = new RegExp(
			`^${escapeRegExp(stem)}(_\\d+)?\\.${escapeRegExp(ext)}$`,
		);
		const ownedByOthers = new Set(
			siblingAudio.map((file) =>
				buildTranscriptFilePath(file.path, format),
			),
		);
		for (const file of inDirectory) {
			if (pattern.test(file.name) && !ownedByOthers.has(file.path)) {
				sidecars.push({ file, format });
			}
		}
	}
	return sidecars;
}

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
	for (const ref of audioTimecodeRefs(app, note, audioPath)) {
		if (ref.seconds === null) {
			continue;
		}
		const existing = times.get(ref.startLine);
		if (existing === undefined || ref.seconds < existing) {
			times.set(ref.startLine, ref.seconds);
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

/** The slice of the recording sidecar store this module reads. */
export interface TranscriptSectionReader {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
}

/**
 * Finds a recording's existing transcript and returns it as timed lines, or
 * null when no readable transcript exists. When the recording's sidecar
 * records written outputs, those exact paths are read first: transcript
 * files in preference order (JSON preferred, so the detected language rides
 * along), then recorded notes scoped by their timecode links. Only when the
 * recorded outputs yield nothing - none recorded, or every one is missing,
 * unreadable, or left without timecoded lines - does the legacy discovery
 * scan run (transcript files next to the audio by name, then every
 * referencing note), so a transcript the sidecar never recorded is still
 * found instead of reporting "no transcript". Unreadable outputs are skipped
 * rather than failing the search.
 * @param app - Obsidian App
 * @param audioFile - Recording whose transcript is sought
 * @param sidecar - Recording sidecar access; null falls back to discovery
 */
export async function loadTranscriptLines(
	app: App,
	audioFile: TFile,
	sidecar: TranscriptSectionReader | null = null,
): Promise<TranscriptLinesSource | null> {
	const section = await readSection(sidecar, audioFile.path);
	if (
		section &&
		(section.fileOutputs.length > 0 || section.noteOutputs.length > 0)
	) {
		const recorded = await loadFromRecordedOutputs(app, audioFile, section);
		if (recorded) {
			return recorded;
		}
		// Every recorded output is gone, unreadable, or LLM-replaced; a
		// transcript the sidecar never recorded may still sit on disk, so
		// fall through to discovery rather than reporting "no transcript".
	}
	return loadByDiscovery(app, audioFile);
}

/** Reads the sidecar section, mapping any failure to null (fall back). */
async function readSection(
	sidecar: TranscriptSectionReader | null,
	audioPath: string,
): Promise<TranscriptSection | null> {
	if (!sidecar) {
		return null;
	}
	try {
		return await sidecar.getTranscript(audioPath);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to read the sidecar for ${audioPath}; falling back to transcript discovery:`,
			error,
		);
		return null;
	}
}

/**
 * Loads the transcript from the outputs the sidecar recorded: transcript
 * files in format-preference order (JSON first, its declared language
 * winning over the recorded provenance), then recorded notes, the note with
 * the most timecode-linked lines winning. An LLM-post-processed note is read
 * like any other: that pass is asked to keep speaker labels and timestamps on
 * their original lines, so its body usually still parses, and one that truly
 * was restructured simply yields no timecoded lines and loses the comparison.
 */
async function loadFromRecordedOutputs(
	app: App,
	audioFile: TFile,
	section: TranscriptSection,
): Promise<TranscriptLinesSource | null> {
	const byPreference = [...section.fileOutputs].sort(
		(a, b) =>
			TRANSCRIPT_FILE_FORMATS.indexOf(a.format) -
			TRANSCRIPT_FILE_FORMATS.indexOf(b.format),
	);
	for (const output of byPreference) {
		const file = app.vault.getFileByPath(output.path);
		if (!file) {
			continue;
		}
		try {
			const { lines, language } = linesFromSidecar(
				output.format,
				await app.vault.read(file),
			);
			if (lines.length > 0) {
				lines.sort((a, b) => a.time - b.time);
				const resolved = language ?? section.provenance?.language;
				return {
					lines,
					origin: file.path,
					...(resolved ? { language: resolved } : {}),
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
	for (const output of section.noteOutputs) {
		const note = app.vault.getFileByPath(output.path);
		if (!note) {
			continue;
		}
		try {
			const lines = await linesFromNote(app, note, audioFile.path);
			if (lines.length > (best?.lines.length ?? 0)) {
				lines.sort((a, b) => a.time - b.time);
				best = {
					lines,
					origin: note.path,
					...(section.provenance?.language
						? { language: section.provenance.language }
						: {}),
				};
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

/**
 * Legacy discovery for recordings whose sidecar records no outputs
 * (transcribed before outputs were recorded): transcript files next to the
 * audio by canonical name, then every referencing note.
 */
async function loadByDiscovery(
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
