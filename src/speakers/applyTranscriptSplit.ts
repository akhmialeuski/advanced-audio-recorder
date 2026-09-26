/**
 * Vault-side application of a transcript line split, beyond the note line the
 * dialog rewrites in the editor: the transcript files the recording's sidecar
 * recorded are rewritten from the split JSON transcript, and the speakers the
 * split created join the sidecar roster so the rename dialog lists them.
 *
 * Only the JSON output keeps what a split needs - segment ends, speakers and
 * word timings - so the files are rewritten only when it was recorded and the
 * line's segments were found in it; otherwise they are kept as they are and
 * the outcome says so, rather than inventing what subtitles or plain text
 * dropped. Translations are never touched: their text is another language's
 * and cannot be cut where the original was.
 * @module speakers/applyTranscriptSplit
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
import { splitTranscriptRow, type RowSpan } from './transcriptSplit';

/** The slice of the recording sidecar store a split writes. */
export interface TranscriptSplitSidecar {
	/** Appends speakers to a recording's roster, leaving stored ones as they are. */
	addSpeakers(path: string, entries: readonly SpeakerEntry[]): Promise<void>;
}

/** Everything a split writes besides the note line. */
export interface TranscriptSplitWrite {
	/** Vault path of the recording. */
	audioPath: string;
	/** The recording's sidecar transcript section, as read for the split. */
	section: TranscriptSection;
	/** The recorded JSON transcript, or null when none could be read. */
	recorded: RecordedTranscript | null;
	/** The line's segments in it, or null when they were not found. */
	span: RowSpan | null;
	/** The pieces the line was split into. */
	pieces: readonly TranscriptSegment[];
	/** Roster entries the split created. */
	added: readonly SpeakerEntry[];
}

/** What a split wrote besides the note line. */
export interface TranscriptSplitOutcome {
	/** Transcript files rewritten with the split. */
	rewrittenFiles: number;
	/**
	 * Transcript files of the recording's own transcript kept as they were,
	 * because no JSON transcript held the line to split.
	 */
	keptFiles: number;
	/** Speakers added to the recording's roster. */
	addedSpeakers: number;
}

/**
 * Writes a split to the recording's transcript files and roster.
 * @param app - Obsidian App
 * @param sidecar - Recording sidecar access
 * @param write - What to write
 * @returns What was written
 */
export async function applyTranscriptSplit(
	app: App,
	sidecar: TranscriptSplitSidecar,
	write: TranscriptSplitWrite,
): Promise<TranscriptSplitOutcome> {
	let rewrittenFiles = 0;
	let keptFiles = 0;
	if (write.recorded && write.span) {
		rewrittenFiles = await rewriteRecordedTranscriptFiles(
			app,
			splitTranscriptRow(
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

/**
 * The notice a finished split shows: that the line was split, what else was
 * updated, and - never silently - which transcript files were kept as they
 * were and why.
 * @param outcome - What the split wrote
 * @param renameOffered - Whether the "Rename speakers" action is enabled, so
 *   the notice points at it only when it can be found
 * @returns The notice text
 */
export function describeTranscriptSplit(
	outcome: TranscriptSplitOutcome,
	renameOffered: boolean,
): string {
	const parts = ['Split the transcript line.'];
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
			`${String(outcome.keptFiles)} transcript file${outcome.keptFiles === 1 ? ' was' : 's were'} kept as ${outcome.keptFiles === 1 ? 'it was' : 'they were'}: only a JSON transcript holding this line keeps the timings a split needs.`,
		);
	}
	return parts.join(' ');
}
