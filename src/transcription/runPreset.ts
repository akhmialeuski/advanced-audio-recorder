/**
 * A transcription preset: the choices of one run, saved under a name.
 *
 * A lesson recorded twice a week wants Gemini, two languages, speaker labels
 * and its own cleanup profile, while every other recording wants the engine
 * and the language the settings hold. Setting those four things by hand
 * before each lesson, and back after it, is what a preset replaces.
 *
 * A preset holds no settings of its own shape. Its text is the parameters the
 * transcribe command takes, one to a line, and it is read by the table that
 * reads the command line, so a choice means the same wherever it is written
 * and a wrong value is refused in the same words:
 *
 *     engine: gemini
 *     language: pl, uk
 *     diarize: on
 *     cleanup: Language lesson
 *
 * A parameter the text leaves out stays as the settings have it.
 * @module transcription/runPreset
 */

import type { CliData } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { isRefusal, type Refusable } from '../utils/refusal';
import {
	currentRunOptions,
	RUN_PARAMS,
	transcriptionRun,
	type TranscriptionRun,
} from './runOptions';

/** What separates a parameter from its value on a line. */
const SEPARATOR = ':';

/** What opens a line that is a remark and no parameter. */
const REMARK = '#';

/**
 * Reads a preset's text into the arguments a command line would carry.
 * @param body - The preset's text
 * @returns Each parameter with its value, or the refusal naming the line
 *   that is no parameter of a run
 */
export function presetArgs(body: string): Refusable<CliData> {
	const args: CliData = {};
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith(REMARK)) {
			continue;
		}
		const at = line.indexOf(SEPARATOR);
		const param = (at < 0 ? line : line.slice(0, at)).trim().toLowerCase();
		const value = at < 0 ? '' : line.slice(at + 1).trim();
		if (!RUN_PARAMS.includes(param) || value === '') {
			return {
				refusal: `"${line}" is not an option of a run. Write one per line as name: value, with one of: ${RUN_PARAMS.join(', ')}.`,
			};
		}
		args[param] = value;
	}
	return { value: args };
}

/**
 * The run a preset makes over the settings.
 * @param live - The plugin's settings, which name the profiles to pick from
 * @param body - The preset's text
 * @returns The run, or the refusal naming what the preset states wrong
 */
export function presetRun(
	live: AudioRecorderSettings,
	body: string,
): Refusable<TranscriptionRun> {
	const args = presetArgs(body);
	return isRefusal(args) ? args : transcriptionRun(live, args.value);
}

/**
 * How many options a preset sets.
 * @param body - The preset's text
 * @returns The count, or null when the text does not read as a preset
 */
export function presetOptionCount(body: string): number | null {
	const args = presetArgs(body);
	return isRefusal(args) ? null : Object.keys(args.value).length;
}

/**
 * The text of a preset that reproduces the given settings.
 * @param settings - The settings of the run to save
 * @returns The preset's text, one parameter to a line
 */
export function presetBodyOf(settings: AudioRecorderSettings): string {
	return currentRunOptions(settings)
		.filter(([, value]) => value.trim() !== '')
		.map(([param, value]) => `${param}${SEPARATOR} ${value}`)
		.join('\n');
}
