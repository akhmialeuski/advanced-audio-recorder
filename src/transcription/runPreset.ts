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
import {
	findProfile,
	profileIdNamed,
	ProfileKindId,
	profilesOfKind,
	setSelectedProfileId,
} from '../settings/profiles';
import { cliText } from '../obsidian/cliArgs';
import { isRefusal, type Refusable } from '../utils/refusal';
import {
	currentRunOptions,
	ENGINE_PARAM,
	MODEL_PARAM,
	PROFILES,
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

/** Settings with a preset laid over them, and why it could not be. */
export interface PresetOutcome {
	/** The settings a run starts from, with the preset marked as picked. */
	readonly settings: AudioRecorderSettings;
	/**
	 * Why the preset was not applied, in which case {@link settings} are the
	 * plugin's own. Null when it was applied, or when none was picked.
	 */
	readonly problem: string | null;
}

/**
 * The settings a run starts from once a preset is picked: the plugin's own
 * with the preset's options over them. A preset that no longer exists, or
 * the empty id, picks none.
 * @param live - The plugin's settings
 * @param presetId - Id of the preset picked, '' for none
 * @returns The settings and, when the preset could not be read, why
 */
export function settingsWithPreset(
	live: AudioRecorderSettings,
	presetId: string,
): PresetOutcome {
	const preset = profilesOfKind(live.profiles, ProfileKindId.RunPreset).find(
		(profile) => profile.id === presetId,
	);
	const run = preset ? presetRun(live, preset.body) : null;
	const settings: AudioRecorderSettings =
		run && !isRefusal(run) ? run.value.apply(live) : { ...live };
	setSelectedProfileId(settings, ProfileKindId.RunPreset, preset?.id ?? '');
	return {
		settings,
		problem: run && isRefusal(run) ? run.refusal : null,
	};
}

/** Parameter that names the preset a command-line run starts from. */
export const PRESET_PARAM = 'preset';

/**
 * What a preset states that still holds beside the typed arguments. A model
 * belongs to its engine, so the preset's model is left out when another
 * engine is typed: that engine then takes the model typed with it, or keeps
 * the one the settings have for it.
 * @param live - The plugin's settings, which name the engine a preset that
 *   states none runs on
 * @param stated - What the preset states
 * @param args - The arguments as typed
 * @returns The preset's arguments to lay the typed ones over
 */
function heldBeside(
	live: AudioRecorderSettings,
	stated: CliData,
	args: CliData,
): CliData {
	const typedEngine = cliText(args, ENGINE_PARAM)?.toLowerCase();
	const presetEngine = (
		stated[ENGINE_PARAM] ?? live.transcriptionProvider
	).toLowerCase();
	if (typedEngine === undefined || typedEngine === presetEngine) {
		return stated;
	}
	return Object.fromEntries(
		Object.entries(stated).filter(([param]) => param !== MODEL_PARAM),
	);
}

/**
 * The arguments of a run with its preset's options beneath them: what was
 * typed wins over what the preset states, as a row changed in the dialog
 * wins over the preset picked there (see {@link heldBeside} for the model).
 * @param live - The plugin's settings, which hold the presets
 * @param args - The arguments as typed
 * @returns The arguments to read the run from, or the refusal naming a
 *   preset that does not exist or does not read
 */
export function argsWithPreset(
	live: AudioRecorderSettings,
	args: CliData,
): Refusable<CliData> {
	const name = cliText(args, PRESET_PARAM);
	if (name === null) {
		return { value: args };
	}
	const picked = profileIdNamed(live.profiles, ProfileKindId.RunPreset, name);
	if (isRefusal(picked)) {
		return picked;
	}
	const stated = presetArgs(
		findProfile(live.profiles, picked.value)?.body ?? '',
	);
	return isRefusal(stated)
		? stated
		: { value: { ...heldBeside(live, stated.value, args), ...args } };
}

/**
 * The run a command line states, preset included. A profile the preset names
 * serves this run and is kept as no default: a preset holds the choices of
 * one kind of recording, and a profile it left behind would apply to the next
 * ordinary run. A profile typed on the command line is kept, as one picked in
 * the dialog is.
 * @param live - The plugin's settings
 * @param args - The arguments as typed
 * @returns The run, or the refusal naming what was typed wrong
 */
export function runWithPreset(
	live: AudioRecorderSettings,
	args: CliData,
): Refusable<TranscriptionRun> {
	const stated = argsWithPreset(live, args);
	if (isRefusal(stated)) {
		return stated;
	}
	const run = transcriptionRun(live, stated.value);
	if (isRefusal(run)) {
		return run;
	}
	const typed = new Set(
		PROFILES.filter((option) => cliText(args, option.param) !== null).map(
			(option) => option.kind,
		),
	);
	return {
		value: {
			...run.value,
			picks: run.value.picks.filter((pick) => typed.has(pick.kind)),
		},
	};
}
