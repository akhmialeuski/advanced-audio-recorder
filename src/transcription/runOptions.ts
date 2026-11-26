/**
 * What one transcription run may change, by name.
 *
 * The Transcribe dialog lets the user change the engine, the language, the
 * switches and the profiles for one run. The same choices are named here, each
 * with the values it takes, so that anything which states a run in words - a
 * command line, a saved preset - is read by one table and refused by one set
 * of messages. The arguments arrive in the shape Obsidian's command line gives
 * them, a record of name to text, which is also the simplest shape a saved
 * list of choices can take.
 * @module transcription/runOptions
 */

import type { CliData } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	ProfileKindId,
	profileIdNamed,
	setSelectedProfileId,
} from '../settings/profiles';
import {
	LLM_TASK_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
	type LabeledOption,
} from '../settings/labels';
import { cliChoice, cliSwitch, cliText } from '../obsidian/cliArgs';
import { engineOfTranscription } from '../providers/providers';
import { isRefusal, type Refusable } from '../utils/refusal';

/** The settings a dropdown of the dialog sets for one run. */
type ChoiceSetting =
	| 'transcriptionProvider'
	| 'transcriptDestination'
	| 'transcriptFileFormat'
	| 'llmPostProcessTask';

/** A dropdown of the dialog, as a parameter. */
interface ChoiceOption {
	readonly param: string;
	readonly values: readonly string[];
	readonly description: string;
	/**
	 * Reads the parameter and, when it was given, sets the run to it.
	 * @returns The change to make, null when not given, or the refusal
	 */
	readonly read: (
		args: CliData,
	) => Refusable<((run: AudioRecorderSettings) => void) | null>;
}

/**
 * A dropdown of the dialog as a parameter, typed by the setting it sets, so
 * a value the command line accepts is one the setting can hold.
 * @param param - The parameter name
 * @param setting - The setting it sets for the run
 * @param options - The dropdown's options
 * @param description - One line for the help output
 */
function choice<K extends ChoiceSetting>(
	param: string,
	setting: K,
	options: readonly LabeledOption<AudioRecorderSettings[K]>[],
	description: string,
): ChoiceOption {
	const values = options.map((option) => option.value);
	return {
		param,
		values,
		description,
		read: (args) => {
			const read = cliChoice(args, param, values);
			if (isRefusal(read)) {
				return read;
			}
			const { value } = read;
			return {
				value:
					value === null
						? null
						: (run: AudioRecorderSettings): void => {
								run[setting] = value;
							},
			};
		},
	};
}

/** A switch of the dialog, as a parameter. */
interface SwitchOption {
	readonly param: string;
	readonly description: string;
	readonly apply: (run: AudioRecorderSettings, on: boolean) => void;
}

/** A profile picker of the dialog, as a parameter. */
interface ProfileOption {
	readonly param: string;
	readonly kind: ProfileKindId;
	readonly description: string;
}

/** Parameter that names the engine of the run. */
const ENGINE_PARAM = 'engine';

/** The engines a run may name. */
const ENGINE_VALUES = TRANSCRIPTION_PROVIDER_OPTIONS.map(
	(option) => option.value,
);

/** The dialog's dropdowns. */
export const CHOICES: readonly ChoiceOption[] = [
	choice(
		ENGINE_PARAM,
		'transcriptionProvider',
		TRANSCRIPTION_PROVIDER_OPTIONS,
		'Transcription engine for this run.',
	),
	choice(
		'destination',
		'transcriptDestination',
		TRANSCRIPT_DESTINATION_OPTIONS,
		'Where the transcript goes.',
	),
	choice(
		'format',
		'transcriptFileFormat',
		TRANSCRIPT_FILE_FORMAT_OPTIONS,
		'Format of the transcript file.',
	),
	choice(
		'task',
		'llmPostProcessTask',
		LLM_TASK_OPTIONS,
		'LLM post-processing task.',
	),
];

