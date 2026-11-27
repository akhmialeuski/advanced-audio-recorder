/**
 * Runs the Templater commands of a text through the Templater plugin, when it
 * is installed and enabled.
 *
 * Templater is a community plugin, so the plugin cannot depend on it: when it
 * is missing, the commands stay in the text as typed and the caller says so.
 * Templater offers no typed API to other plugins; what it exposes on its
 * plugin instance, `templater.create_running_config` and
 * `templater.parse_template`, is checked here before every use, so a
 * Templater that changed them reads as missing rather than throwing from
 * deep inside a run.
 * @module obsidian/templater
 */

import type { App, TFile } from 'obsidian';
import { errorMessage } from '../errors';

/** Templater's plugin id. */
export const TEMPLATER_PLUGIN_ID = 'templater-obsidian';

/**
 * Templater's `RunMode.DynamicProcessor`: a text processed on its own, not a
 * template inserted into or creating a file.
 */
const DYNAMIC_PROCESSOR_RUN_MODE = 4;

/** A `<% ... %>` command, in any of Templater's forms. */
const COMMAND = /<%[\s\S]*?%>/;

/** What Templater's plugin instance offers for processing a text. */
interface TemplaterApi {
	create_running_config(
		templateFile: TFile | undefined,
		targetFile: TFile,
		runMode: number,
	): unknown;
	parse_template(config: unknown, text: string): Promise<string>;
}

/** How processing a text went. */
export const TemplaterOutcome = {
	/** The text holds no command, so Templater was not asked. */
	NoCommands: 'noCommands',
	/** Templater processed the text. */
	Processed: 'processed',
	/** The text holds commands, and Templater is not installed or enabled. */
	Missing: 'missing',
	/** Templater failed on the text, which is left as it was. */
	Failed: 'failed',
} as const;

/** How processing went (derived from {@link TemplaterOutcome}). */
export type TemplaterOutcome =
	(typeof TemplaterOutcome)[keyof typeof TemplaterOutcome];

/** The text after Templater, and how it went. */
export interface TemplaterResult {
	readonly text: string;
	readonly outcome: TemplaterOutcome;
	/** Templater's error, for a failed run. */
	readonly error?: string | undefined;
}

/**
 * Whether a text holds a Templater command.
 * @param text - The text
 */
export function hasTemplaterCommands(text: string): boolean {
	return COMMAND.test(text);
}

/**
 * Templater's processing API, when the plugin is enabled and offers it.
 * @param app - Obsidian App
 */
function templaterOf(app: App): TemplaterApi | null {
	// `app.plugins` is internal API; every step is checked.
	const plugins = (app as { plugins?: { getPlugin?: unknown } }).plugins;
	const getPlugin = plugins?.getPlugin;
	if (typeof getPlugin !== 'function') {
		return null;
	}
	const plugin: unknown = getPlugin.call(plugins, TEMPLATER_PLUGIN_ID);
	const api = (plugin as { templater?: Partial<TemplaterApi> } | null)
		?.templater;
	return typeof api?.create_running_config === 'function' &&
		typeof api.parse_template === 'function'
		? (api as TemplaterApi)
		: null;
}

/**
 * Processes the Templater commands of a text, its `tp.file` being the target.
 * @param app - Obsidian App
 * @param text - The text
 * @param target - The file `tp.file` describes
 * @returns The text, processed when it could be, and how it went
 */
export async function runTemplater(
	app: App,
	text: string,
	target: TFile,
): Promise<TemplaterResult> {
	if (!hasTemplaterCommands(text)) {
		return { text, outcome: TemplaterOutcome.NoCommands };
	}
	const templater = templaterOf(app);
	if (!templater) {
		return { text, outcome: TemplaterOutcome.Missing };
	}
	try {
		const config = templater.create_running_config(
			undefined,
			target,
			DYNAMIC_PROCESSOR_RUN_MODE,
		);
		return {
			text: await templater.parse_template(config, text),
			outcome: TemplaterOutcome.Processed,
		};
	} catch (error) {
		return {
			text,
			outcome: TemplaterOutcome.Failed,
			error: errorMessage(error),
		};
	}
}
