/**
 * What the dialogs that edit rendered transcript lines in place share beyond
 * the edits themselves - the split of a line between speakers and the merge
 * of consecutive lines into one: the speaker dropdowns, the quoted excerpt of
 * a line, and the sentence saying when the transcript files are kept. What
 * an edit reads and writes lives in the speakers domain.
 * @module ui/transcriptLineDialog
 */

import type { DropdownComponent } from 'obsidian';
import type { RowSpan, LineSpeakerOption } from '../speakers/transcriptRows';
import type { TranscriptSource } from '../speakers/transcriptLineSource';
import { originalTranscriptOutputs } from '../transcription/recordedTranscript';

/** Longest excerpt of a line's text the dialogs quote. */
const EXCERPT_MAX_CHARS = 160;

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
