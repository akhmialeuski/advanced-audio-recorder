/**
 * What the dialogs that edit rendered transcript lines in place share - the
 * split of a line between speakers and the merge of consecutive lines into
 * one: reading the recording's sidecar and JSON transcript, reading a note
 * line back with the templates it was written with, where the note's next
 * line of the recording starts, the recording's length, and the speaker
 * dropdowns. One implementation, so the two dialogs read a line the same way
 * and can never disagree about which segments it shows.
 * @module ui/transcriptLineDialog
 */

import type { App, DropdownComponent, Editor, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { lineTimecodeRef } from '../obsidian/timecodeRefs';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { TranscriptSection } from '../sidecar/recordingSidecarModel';
import type { TranscriptEditSidecar } from '../speakers/applyTranscriptEdit';
import {
	noteMarkdownOptions,
	type RowSpan,
	type LineSpeakerChoice,
	type LineSpeakerOption,
	type LineSpeakerSources,
} from '../speakers/transcriptRows';
import {
	originalTranscriptOutputs,
	readRecordedTranscript,
	type RecordedTranscript,
} from '../transcription/recordedTranscript';
import {
	parseTranscriptLine,
	restoreWikilinks,
	type ParsedTranscriptLine,
	type TranscriptMarkdownOptions,
} from '../transcription/transcriptFormat';
import { collectSpeakers } from '../transcription/transcriptModel';

/** Longest excerpt of a line's text the dialogs quote. */
const EXCERPT_MAX_CHARS = 160;

/**
 * The slice of the recording sidecar store the dialogs need: read the
 * transcript section, tell an unreadable sidecar from an empty one, and add
 * the speakers an edit creates to the roster. Structural so tests can stub it.
 */
export interface TranscriptEditSidecarAccess extends TranscriptEditSidecar {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/** Whether the sidecar file exists but could not be read (after a read). */
	isSidecarCorrupt(path: string): boolean;
}

/** Collaborators the dialogs need, injected by the action registry. */
export interface TranscriptEditModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Recording sidecar access: templates, outputs and the roster. */
	sidecar: TranscriptEditSidecarAccess;
	/**
	 * Measures the recording, which is where the note's last line ends when no
	 * JSON transcript says so.
	 */
	probeDuration: (url: string) => Promise<number | null>;
}

/** What the recording's sidecar and JSON transcript say about its lines. */
export interface TranscriptSource {
	/** The recording's sidecar transcript section. */
	section: TranscriptSection;
	/** The templates the note's transcript was written with. */
	options: TranscriptMarkdownOptions;
	/** The recorded JSON transcript, when there is one. */
	recorded: RecordedTranscript | null;
	/** Speaker names the JSON transcript's segments show. */
	shown: string[];
	/** Every speaker name a line can show: the roster's, then the shown. */
	known: string[];
	/**
	 * The templates a line is read back with: the note's, without speakers
	 * for a transcript that was never diarized.
	 */
	lineOptions: TranscriptMarkdownOptions;
}

/**
 * Reads the recording's sidecar transcript section: an empty one when
 * nothing is stored, null when it could not be read. A failed read is not
 * an empty sidecar, so it is never edited over as one: the roster it holds
 * is unknown, and a new speaker could take a label already stored there.
 * @param sidecar - Recording sidecar access
 * @param path - Vault path of the recording
 */
