/**
 * Writes transcript outputs: a sidecar transcript file next to the audio
 * (JSON/SRT/VTT/TXT) and/or the rendered Markdown inserted into a note.
 * @module transcription/transcriptOutput
 */

import { ButtonComponent, Notice } from 'obsidian';
import type { NoticeAction } from './termsOffer';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { resolveUniquePathInDirectory } from '../audio/RecordingFileManager';
import { directoryOf } from '../utils/paths';
import { embedsOf } from '../recording/NoteInserter';
import { lineOfText, withBlockInserted } from '../utils/noteText';
import { findNoteEditor } from '../utils/noteViews';
import { serializeTranscriptFile } from './transcriptFormat';
import {
	type Transcript,
	TranscriptDestination,
	TranscriptFileFormat,
} from './TranscriptTypes';

/**
 * Resolves the effective transcript destination for a run, given whether an
 * editable host note is available to insert into. With no host note (for
 * example when the audio file itself is the active pane, as with the
 * "Transcribe audio" command), an in-note-only destination can
 * never do anything but fall back to a file, so it is downgraded to `file`
 * up front - the run does what it can without a misleading "could not insert"
 * outcome. `both`, `link`, and `file` already write a file and are unchanged.
 *
 * A run whose note a template writes is the exception: what a template writes
 * is a note, so without one to go into it becomes a note of its own next to
 * the recording rather than being lost to a transcript file.
 * @param destination - The configured/requested destination
 * @param hasHostNote - Whether an editable host note is available
 * @param writesOwnNote - Whether a note template writes the run's note
 * @returns The destination to actually use for this run
 */
export function effectiveTranscriptDestination(
	destination: TranscriptDestination,
	hasHostNote: boolean,
	writesOwnNote = false,
): TranscriptDestination {
	return !hasHostNote &&
		!writesOwnNote &&
		destination === TranscriptDestination.Note
		? TranscriptDestination.File
		: destination;
}

/**
 * A language name reduced to something a file name can carry: a dot would
 * split the extension, and a slash would move the file.
 * @param language - Language name as the user wrote it
 * @returns The label to put in the file name, or '' when nothing survives
 */
