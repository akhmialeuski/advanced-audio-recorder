/**
 * The Templater commands of a note template, run before anything else reads
 * the template.
 *
 * They run on the template the user wrote and on nothing else: run on the
 * assembled note instead, they would also run whatever `<% %>` a model wrote
 * or a speaker said, which is JavaScript from text nobody chose to trust.
 * Their output then goes through the parts and variables like the rest of
 * the template, so a command can write `{{#part}}` blocks or decide which
 * ones the note has.
 * @module transcription/templaterStep
 */

import { Notice } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { runTemplater, TemplaterOutcome } from '../obsidian/templater';
import type { RunFactsSource } from './runFacts';

/**
 * The template with its Templater commands run, `tp.file` being the note the
 * recording is in, or the recording when it is in none. Commands that could
 * not run are left as typed, and the user is told why.
 * @param source - The run: the app, the recording and its note
 * @param template - The template's text
 * @param templateName - The template's name, for what the user is told
 */
export async function withTemplaterCommandsRun(
	source: RunFactsSource,
	template: string,
	templateName: string,
): Promise<string> {
	const { app, recording, notePath } = source;
	const note = notePath ? app.vault.getFileByPath(notePath) : null;
	const result = await runTemplater(app, template, note ?? recording);
	if (result.outcome === TemplaterOutcome.Missing) {
		new Notice(
			`The note template "${templateName}" has Templater commands, and Templater is not installed or enabled, so they were left as they are.`,
		);
	}
	if (result.outcome === TemplaterOutcome.Failed) {
		console.warn(
			`${PLUGIN_LOG_PREFIX} Templater failed on "${templateName}":`,
			result.error,
		);
		new Notice(
			`Templater could not run the commands of the note template "${templateName}" (${result.error ?? 'unknown error'}), so they were left as they are.`,
		);
	}
	return result.text;
}
