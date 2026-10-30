/**
 * Transcription started from the command line.
 *
 * A transcription is a paid job that can run for minutes, so the command line
 * starts it where every other automatic run is started: in the transcribe
 * dialog, which shows its progress and can cancel it. What the dialog lets the
 * user change for one run, the command line takes as parameters; they set the
 * dialog's controls, so the run is the one the dialog would have made with the
 * same choices.
 *
 * The answer comes back at once by default, saying the run was started. With
 * `wait` the command answers once the run is over, with where the transcript
 * went - which is what a script that goes on to read the transcript needs.
 * @module actions/file/transcribeCli
 */

import type { CliData, CliFlags } from 'obsidian';
import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import {
	ProfileKindId,
	profileIdNamed,
	setSelectedProfileId,
} from '../../settings/profiles';
import {
	LLM_TASK_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
	type LabeledOption,
} from '../../settings/labels';
import { transcriptionRefusal } from '../../settings/settingsAttention';
import { TranscriptDestination } from '../../transcription/api';
import {
	TranscriptionModal,
	type TranscriptionRunOutcome,
} from '../../ui/TranscriptionModal';
import {
	choiceParam,
	cliChoice,
	cliFlag,
	cliSwitch,
	cliText,
	flagParam,
	valueParam,
	WAIT_FLAG,
} from '../../obsidian/cliArgs';
import type { FileContext } from './FileContext';
import { isRefusal, type Refusable } from '../../utils/refusal';

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

/** The dialog's dropdowns. */
const CHOICES: readonly ChoiceOption[] = [
	choice(
		'engine',
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
const SWITCHES: readonly SwitchOption[] = [
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
const PROFILES: readonly ProfileOption[] = [
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
];

/** The parameters of the transcribe command, beyond its target. */
export const TRANSCRIBE_PARAMS: CliFlags = {
	language: valueParam(
		'<codes>',
		'Language code, several separated by commas, or auto.',
	),
	...Object.fromEntries(
		CHOICES.map((option) => [
			option.param,
			choiceParam(option.values, option.description),
		]),
	),
	...Object.fromEntries(
		SWITCHES.map((option) => [
			option.param,
			choiceParam(['on', 'off'], option.description),
		]),
	),
	...Object.fromEntries(
		PROFILES.map((option) => [
			option.param,
			valueParam('<profile>', option.description),
		]),
	),
	[WAIT_FLAG]: flagParam(
		'Answer once the transcript is written, not once the run started.',
	),
};

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
	const changes: ((run: AudioRecorderSettings) => void)[] = [];
	const language = cliText(args, 'language');
	if (language !== null) {
		changes.push((run) => {
			run.transcriptionLanguage = language;
		});
	}
	for (const option of CHOICES) {
		const read = option.read(args);
		if (isRefusal(read)) {
			return read;
		}
		if (read.value !== null) {
			changes.push(read.value);
		}
	}
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

/** A transcript written as a file, which always sits beside its recording. */
const BESIDE = 'a transcript file next to the recording';

/**
 * Where a destination puts the transcript, in words.
 * @param destination - The run's destination
 * @param notePath - The note it was written for, '' for none
 */
function transcriptPlace(destination: string, notePath: string): string {
	if (notePath === '') {
		// Nothing goes into a note without one; every destination is a file.
		return BESIDE;
	}
	switch (destination) {
		case TranscriptDestination.Note:
			return notePath;
		case TranscriptDestination.Both:
			return `${notePath} and ${BESIDE}`;
		case TranscriptDestination.Link:
			return `${BESIDE}, linked from ${notePath}`;
		default:
			return BESIDE;
	}
}

/**
 * Says where a finished run put the transcript.
 * @param path - The recording
 * @param outcome - How the run ended
 */
export function describeTranscriptionOutcome(
	path: string,
	outcome: TranscriptionRunOutcome,
): string {
	if (outcome.status === 'cancelled') {
		return `Transcription of ${path} was cancelled in Obsidian.`;
	}
	if (outcome.status === 'failed') {
		return `Transcription of ${path} failed: ${outcome.message}`;
	}
	const where = transcriptPlace(outcome.destination, outcome.notePath);
	const missing =
		outcome.missingParts === 0
			? ''
			: ` ${String(outcome.missingParts)} part${
					outcome.missingParts === 1 ? '' : 's'
				} failed and can be transcribed again with retry-failed.`;
	return `Transcribed ${path} into ${where}.${missing}`;
}

/**
 * Starts a transcription from the command line.
 *
 * The note the transcript goes into is the one the command named, never
 * whichever note happens to be active in the app: a script cannot see which
 * one that is. With no note named, a transcript meant for a note is written as
 * a file next to the recording, as the dialog does when no note is open.
 * @param context - The recording and the note it was reached through
 * @param args - The arguments as typed
 * @returns The answer
 */
export async function transcribeFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const live = services.getSettings();
	const read = transcriptionRun(live, args);
	if (isRefusal(read)) {
		return read.refusal;
	}
	const run = read.value;
	// Asked before anything opens: the same conditions the run refuses on, so
	// a job that cannot work is answered with its reason rather than started.
	const refusal = transcriptionRefusal(run.apply(live));
	if (refusal) {
		return refusal;
	}
	if (run.picks.length > 0) {
		// Kept as the next defaults, as a pick in the dialog is - and needed
		// there, since the chapters generated after the run read the profile
		// from the plugin settings rather than from this run's copy.
		for (const pick of run.picks) {
			setSelectedProfileId(live, pick.kind, pick.id);
		}
		await services.saveSettings();
	}
	const settled = new Promise<TranscriptionRunOutcome>((resolve) => {
		new TranscriptionModal(
			services.app,
			file,
			() => run.apply(services.getSettings()),
			{
				...services.createTranscriptionModalOptions(),
				autoStart: true,
				notePath: context.origin.note?.path ?? '',
				onRunSettled: resolve,
			},
		).open();
	});
	if (!cliFlag(args, WAIT_FLAG)) {
		return `Started transcribing ${file.path} in Obsidian.`;
	}
	return describeTranscriptionOutcome(file.path, await settled);
}
