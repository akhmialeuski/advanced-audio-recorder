/**
 * Where a note template writes the transcript, and how.
 *
 * `{{transcript}}` writes the transcript the way the note writes it anyway.
 * Its settings change that for this template only: `timestamps=false` or
 * `speakers=false` leave them out, and `callout="quote"` puts the whole
 * transcript in a callout, `folded=true` closed, so a long meeting does not
 * push the summary off the screen. `{{#each turns}}` repeats a block of the
 * template's own for every speaker turn instead.
 * @module templates/transcriptPart
 */

import type { HelperDelegate, HelperOptions } from 'handlebars';
import { inCallout } from './partRenderers';
import type { TemplateCatalog } from './templateCatalog';
import type { TemplateHelper } from './templateHelpers';

/** Name of the helper that writes the transcript. */
export const TRANSCRIPT_HELPER = 'transcript';

/** Settings `{{transcript}}` accepts. */
export const TRANSCRIPT_OPTIONS: readonly string[] = [
	'callout',
	'title',
	'folded',
	'timestamps',
	'speakers',
];

/** What a template changes about the transcript lines themselves. */
export interface TranscriptOverrides {
	/** Whether each line carries its timestamp; unset keeps the setting. */
	readonly timestamps?: boolean | undefined;
	/** Whether each line carries its speaker; unset keeps the setting. */
	readonly speakers?: boolean | undefined;
}

/** Writes the transcript lines with a template's overrides. */
export type TranscriptRenderer = (overrides: TranscriptOverrides) => string;

/** The fields of one speaker turn, for `{{#each turns}}`. */
export const TURN_FIELDS: TemplateCatalog = [
	{ name: 'speaker', description: 'Who spoke; empty without speakers.' },
	{ name: 'start', description: 'When the turn starts, in seconds.' },
	{ name: 'time', description: 'When it starts, as a clock reading.' },
	{ name: 'link', description: 'A link to that moment of the recording.' },
	{ name: 'text', description: 'What was said.' },
];

/**
 * A setting given as true or false, undefined otherwise.
 * @param value - The setting
 */
function flag(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/**
 * What `{{transcript}}` writes with a renderer of the run's transcript.
 * @param render - Writes the transcript lines with overrides
 * @returns The helper for one render
 */
export function transcriptHelper(render: TranscriptRenderer): HelperDelegate {
	return (...args: unknown[]) => {
		const options = args[args.length - 1] as HelperOptions;
		const hash = options.hash as Record<string, unknown>;
		return inCallout(render(transcriptOverrides(hash)), hash);
	};
}

/**
 * The overrides a template's `{{transcript}}` settings make.
 * @param hash - The helper's settings
 */
export function transcriptOverrides(
	hash: Readonly<Record<string, unknown>>,
): TranscriptOverrides {
	return {
		timestamps: flag(hash['timestamps']),
		speakers: flag(hash['speakers']),
	};
}

/**
 * The declaration of the transcript helper, for the list of helpers. Outside
 * a run it writes the transcript the template was given, callout and all.
 */
export const TRANSCRIPT_DECLARATION: TemplateHelper = {
	name: TRANSCRIPT_HELPER,
	description:
		'Writes the transcript. Settings: callout="quote" puts it in a callout, title="..." and folded=true shape that callout, timestamps=false and speakers=false leave those out of every line.',
	example: '{{transcript callout="quote" title="Transcript" folded=true}}',
	fn: (...args: unknown[]) => {
		const options = args[args.length - 1] as HelperOptions;
		const root = (options.data as { root?: { transcript?: unknown } }).root;
		const text =
			typeof root?.transcript === 'string' ? root.transcript : '';
		return inCallout(text, options.hash as Record<string, unknown>);
	},
};