async function loadTranscriptSection(
	sidecar: TranscriptEditSidecarAccess,
	path: string,
): Promise<TranscriptSection | null> {
	try {
		const section = await sidecar.getTranscript(path);
		return sidecar.isSidecarCorrupt(path) ? null : section;
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Failed to read the sidecar of ${path}:`,
			error,
		);
		return null;
	}
}

/**
 * Reads the recording's sidecar and JSON transcript, and the templates the
 * note's transcript was written with.
 * @param app - Obsidian App
 * @param dialog - The dialog's collaborators
 * @param note - The note the lines are in
 * @param audio - The recording the lines belong to
 * @returns What the lines are read with, or why they cannot be edited
 */
export async function readTranscriptSource(
	app: App,
	dialog: TranscriptEditModalOptions,
	note: TFile,
	audio: TFile,
): Promise<TranscriptSource | string> {
	const section = await loadTranscriptSection(dialog.sidecar, audio.path);
	if (section === null) {
		return 'The sidecar file of this recording could not be read, so the speakers stored for it are unknown. Fix or remove the .markers.json file next to the recording and try again.';
	}
	const output = section.noteOutputs.find(
		(candidate) => candidate.path === note.path,
	);
	const options = noteMarkdownOptions(
		output?.templates,
		dialog.getSettings(),
	);
	const recorded = await readRecordedTranscript(app, section.fileOutputs);
	const shown = recorded ? collectSpeakers(recorded.transcript.segments) : [];
	const known = [
		...section.speakers.map((entry) => entry.name ?? entry.label),
		...shown,
	];
	// A transcript whose JSON output names no speaker, with an empty roster,
	// was never diarized: its lines show no speaker, so nothing at the head of
	// their text (a bold word, a "Note:") is read as one.
	const undiarized = recorded !== null && known.length === 0;
	return {
		section,
		options,
		recorded,
		shown,
		known,
		lineOptions: undiarized
			? { ...options, includeSpeakers: false }
			: options,
	};
}

/** One note line read back into its parts. */
export interface ReadLine {
	/** Where the line's parts sit. */
	parsed: ParsedTranscriptLine;
	/** Speaker the line shows (restored from the note's escaping), if any. */
	speaker: string | undefined;
	/** The spoken text as the note shows it. */
	text: string;
}

/**
 * Reads one note line back with the templates the transcript was written
 * with.
 * @param source - What the recording's lines are read with
 * @param lineText - The line as the editor holds it
 * @returns Its parts, or null when it does not have the shape of a line of
 *   this transcript
 */
export function readTranscriptLine(
	source: TranscriptSource,
	lineText: string,
): ReadLine | null {
	const parsed = parseTranscriptLine(
		lineText,
		source.lineOptions,
		source.known,
	);
	if (!parsed) {
		return null;
	}
	return {
		parsed,
		speaker:
			parsed.speaker === undefined
				? undefined
				: restoreWikilinks(parsed.speaker),
		text: lineText.slice(parsed.textStart, parsed.textEnd),
	};
}

/**
 * What is known about the recording's speakers, the lines being edited
 * included.
 * @param source - What the recording's lines are read with
 * @param lineSpeakers - Speakers the edited lines show
 */
export function speakerSources(
	source: TranscriptSource,
	lineSpeakers: readonly (string | undefined)[],
): LineSpeakerSources {
	return {
		roster: source.section.speakers,
		participants: source.section.participants,
		shown: [
			...source.shown,
			...lineSpeakers.filter(
				(speaker): speaker is string => speaker !== undefined,
			),
		],
	};
}

/**
 * Where the next line of the same recording starts below a line, which is
 * where that line ends as far as the note can tell; null for the last line.
 * Read from the editor, like the selected lines themselves, so lines the
 * metadata cache has not caught up with are never skipped or doubled.
 * @param app - Obsidian App
 * @param editor - The editor holding the note
 * @param note - The note the lines are in
 * @param audio - The recording the lines belong to
 * @param line - The line whose successor is looked for
 */
export function nextLineSeconds(
	app: App,
	editor: Editor,
	note: TFile,
	audio: TFile,
	line: number,
): number | null {
	for (let below = line + 1; below < editor.lineCount(); below++) {
		const ref = lineTimecodeRef(app, note, editor.getLine(below));
		if (ref?.file.path === audio.path) {
			return ref.seconds;
		}
	}
	return null;
}

/**
 * The recording's length, or null when it cannot be measured.
 * @param app - Obsidian App
 * @param dialog - The dialog's collaborators
 * @param audio - The recording
 */
export async function recordingDuration(
	app: App,
	dialog: TranscriptEditModalOptions,
	audio: TFile,
): Promise<number | null> {
	try {
		return await dialog.probeDuration(app.vault.getResourcePath(audio));
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Could not measure ${audio.path}:`,
			error,
		);
		return null;
	}
}

/** The dropdown entry that leaves a line without a speaker. */
export const NO_SPEAKER_OPTION: LineSpeakerOption = {
	value: 'none',
	title: 'No speaker',
	choice: { kind: 'none' },
};

/**
 * The dropdown value a speaker shown by a line is picked by, or that of no
 * speaker.
 * @param speaker - The speaker, if any
 */
export function speakerValue(speaker: string | undefined): string {
	return speaker === undefined
		? NO_SPEAKER_OPTION.value
		: `existing:${speaker}`;
}

/**
 * The choice a speaker dropdown value stands for (the values are the ones
 * {@link lineSpeakerOptions} gives, plus "none" for no speaker).
 * @param value - The dropdown's value
 */
export function pickedChoice(value: string): LineSpeakerChoice {
	if (value === 'new') {
		return { kind: 'new' };
	}
	if (value === NO_SPEAKER_OPTION.value) {
		return { kind: 'none' };
	}
	const separator = value.indexOf(':');
	const name = value.slice(separator + 1);
	return value.startsWith('participant:')
		? { kind: 'participant', name }
		: { kind: 'existing', name };
}

/**
 * Fills a speaker dropdown with the options, in order.
 * @param dropdown - The dropdown
 * @param options - The speaker options
 */
export function fillSpeakerDropdown(
	dropdown: DropdownComponent,
	options: readonly LineSpeakerOption[],
): void {
	for (const option of options) {
		dropdown.addOption(option.value, option.title);
	}
}

/**
 * Quotes a line's text, shortened to a readable excerpt.
 * @param text - The text
 */
export function quote(text: string): string {
	const excerpt =
		text.length > EXCERPT_MAX_CHARS
			? `${text.slice(0, EXCERPT_MAX_CHARS).trimEnd()}...`
			: text;
	return `"${excerpt}"`;
}

/**
 * Why the transcript files will be kept as they are, or null when they will
 * be edited along with the note (or there are none).
 * @param source - What the recording's lines are read with
 * @param span - The edited lines' segments, when they were found
 * @param missing - What the JSON transcript lacks when they were not
 *   ("no segment matching this line")
 * @param edit - How the edit is named ("a split", "a merge")
 */
export function keptFilesReason(
	source: TranscriptSource,
	span: RowSpan | null,
	missing: string,
	edit: string,
): string | null {
	if (source.recorded && !span) {
		return `Only the note is changed: the JSON transcript of this recording holds ${missing}, so its transcript files are kept as they are.`;
	}
	if (
		!source.recorded &&
		originalTranscriptOutputs(source.section.fileOutputs).length > 0
	) {
		return `Only the note is changed: the transcript files of this recording are kept as they are, because only a JSON transcript keeps the timings ${edit} needs.`;
	}
	return null;
}