function languageLabel(language: string): string {
	return language
		.trim()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Builds the transcript sidecar file name for an audio path and format.
 * JSON uses a `.transcript.json` suffix to avoid being mistaken for other
 * JSON; subtitle/text formats use their conventional extension.
 *
 * A translation names its language, so it sits beside the original instead
 * of colliding with it and being saved under a bare `_1`.
 * @param audioPath - Vault path of the audio file
 * @param format - Transcript file format
 * @param language - Language of a translation; omitted for the original
 * @returns Sidecar file path (same directory as the audio)
 */
export function buildTranscriptFilePath(
	audioPath: string,
	format: TranscriptFileFormat,
	language = '',
): string {
	const dotIndex = audioPath.lastIndexOf('.');
	const base = dotIndex > 0 ? audioPath.slice(0, dotIndex) : audioPath;
	const suffix =
		format === TranscriptFileFormat.Json ? 'transcript.json' : format;
	const label = languageLabel(language);
	return label ? `${base}.${label}.${suffix}` : `${base}.${suffix}`;
}

/**
 * Writes the transcript to a sidecar file next to the audio, avoiding
 * collisions with an existing file.
 * @param app - Obsidian App
 * @param audioFile - Source audio file
 * @param transcript - Transcript to serialize
 * @param format - File format
 * @param language - Language of a translation; omitted for the original
 * @returns The created transcript file
 */
export async function writeTranscriptFile(
	app: App,
	audioFile: TFile,
	transcript: Transcript,
	format: TranscriptFileFormat,
	language = '',
): Promise<TFile> {
	const desired = buildTranscriptFilePath(audioFile.path, format, language);
	const directory = directoryOf(desired);
	const fileName = desired.slice(
		directory.length === 0 ? 0 : directory.length + 1,
	);
	const target = await resolveUniquePathInDirectory(directory, fileName, app);
	return app.vault.create(
		target,
		serializeTranscriptFile(transcript, format),
	);
}

/**
 * The line of a note a transcript written through the vault goes after: the
 * line embedding the recording, so the transcript sits under its player, as
 * it does when inserted at a cursor placed there. Found in the content the
 * write is applied to, by the embed's exact text, so a stale cache cannot
 * misplace it.
 * @param app - Obsidian App
 * @param note - The note being written
 * @param recording - The transcribed recording, when the caller has one
 * @param content - The note's content at the moment of the write
 * @returns The zero-based line, or null for the end of the note
 */
function lineAfterRecording(
	app: App,
	note: TFile,
	recording: TFile | null,
	content: string,
): number | null {
	const embed = recording ? embedsOf(app, note, recording)[0] : undefined;
	return embed ? lineOfText(content, embed.original) : null;
}

/**
 * Inserts a Markdown block into the given note, optionally under a heading.
 *
 * A note being edited takes the block at its cursor, through the editor, so
 * it joins what is typed there and is undone with the editor's own undo. A
 * note in Reading view, or one that is not open, has no cursor and no editor
 * that reaches its file, so it is written through the vault: under the embed
 * of the recording when the note has one, at its end otherwise. Returns false
 * only when nothing was written - the note is gone, or the write was refused -
 * so the caller can fall back.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note (the link source)
 * @param body - Markdown to insert
 * @param heading - Optional heading line (empty for none)
 * @param recording - The recording the block is about, when there is one
 */
async function insertBlockIntoNote(
	app: App,
	notePath: string,
	body: string,
	heading: string,
	recording: TFile | null,
): Promise<boolean> {
	const block = heading ? `${heading}\n\n${body}` : body;
	try {
		const editor = findNoteEditor(app, notePath);
		if (editor) {
			editor.replaceRange(`\n\n${block}\n`, editor.getCursor());
			return true;
		}
		const note = app.vault.getFileByPath(notePath);
		if (!note) {
			return false;
		}
		await app.vault.process(note, (content) =>
			withBlockInserted(
				content,
				block,
				lineAfterRecording(app, note, recording, content),
			),
		);
		return true;
	} catch (error) {
		// A refused write must not take a finished transcript with it: report
		// not-inserted so the caller can fall back to the file/notice.
		console.warn(
			`${PLUGIN_LOG_PREFIX} Could not insert into the note:`,
			error,
		);
		return false;
	}
}

/**
 * Inserts the transcript Markdown into the note the timecode links were
 * generated against, optionally under a heading: at the cursor of a note
 * being edited, through the vault otherwise. Returns true when inserted,
 * false when the note could not be written.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note (the link source)
 * @param markdown - Rendered transcript Markdown
 * @param heading - Optional heading line (empty for none)
 * @param recording - The transcribed recording, which a note written through
 *   the vault takes the transcript under the embed of
 */
export function insertTranscriptIntoNote(
	app: App,
	notePath: string,
	markdown: string,
	heading: string,
	recording: TFile | null = null,
): Promise<boolean> {
	return insertBlockIntoNote(app, notePath, markdown, heading, recording);
}

/**
 * Inserts a link to a written transcript file into the target note,
 * optionally under a heading. The link is built with
 * {@link App.fileManager.generateMarkdownLink} so it honors the vault's
 * link format (a `[[wikilink]]` when wikilinks are enabled). Returns true
 * when inserted, false when the note could not be written.
 * @param app - Obsidian App
 * @param notePath - Vault path of the target note (the link source)
 * @param transcriptFile - The written transcript file to link to
 * @param heading - Optional heading line (empty for none)
 * @param recording - The transcribed recording, which a note written through
 *   the vault takes the link under the embed of
 */
export function insertTranscriptFileLink(
	app: App,
	notePath: string,
	transcriptFile: TFile,
	heading: string,
	recording: TFile | null = null,
): Promise<boolean> {
	const link = app.fileManager.generateMarkdownLink(transcriptFile, notePath);
	return insertBlockIntoNote(app, notePath, link, heading, recording);
}

/** Outcome of writing a transcript, used to build an honest user notice. */
export interface TranscriptWriteOutcome {
	/** Whether the Markdown was inserted into the target note. */
	inserted: boolean;
	/** Sidecar file path when one was written, otherwise null. */
	filePath: string | null;
	/** Whether the user asked for in-note output. */
	noteRequested: boolean;
	/** Whether the file was written only as a fallback after a failed insert. */
	savedAsFallback: boolean;
	/** Whether the user asked to link the transcript file in the note. */
	linkRequested?: boolean;
	/** Whether a link to the transcript file was inserted into the note. */
	linkInserted?: boolean;
}

/**
 * Builds the user-facing notice for a transcript write outcome. Pure (no
 * Obsidian dependency) so the wording - especially the "could not insert"
 * cases that must never read as success - is unit tested.
 * @param outcome - What was written and what the user requested
 * @returns The notice text
 */
export function describeTranscriptOutcome(
	outcome: TranscriptWriteOutcome,
): string {
	const {
		inserted,
		filePath,
		noteRequested,
		savedAsFallback,
		linkRequested = false,
		linkInserted = false,
	} = outcome;
	if (savedAsFallback && filePath) {
		return (
			`Could not insert the transcript into the note (it could not be ` +
			`written to). Saved to ${filePath} instead.`
		);
	}
	const parts: string[] = [];
	if (inserted) {
		parts.push('inserted into the note');
	}
	if (filePath) {
		if (linkRequested) {
			// A link to the file was requested: report honestly whether it
			// landed, since the note may be gone by the time the run ends.
			parts.push(
				linkInserted
					? `saved to ${filePath} and linked in the note`
					: `saved to ${filePath} (the note could not be written to, so it is not linked there)`,
			);
		} else {
			parts.push(`saved to ${filePath}`);
		}
	}
	if (parts.length > 0) {
		return `Transcript ${parts.join(' and ')}.`;
	}
	if (noteRequested) {
		// Note output was requested but nothing was written and no fallback
		// file exists: be honest rather than claim a hollow success.
		return 'Could not write the transcript: the note could not be written to.';
	}
	return 'Transcript ready.';
}

/** How long a notice offering an action stays, so there is time to press it. */
const ACTION_NOTICE_MS = 15_000;

/**
 * Notifies the user about where the transcript was written, with a button
 * for the action the run offers, if any.
 * @param outcome - What was written and what the user requested
 * @param action - What the notice offers to do next; none for nothing
 */
export function notifyTranscriptWritten(
	outcome: TranscriptWriteOutcome,
	action?: NoticeAction | null,
): void {
	const text = describeTranscriptOutcome(outcome);
	if (!action) {
		new Notice(text);
		return;
	}
	let notice: Notice | undefined;
	const actionEl = createSpan();
	new ButtonComponent(actionEl)
		.setButtonText(action.label)
		.setClass('aar-notice-action')
		.onClick(() => {
			notice?.hide();
			action.run();
		});
	const fragment = createFragment();
	fragment.append(createSpan({ text }), ' ', actionEl);
	notice = new Notice(fragment, ACTION_NOTICE_MS);
}
