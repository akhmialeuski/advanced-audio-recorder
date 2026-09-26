/**
 * Vault-side application of an edit to rendered transcript lines - a line
 * split between speakers, or consecutive lines merged into one - beyond the
 * note lines the dialog rewrites in the editor: the transcript files the
 * recording's sidecar recorded are rewritten from the edited JSON transcript,
 * and the speakers the edit created join the sidecar roster so the rename
 * dialog lists them.
 *
 * Only the JSON output keeps what such an edit needs - segment ends, speakers
 * and word timings - so the files are rewritten only when it was recorded and
 * the lines' segments were found in it; otherwise they are kept as they are
 * and the outcome says so, rather than inventing what subtitles or plain text
 * dropped. Translations are never touched: their text is another language's
 * and cannot be cut or joined where the original was.
 * @module speakers/applyTranscriptEdit
 */

import type { App } from 'obsidian';
import type {
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import {
	originalTranscriptOutputs,
	rewriteRecordedTranscriptFiles,
	type RecordedTranscript,
} from '../transcription/recordedTranscript';
import type { TranscriptSegment } from '../transcription/TranscriptTypes';
import { replaceTranscriptRow, type RowSpan } from './transcriptSplit';

/** The slice of the recording sidecar store an edit writes. */
export interface TranscriptEditSidecar {
	/** Appends speakers to a recording's roster, leaving stored ones as they are. */
	addSpeakers(path: string, entries: readonly SpeakerEntry[]): Promise<void>;
}

/** Everything an edit writes besides the note lines. */
export interface TranscriptEditWrite {
	/** Vault path of the recording. */
	audioPath: string;
	/** The recording's sidecar transcript section, as read for the edit. */
	section: TranscriptSection;
	/** The recorded JSON transcript, or null when none could be read. */
	recorded: RecordedTranscript | null;
	/** The lines' segments in it, or null when they were not found. */
	span: RowSpan | null;
	/** The segments the lines become. */
	pieces: readonly TranscriptSegment[];
	/** Roster entries the edit created. */
	added: readonly SpeakerEntry[];
}

/** What an edit wrote besides the note lines. */
export interface TranscriptEditOutcome {
	/** Transcript files rewritten with the edit. */
	rewrittenFiles: number;
	/**
	 * Transcript files of the recording's own transcript kept as they were,
	 * because no JSON transcript held the lines to edit.
	 */
	keptFiles: number;
	/** Speakers added to the recording's roster. */
	addedSpeakers: number;
}

/**
 * Writes an edit to the recording's transcript files and roster.
 * @param app - Obsidian App
 * @param sidecar - Recording sidecar access
 * @param write - What to write
 * @returns What was written
 */
export async function applyTranscriptEdit(
	app: App,
	sidecar: TranscriptEditSidecar,
	write: TranscriptEditWrite,
): Promise<TranscriptEditOutcome> {
	let rewrittenFiles = 0;
	let keptFiles = 0;
	if (write.recorded && write.span) {
		rewrittenFiles = await rewriteRecordedTranscriptFiles(
			app,
			replaceTranscriptRow(
				write.recorded.transcript,
				write.span,
				write.pieces,
			),
			write.recorded.outputs,
		);
	} else {
		keptFiles = originalTranscriptOutputs(write.section.fileOutputs).filter(
			(output) => app.vault.getFileByPath(output.path),
		).length;
	}
	if (write.added.length > 0) {
		await sidecar.addSpeakers(write.audioPath, write.added);
	}
	return { rewrittenFiles, keptFiles, addedSpeakers: write.added.length };
}

/** How a notice names the edit it reports. */
interface EditWording {
	/** The sentence saying what was done to the note. */
	done: string;
	/** The lines the edit worked on ("this line", "these lines"). */
	lines: string;
	/** The edit itself ("a split", "a merge"). */
	edit: string;
}

/**
 * The notice a finished edit shows: what was done, what else was updated,
 * and - never silently - which transcript files were kept as they were and
 * why.
 * @param wording - How the edit is named
 * @param outcome - What the edit wrote
 * @param renameOffered - Whether the "Rename speakers" action is enabled, so
 *   the notice points at it only when it can be found
 * @returns The notice text
 */
function describeTranscriptEdit(
	wording: EditWording,
	outcome: TranscriptEditOutcome,
	renameOffered: boolean,
): string {
	const parts = [wording.done];
	if (outcome.rewrittenFiles > 0) {
		parts.push(
			`Updated ${String(outcome.rewrittenFiles)} transcript file${outcome.rewrittenFiles === 1 ? '' : 's'}.`,
		);
	}
	if (outcome.addedSpeakers > 0) {
		const added = `Added ${String(outcome.addedSpeakers)} speaker${outcome.addedSpeakers === 1 ? '' : 's'} to the recording`;
		parts.push(
			renameOffered
				? `${added}, so "Rename speakers" can name ${outcome.addedSpeakers === 1 ? 'it' : 'them'}.`
				: `${added}.`,
		);
	}
	if (outcome.keptFiles > 0) {
		parts.push(
			`${String(outcome.keptFiles)} transcript file${outcome.keptFiles === 1 ? ' was' : 's were'} kept as ${outcome.keptFiles === 1 ? 'it was' : 'they were'}: only a JSON transcript holding ${wording.lines} keeps the timings ${wording.edit} needs.`,
		);
	}
	return parts.join(' ');
}

/**
 * The notice a finished split shows.
 * @param outcome - What the split wrote
 * @param renameOffered - Whether the "Rename speakers" action is enabled
 * @returns The notice text
 */
export function describeTranscriptSplit(
	outcome: TranscriptEditOutcome,
	renameOffered: boolean,
): string {
	return describeTranscriptEdit(
		{
			done: 'Split the transcript line.',
			lines: 'this line',
			edit: 'a split',
		},
		outcome,
		renameOffered,
	);
}

/**
 * The notice a finished merge shows.
 * @param lineCount - How many note lines were merged into one
 * @param outcome - What the merge wrote
 * @param renameOffered - Whether the "Rename speakers" action is enabled
 * @returns The notice text
 */
export function describeTranscriptMerge(
	lineCount: number,
	outcome: TranscriptEditOutcome,
	renameOffered: boolean,
): string {
	return describeTranscriptEdit(
		{
			done: `Merged ${String(lineCount)} transcript lines into one.`,
			lines: 'these lines',
			edit: 'a merge',
		},
		outcome,
		renameOffered,
	);
}
