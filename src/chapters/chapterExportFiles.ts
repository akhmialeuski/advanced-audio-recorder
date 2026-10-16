/**
 * Where an exported representation of a recording's markers goes. The two
 * file formats are written beside the recording, because that is where a cue
 * sheet has to sit to point at its audio and where a description list is
 * looked for later; the outline is Markdown and goes into a note. The export
 * dialog and the command line both write through here, so a file exported
 * either way lands at the same path under the same name.
 * @module chapters/chapterExportFiles
 */

import type { App, TFile } from 'obsidian';
import { resolveUniquePathInDirectory } from '../audio/RecordingFileManager';
import { directoryOf } from '../utils/paths';
import type { PlayerMarker } from '../markers/markerModel';
import type { TimecodeLinkBuilder } from '../transcription/transcriptFormat';
import {
	formatChapterList,
	formatChapterOutline,
	formatCueSheet,
} from './chapterExport';

/**
 * The representations the markers can be written in. The keys are declared
 * in the order the export dialog offers them.
 */
export const ChapterExportView = {
	/** A timecoded list, as a video description carries one. */
	List: 'list',
	/** A cue sheet, as players and audio editors read one. */
	Cue: 'cue',
	/** A Markdown outline whose timecodes are clickable. */
	Outline: 'outline',
} as const;

/** One representation (derived from {@link ChapterExportView}). */
export type ChapterExportView =
	(typeof ChapterExportView)[keyof typeof ChapterExportView];

/** The two representations that are written as files. */
export type ChapterFileView = Exclude<
	ChapterExportView,
	typeof ChapterExportView.Outline
>;

/** What an export needs about the recording. */
export interface ChapterExportSource {
	/** The recording whose markers are exported. */
	readonly file: TFile;
	/** Its markers. */
	readonly markers: readonly PlayerMarker[];
	/** Builds a link to an offset, so an outline timecode is clickable. */
	readonly linkBuilder: TimecodeLinkBuilder;
}

/**
 * The text of one representation.
 * @param view - The representation
 * @param source - The recording and its markers
 * @returns The text, as it would be written
 */
export function chapterExportText(
	view: ChapterExportView,
	source: ChapterExportSource,
): string {
	switch (view) {
		case ChapterExportView.Cue:
			return formatCueSheet(source.markers, {
				fileName: source.file.name,
				title: source.file.basename,
			});
		case ChapterExportView.Outline:
			return formatChapterOutline(source.markers, source.linkBuilder);
		default:
			return formatChapterList(source.markers);
	}
}

/**
 * Writes the timecoded list or the cue sheet beside the recording, under a
 * name no existing file has.
 * @param app - Obsidian App
 * @param view - Which of the two file formats
 * @param source - The recording and its markers
 * @returns The vault path written
 */
export async function writeChapterExportFile(
	app: App,
	view: ChapterFileView,
	source: ChapterExportSource,
): Promise<string> {
	const base = source.file.path.replace(/\.[^.]+$/, '');
	const desired = `${base}.${view === ChapterExportView.Cue ? 'cue' : 'chapters.txt'}`;
	const directory = directoryOf(desired);
	const target = await resolveUniquePathInDirectory(
		directory,
		desired.slice(directory.length === 0 ? 0 : directory.length + 1),
		app,
	);
	await app.vault.create(target, chapterExportText(view, source));
	return target;
}