/** The dialog's switches. */
export const SWITCHES: readonly SwitchOption[] = [
	{
		param: 'diarize',
		description: 'Speaker diarization.',
		apply: (run, on) => {
			run.transcriptionDiarize = on;
		},
	},
	{
		param: 'words',
		description: 'Word-level timestamps.',
		apply: (run, on) => {
			run.transcriptionWordTimestamps = on;
		},
	},
	{
		param: 'advanced',
		description: 'Advanced settings: the dictionary and two-pass mode.',
		apply: (run, on) => {
			run.transcriptionAdvancedSettingsEnabled = on;
		},
	},
	{
		param: 'twopass',
		description: 'Advanced two-pass transcription.',
		apply: (run, on) => {
			run.transcriptionAdvancedEnabled = on;
		},
	},
	{
		param: 'timestamps',
		description: 'Timestamps in the transcript written into the note.',
		apply: (run, on) => {
			run.transcriptIncludeTimestamps = on;
		},
	},
	{
		param: 'speakers',
		description: 'Speaker names in the transcript written into the note.',
		apply: (run, on) => {
			run.transcriptIncludeSpeakers = on;
		},
	},
	{
		param: 'postprocess',
		description: 'LLM post-processing.',
		apply: (run, on) => {
			run.llmPostProcessEnabled = on;
		},
	},
	{
		param: 'chapters',
		description: 'Generate chapters after transcribing.',
		apply: (run, on) => {
			run.transcriptionAutoChaptersOnTranscribe = on;
		},
	},
];

/** The dialog's profile pickers. */
export const PROFILES: readonly ProfileOption[] = [
	{
		param: 'participants',
		kind: ProfileKindId.Participants,
		description: 'Participant profile, by name, or none.',
	},
	{
		param: 'dictionary',
		kind: ProfileKindId.Dictionary,
		description: 'Dictionary profile, by name, or none.',
	},
	{
		param: 'guidance',
		kind: ProfileKindId.ChapterPrompt,
		description: 'Chapter guidance profile, by name, or none.',
	},
	{
		param: 'cleanup',
		kind: ProfileKindId.LlmCleanup,
		description: 'Cleanup prompt profile, by name, or none.',
	},
	{
		param: 'summary',
		kind: ProfileKindId.LlmSummary,
		description: 'Summary prompt profile, by name, or none.',
	},
	{
		param: 'translation',
		kind: ProfileKindId.LlmTranslate,
		description: 'Translation prompt profile, by name, or none.',
	},
	{
		param: 'instruction',
		kind: ProfileKindId.LlmCustom,
		description: 'Custom instruction profile, by name, or none.',
	},
];

/** Parameter that names the model of the run's engine. */
export const MODEL_PARAM = 'model';

/** A profile choice the run makes, kept as the default the way the dialog keeps it. */
export interface ProfilePick {
	/** Kind of the profile. */
	readonly kind: ProfileKindId;
	/** Id picked, '' for none. */
	readonly id: string;
}

/** A run's choices and the profile picks that outlive it. */
export interface TranscriptionRun {
	/**
	 * The settings with every typed choice applied on top: a reader, so the
	 * dialog reads the plugin's settings as they stand when it does, the way
	 * every other surface hands it them.
	 * @param live - The plugin's settings
	 */
	readonly apply: (live: AudioRecorderSettings) => AudioRecorderSettings;
	/** Profile picks, which the dialog stores as the next defaults. */
	readonly picks: readonly ProfilePick[];
}

/** One change to a run's copy of the settings. */
type Change = (run: AudioRecorderSettings) => void;

/** What one group of parameters read: its changes and its profile picks. */
interface Reading {
	readonly changes: readonly Change[];
	readonly picks: readonly ProfilePick[];
}

/** Reads one group of parameters, or refuses naming what was typed wrong. */
type Reader = (
	live: AudioRecorderSettings,
	args: CliData,
) => Refusable<Reading>;

