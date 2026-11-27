/**
 * The facts of a transcription run a template can name.
 *
 * A prompt that reads "summarize this meeting" cannot know the meeting is the
 * weekly sync of three named people held on Thursday, although the run holds
 * every one of those facts when it calls the model. This module declares them
 * once: the catalogue below is what a template is checked against, what the
 * renderer looks names up in, and what the list of variables on a profile page
 * shows, so the three cannot disagree.
 *
 * It is pure on purpose. Collecting the facts needs the vault, the settings and
 * the transcript, and lives with the run; the settings tree only needs the
 * catalogue to check a prompt as it is typed, and imports it from here without
 * pulling the run in after it.
 * @module templates/runVariables
 */

import type { TemplateCatalog } from './templateCatalog';
import type { TemplateContext } from './TemplateEngine';

/** The facts one run collected, as plain values. */
export interface RunFacts {
	/** Name of the note the result goes to, or of the recording without one. */
	readonly title: string;
	/** Vault path of the note the result goes to; '' without one. */
	readonly notePath: string;
	/** File name of the recording, with its extension. */
	readonly recordingName: string;
	/** Vault path of the recording. */
	readonly recordingPath: string;
	/** A link to the recording, written the way the vault writes links. */
	readonly recordingLink: string;
	/** When the recording was made, in epoch milliseconds, when known. */
	readonly recordedAt: number | null;
	/** How long the recording is, in seconds, when known. */
	readonly durationSeconds: number | null;
	/** The language the transcript is in, when the engine said. */
	readonly language: string;
	/** Names of the run's participant profile. */
	readonly participants: readonly string[];
	/** Distinct speakers of the transcript, as the note names them. */
	readonly speakers: readonly string[];
	/** Terms of the run's dictionary profile. */
	readonly dictionary: readonly string[];
	/** Tags of the note the result goes to, without the leading '#'. */
	readonly tags: readonly string[];
	/**
	 * Properties of the note the result goes to. Only those a template names
	 * are read, so a note with private fields does not reach a model whole
	 * because a prompt mentioned one field of it.
	 */
	readonly properties: Readonly<Record<string, unknown>>;
}

/** The root a template reads properties under, e.g. `properties.project`. */
export const PROPERTIES_ROOT = 'properties';

/**
 * Every fact a template can name, with what it holds and an example value.
 * The order is the order the list of variables shows them in.
 */
export const RUN_VARIABLES: TemplateCatalog = [
	{
		name: 'title',
		description:
			'Name of the note the result goes to, or of the recording when there is no note.',
		example: 'Weekly sync',
	},
	{
		name: 'notePath',
		description: 'Vault path of the note the result goes to.',
		example: 'Meetings/Weekly sync.md',
	},
	{
		name: 'recordingName',
		description: 'File name of the recording.',
		example: 'recording-2026-09-22.webm',
	},
	{
		name: 'recordingPath',
		description: 'Vault path of the recording.',
		example: 'Recordings/recording-2026-09-22.webm',
	},
	{
		name: 'recordingLink',
		description: 'A link to the recording.',
		example: '[[recording-2026-09-22.webm]]',
	},
	{
		name: 'recordedAt',
		description:
			'When the recording was made; format it with the date helper.',
		example: '{{date recordedAt format="D MMMM YYYY"}}',
	},
	{
		name: 'durationSeconds',
		description:
			'Length of the recording in seconds; {{duration}} writes it as a clock reading.',
		example: '3725',
	},
	{
		name: 'language',
		description: 'Language of the transcript, when the engine reported it.',
		example: 'en',
	},
	{
		name: 'participants',
		description: 'Names of the participant profile used for the run.',
		example: 'Anna, Ben',
	},
	{
		name: 'speakers',
		description: 'Distinct speakers of the transcript.',
		example: 'Anna, Speaker 2',
	},
	{
		name: 'dictionary',
		description: 'Terms of the dictionary profile used for the run.',
		example: 'Kubernetes, OKR',
	},
	{
		name: 'tags',
		description: 'Tags of the note the result goes to.',
		example: 'meeting, project/atlas',
	},
	{
		name: PROPERTIES_ROOT,
		description:
			'Properties of the note the result goes to, e.g. properties.project. Only the ones named are read.',
		example: '{{properties.project}}',
		open: true,
	},
];

/**
 * The values a template renders with, from the facts of a run.
 * @param facts - What the run collected
 * @returns The context, with every catalogue name present
 */
export function runTemplateContext(facts: RunFacts): TemplateContext {
	return { ...facts };
}
