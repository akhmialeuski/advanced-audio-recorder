/**
 * Writes the note a template built: into the recording's note under the
 * transcript heading, or as a note of its own next to the recording with a
 * link to it there, and the properties its parts send to the frontmatter of
 * whichever note that is.
 *
 * A meeting protocol a page and a half long sinks in a daily note; as a note
 * of its own it is linked, found by search and kept apart. A run with no note
 * to go into writes it apart as well, since what a template writes is a note
 * and a transcript file would lose it.
 *
 * Properties are written through Obsidian's own frontmatter API, which reads
 * and writes the YAML, so the properties the note already has are kept as they
 * are. They are written before the body: an insert into an open editor is
 * saved by the editor, and a frontmatter write after it could reach the file
 * first.
 * @module transcription/templateNoteOutput
 */

import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { resolveUniquePathInDirectory } from '../audio/RecordingFileManager';
import type { NoteProperties } from '../templates/partProperties';
import { directoryOf } from '../utils/paths';
import { TemplateOutput } from './llmPostProcess';
import {
	insertTranscriptFileLink,
	insertTranscriptIntoNote,
} from './transcriptOutput';

/** One note a template built, and where it is to go. */
export interface TemplateNoteRequest {
	/** The recording the note is about. */
	readonly recording: TFile;
	/** The recording's note; '' when there is none. */
	readonly notePath: string;
	/** The note's body. */
	readonly markdown: string;
	/** The heading the body, or the link to it, goes under. */
	readonly heading: string;
	/** Name of the template, which names a note written apart. */
	readonly templateName: string;
	/** The properties its parts write. */
	readonly properties: NoteProperties;
	/** Where the settings send it. */
	readonly output: TemplateOutput;
}

/**
 * The path of the note the template's body went into, or null when it could
 * not be written.
 */
export type TemplateNotePath = string | null;

/**
 * The name a note written apart is given: the recording's, then the
 * template's, so a second template on the same recording sits beside the first.
 * @param recording - The recording
 * @param templateName - The template's name
 */
export function separateNoteName(
	recording: TFile,
	templateName: string,
): string {
	return `${recording.basename} - ${templateName}.md`;
}

/**
 * Writes the properties into a note's frontmatter, keeping every other one.
 * A failure is told rather than thrown: the note itself is written.
 * @param app - Obsidian App
 * @param path - The note
 * @param properties - The properties to set
 */
export async function writeNoteProperties(
	app: App,
	path: string,
	properties: NoteProperties,
): Promise<void> {
	if (Object.keys(properties).length === 0) {
		return;
	}
	const note = app.vault.getAbstractFileByPath(path);
	if (!(note instanceof TFile)) {
		return;
	}
	try {
		await app.fileManager.processFrontMatter(
			note,
			(frontmatter: Record<string, unknown>) => {
				Object.assign(frontmatter, properties);
			},
		);
	} catch (error) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Could not write the properties of ${path}:`,
			error,
		);
		new Notice(
			`The note template's properties could not be written to ${path}.`,
		);
	}
}

/**
 * Writes the note into the recording's note, under the heading.
 * @param app - Obsidian App
 * @param request - The note and where it goes
 */
async function intoRecordingNote(
	app: App,
	request: TemplateNoteRequest,
): Promise<TemplateNotePath> {
	const { notePath } = request;
	await writeNoteProperties(app, notePath, request.properties);
	const inserted = await insertTranscriptIntoNote(
		app,
		notePath,
		request.markdown,
		request.heading,
		request.recording,
	);
	return inserted ? notePath : null;
}

/**
 * Writes the note as a note of its own next to the recording, and links it
 * from the recording's note when there is one.
 * @param app - Obsidian App
 * @param request - The note and where it goes
 */
async function apart(
	app: App,
	request: TemplateNoteRequest,
): Promise<TemplateNotePath> {
	const { recording, notePath } = request;
	const path = await resolveUniquePathInDirectory(
		directoryOf(recording.path),
		separateNoteName(recording, request.templateName),
		app,
	);
	let note: TFile;
	try {
		note = await app.vault.create(path, request.markdown);
	} catch (error) {
		console.warn(`${PLUGIN_LOG_PREFIX} Could not create ${path}:`, error);
		return null;
	}
	await writeNoteProperties(app, path, request.properties);
	if (notePath !== '') {
		// The note itself is written; a link that could not be is told, and
		// the note is still where its body is.
		const linked = await insertTranscriptFileLink(
			app,
			notePath,
			note,
			request.heading,
			recording,
		);
		if (!linked) {
			new Notice(
				`Wrote ${path}, but could not link it from ${notePath}.`,
			);
		}
	}
	return path;
}

/**
 * Writes the note a template built where the settings send it.
 * @param app - Obsidian App
 * @param request - The note and where it goes
 * @returns The path of the note its body went into, null when it could not
 *   be written
 */
export function writeTemplateNote(
	app: App,
	request: TemplateNoteRequest,
): Promise<TemplateNotePath> {
	return request.output === TemplateOutput.Separate || request.notePath === ''
		? apart(app, request)
		: intoRecordingNote(app, request);
}