/**
 * A reading that changes settings and picks no profile.
 * @param changes - The changes
 * @returns The reading
 */
function changesOnly(changes: readonly Change[]): Refusable<Reading> {
	return { value: { changes, picks: [] } };
}

/** Reads the language, which takes any text. */
const readLanguage: Reader = (_live, args) => {
	const language = cliText(args, 'language');
	return changesOnly(
		language === null
			? []
			: [
					(run) => {
						run.transcriptionLanguage = language;
					},
				],
	);
};

/** Reads the dropdowns. */
const readChoices: Reader = (_live, args) => {
	const changes: Change[] = [];
	for (const option of CHOICES) {
		const read = option.read(args);
		if (isRefusal(read)) {
			return read;
		}
		if (read.value !== null) {
			changes.push(read.value);
		}
	}
	return changesOnly(changes);
};

/** Reads the switches. */
const readSwitches: Reader = (_live, args) => {
	const changes: Change[] = [];
	for (const option of SWITCHES) {
		const read = cliSwitch(args, option.param);
		if (isRefusal(read)) {
			return read;
		}
		const { value } = read;
		if (value !== null) {
			changes.push((run) => {
				option.apply(run, value);
			});
		}
	}
	return changesOnly(changes);
};

/** Reads the profile pickers, each by the name of a profile of its kind. */
const readProfiles: Reader = (live, args) => {
	const changes: Change[] = [];
	const picks: ProfilePick[] = [];
	for (const option of PROFILES) {
		const name = cliText(args, option.param);
		if (name === null) {
			continue;
		}
		const picked = profileIdNamed(live.profiles, option.kind, name);
		if (isRefusal(picked)) {
			return picked;
		}
		const id = picked.value;
		picks.push({ kind: option.kind, id });
		changes.push((run) => {
			setSelectedProfileId(run, option.kind, id);
		});
	}
	return { value: { changes, picks } };
};

/**
 * Reads the model, which belongs to whichever engine the run ends up on:
 * the one typed beside it, or the one the settings name. An engine with no
 * model to choose refuses it, since the value would go nowhere.
 */
const readModel: Reader = (live, args) => {
	const model = cliText(args, MODEL_PARAM);
	if (model === null) {
		return changesOnly([]);
	}
	const typed = cliChoice(args, ENGINE_PARAM, ENGINE_VALUES);
	if (isRefusal(typed)) {
		return typed;
	}
	const id = typed.value ?? live.transcriptionProvider;
	const models = engineOfTranscription(id)?.models;
	if (!models) {
		return {
			refusal: `${MODEL_PARAM}=${model} cannot be applied: the ${id} engine has no model to choose.`,
		};
	}
	return changesOnly([
		(run) => {
			models.setModel(run, model);
		},
	]);
};

/** The groups, in the order their changes are applied. */
const READERS: readonly Reader[] = [
	readLanguage,
	readModel,
	readChoices,
	readSwitches,
	readProfiles,
];

/**
 * Reads what was typed into changes to a run's settings, the way the
 * dialog's controls change its own copy, checking each value first.
 * @param live - The plugin's settings, which name the profiles to pick from
 * @param args - The arguments as typed
 * @returns The run, or the refusal naming what was typed wrong
 */
export function transcriptionRun(
	live: AudioRecorderSettings,
	args: CliData,
): Refusable<TranscriptionRun> {
	const changes: Change[] = [];
	const picks: ProfilePick[] = [];
	for (const reader of READERS) {
		const read = reader(live, args);
		if (isRefusal(read)) {
			return read;
		}
		changes.push(...read.value.changes);
		picks.push(...read.value.picks);
	}
	return {
		value: {
			apply: (base) => {
				const run: AudioRecorderSettings = { ...base };
				for (const change of changes) {
					change(run);
				}
				return run;
			},
			picks,
		},
	};
}
