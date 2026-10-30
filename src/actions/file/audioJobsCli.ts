/**
 * The audio jobs of the file actions, run from the command line: reading a
 * recording's properties, converting it, splitting it, and cleaning it up.
 *
 * Each takes as parameters what its dialog lets the user choose, defaulting to
 * what the dialog starts on - the plugin settings - and runs the same service
 * the dialog runs. What the service tells the user along the way (a file in
 * the way, a format this device cannot encode, links it could not update) is
 * shown in the app as before and repeated in the answer, so a script learns
 * why a job did not finish without anyone looking at the app.
 *
 * A conversion and a split can run for minutes, and the host hands a command
 * no signal to interrupt it with, so both show their progress in the app in a
 * notice with a Cancel, the one a dialog closed mid-job leaves behind.
 * @module actions/file/audioJobsCli
 */

import type { CliData, CliFlags } from 'obsidian';
import {
	DEFAULT_SAMPLE_RATE,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	MAX_SPLIT_CHUNK_MINUTES,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
	MIN_SPLIT_CHUNK_MINUTES,
	SECONDS_PER_MINUTE,
	SPLIT_PART_SUFFIX_PATTERN,
	SPLIT_PART_SUFFIX_RULE_TEXT,
} from '../../constants';
import { effectiveBitrate } from '../../audio/AudioCapabilityDetector';
import { offlineEncodeSampleRate } from '../../audio/AudioFormatConverter';
import { ChannelMode } from '../../audio/downmix';
import {
	ConversionService,
	conversionTargets,
} from '../../recording/ConversionService';
import {
	clampSplitMinutes,
	sanitizePartSuffix,
} from '../../recording/AudioSplitter';
import {
	chapterCutsOf,
	SplitService,
	type ChapterCut,
} from '../../recording/SplitService';
import {
	embedsOf,
	insertProcessedAudioEmbed,
} from '../../recording/NoteInserter';
import { cleanUpRecording, describeCleanup } from '../../cleanup/cleanupRun';
import {
	hasActiveChange,
	resolveAudioDspConfig,
	type AudioDspConfig,
} from '../../cleanup/audioDsp';
import { ConversionLinkAction } from '../../types';
import {
	formatAudioFileInfo,
	getAudioFileInfo,
} from '../../utils/AudioFileAnalyzer';
import { collectingNotify } from '../../utils/notify';
import {
	choiceParam,
	cliChoice,
	cliNumber,
	cliText,
	valueParam,
} from '../../obsidian/cliArgs';
import type { FileContext } from '../core/PluginAction';
import { isRefusal, type Refusable } from '../../utils/refusal';
import { JobProgressNotice } from '../../ui/JobProgressNotice';

/** Every channel layout the conversion and the cleanup offer. */
const CHANNEL_MODES: readonly ChannelMode[] = Object.values(ChannelMode);

/** What happens to the source once the job is done. */
const SOURCE_CHOICES = ['keep', 'delete'] as const;

/** How the links to the source are rewritten. */
const LINK_CHOICES: readonly ConversionLinkAction[] =
	Object.values(ConversionLinkAction);

/** Parameters shared by the jobs that write new files over a source. */
const SOURCE_PARAMS: CliFlags = {
	source: choiceParam(
		SOURCE_CHOICES,
		'Keep the source, or move it to the trash. Defaults to the setting.',
	),
	links: choiceParam(
		LINK_CHOICES,
		'How links to the source are rewritten. Defaults to the setting.',
	),
};

/** The bitrate parameter, in the unit the dialogs show. */
const BITRATE_PARAM: CliFlags = {
	bitrate: valueParam(
		'<kbps>',
		'Bitrate of a compressed result. Defaults to the setting.',
	),
};

/**
 * Whether the source goes, read from `source=`, the setting otherwise.
 * @param args - The arguments as typed
 * @param fallback - The setting
 */
function readDeleteSource(
	args: CliData,
	fallback: boolean,
): Refusable<boolean> {
	const read = cliChoice(args, 'source', SOURCE_CHOICES);
	if (isRefusal(read)) {
		return read;
	}
	return { value: read.value === null ? fallback : read.value === 'delete' };
}

/**
 * How links are rewritten, read from `links=`, the setting otherwise.
 * @param args - The arguments as typed
 * @param fallback - The setting
 */
function readLinkAction(
	args: CliData,
	fallback: ConversionLinkAction,
): Refusable<ConversionLinkAction> {
	const read = cliChoice(args, 'links', LINK_CHOICES);
	return isRefusal(read) ? read : { value: read.value ?? fallback };
}

/**
 * The bitrate a format really encodes at, from `bitrate=` in kbps or the
 * setting, snapped onto the rates the format offers - the same rule the
 * dialogs' bitrate row and every stored value go through.
 * @param args - The arguments as typed
 * @param format - The format written
 * @param fallback - The setting, in bps
 */
function readBitrate(
	args: CliData,
	format: string,
	fallback: number,
): Refusable<number> {
	const read = cliNumber(args, 'bitrate', { min: 1, max: 2000 });
	if (isRefusal(read)) {
		return read;
	}
	const requested = read.value === null ? fallback : read.value * 1000;
	return {
		value: effectiveBitrate(
			format,
			requested,
			offlineEncodeSampleRate(DEFAULT_SAMPLE_RATE),
		),
	};
}

/** The parameters of the info command, beyond its target. */
export const INFO_PARAMS: CliFlags = {
	format: choiceParam(['md', 'json'], 'Answer as a Markdown list or JSON.'),
};

/**
 * Reports a recording's properties: the list the info dialog copies, or the
 * same fields as JSON.
 * @param context - The recording
 * @param args - The arguments as typed
 */
export async function infoFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const format = cliChoice(args, 'format', ['md', 'json'] as const);
	if (isRefusal(format)) {
		return format.refusal;
	}
	const info = await getAudioFileInfo(context.services.app, context.file);
	if (!info) {
		return `Could not read ${context.file.path}: it is empty, damaged, or in a container this app cannot read.`;
	}
	return format.value === 'json'
		? JSON.stringify(info, null, 2)
		: formatAudioFileInfo(info);
}

/** The parameters of the convert command, beyond its target. */
export const CONVERT_PARAMS: CliFlags = {
	to: valueParam('<format>', 'Format to convert to: mp3, wav, flac, ...'),
	channels: choiceParam(
		CHANNEL_MODES,
		'Keep the channel layout, or downmix to mono.',
	),
	...BITRATE_PARAM,
	...SOURCE_PARAMS,
};

/**
 * Converts a recording to another format.
 * @param context - The recording
 * @param args - The arguments as typed
 */
export async function convertFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const settings = services.getSettings();
	const channels = cliChoice(args, 'channels', CHANNEL_MODES);
	if (isRefusal(channels)) {
		return channels.refusal;
	}
	const channelMode = channels.value ?? ChannelMode.Source;
	const targets = conversionTargets(
		file.extension.toLowerCase(),
		channelMode,
	);
	const to = cliText(args, 'to')?.toLowerCase() ?? null;
	if (to === null || !targets.includes(to)) {
		return `${to === null ? 'Name the format with to=<format>.' : `${file.path} cannot be converted to ${to} here.`} Formats offered: ${targets.join(', ')}.`;
	}
	const bitrate = readBitrate(args, to, settings.bitrate);
	if (isRefusal(bitrate)) {
		return bitrate.refusal;
	}
	const deleteSource = readDeleteSource(
		args,
		settings.deleteSourceAfterConversion,
	);
	if (isRefusal(deleteSource)) {
		return deleteSource.refusal;
	}
	const linkAction = readLinkAction(args, settings.conversionLinkAction);
	if (isRefusal(linkAction)) {
		return linkAction.refusal;
	}
	const said = collectingNotify();
	const service = new ConversionService(
		services.app,
		services.getWorkerClient,
		said.notify,
	);
	const outcome = await JobProgressNotice.around(
		`Converting "${file.name}"`,
		(onProgress, token) =>
			service.convert(
				{
					sourceFile: file,
					targetFormat: to,
					bitrate: bitrate.value,
					channelMode,
					deleteSource: deleteSource.value,
					linkAction: linkAction.value,
				},
				onProgress,
				token,
			),
	);
	if (outcome.status === 'cancelled') {
		return said.answer(
			`Conversion of ${file.path} was cancelled in Obsidian.`,
		);
	}
	if (outcome.status === 'aborted') {
		return said.answer(`Did not convert ${file.path}.`);
	}
	if (outcome.status === 'partial') {
		return said.answer(
			`Converted ${file.path}, but not every step after it finished.`,
		);
	}
	services.primeForEnhancement([outcome.newPath]);
	return said.answer(`Converted ${file.path} to ${outcome.newPath}.`);
}

/** The parameters of the split command, beyond its target. */
export const SPLIT_PARAMS: CliFlags = {
	by: choiceParam(
		['duration', 'chapters'],
		'Cut every few minutes, or at the chapters.',
	),
	minutes: valueParam(
		`<${String(MIN_SPLIT_CHUNK_MINUTES)}-${String(MAX_SPLIT_CHUNK_MINUTES)}>`,
		'Length of a part. Defaults to the setting.',
	),
	suffix: valueParam(
		'<suffix>',
		'Appended to each part with its number. Defaults to the setting.',
	),
	...BITRATE_PARAM,
	...SOURCE_PARAMS,
};

/**
 * The chapters a split cuts at, or the reason there are none.
 * @param context - The recording
 */
async function chapterCuts(
	context: FileContext,
): Promise<Refusable<ChapterCut[]>> {
	const markers = await context.services.recordingSidecar.getMarkers(
		context.file.path,
	);
	const cuts = chapterCutsOf(markers);
	return cuts.length > 0
		? { value: cuts }
		: { refusal: `${context.file.path} has no chapters to cut at.` };
}

/**
 * Splits a recording into parts.
 * @param context - The recording
 * @param args - The arguments as typed
 */
export async function splitFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services } = context;
	const settings = services.getSettings();
	const by = cliChoice(args, 'by', ['duration', 'chapters'] as const);
	if (isRefusal(by)) {
		return by.refusal;
	}
	const minutes = cliNumber(args, 'minutes', {
		min: MIN_SPLIT_CHUNK_MINUTES,
		max: MAX_SPLIT_CHUNK_MINUTES,
		integer: true,
	});
	if (isRefusal(minutes)) {
		return minutes.refusal;
	}
	const deleteSource = readDeleteSource(
		args,
		settings.deleteSourceAfterSplit,
	);
	if (isRefusal(deleteSource)) {
		return deleteSource.refusal;
	}
	const linkAction = readLinkAction(args, settings.conversionLinkAction);
	if (isRefusal(linkAction)) {
		return linkAction.refusal;
	}
	const suffix =
		cliText(args, 'suffix') ?? sanitizePartSuffix(settings.splitPartSuffix);
	if (!SPLIT_PART_SUFFIX_PATTERN.test(suffix)) {
		return SPLIT_PART_SUFFIX_RULE_TEXT;
	}
	const said = collectingNotify();
	const service = new SplitService(services.app, said.notify);
	const bitrate = readBitrate(
		args,
		service.getTargetExtension(file),
		settings.bitrate,
	);
	if (isRefusal(bitrate)) {
		return bitrate.refusal;
	}
	let cuts: ChapterCut[] | undefined;
	if (by.value === 'chapters') {
		const found = await chapterCuts(context);
		if (isRefusal(found)) {
			return found.refusal;
		}
		cuts = found.value;
	}
	const outcome = await JobProgressNotice.around(
		`Splitting "${file.name}"`,
		(onProgress, token) =>
			service.split(
				{
					sourceFile: file,
					partSeconds:
						clampSplitMinutes(
							minutes.value ?? settings.splitChunkMinutes,
						) * SECONDS_PER_MINUTE,
					suffix,
					bitrate: bitrate.value,
					deleteSource: deleteSource.value,
					linkAction: linkAction.value,
					...(cuts ? { cuts } : {}),
				},
				onProgress,
				token,
			),
	);
	if (outcome.status === 'cancelled') {
		return said.answer(`Split of ${file.path} was cancelled in Obsidian.`);
	}
	if (outcome.status === 'aborted') {
		return said.answer(`Did not split ${file.path}.`);
	}
	if (outcome.status === 'partial') {
		return said.answer(
			`Split ${file.path}, but not every step after it finished.`,
		);
	}
	return said.answer(
		`Split ${file.path} into ${String(outcome.partCount)} parts, the first ${outcome.firstPartName}.`,
	);
}

/** The parameters of the cleanup command, beyond its target. */
export const CLEANUP_PARAMS: CliFlags = {
	highpass: valueParam(
		`<${String(MIN_CLEANUP_HIGHPASS_HZ)}-${String(MAX_CLEANUP_HIGHPASS_HZ)}>|on|off`,
		'High-pass filter cutoff in Hz. Defaults to the setting.',
	),
	gate: valueParam(
		`<${String(MIN_CLEANUP_GATE_THRESHOLD_DB)}-${String(MAX_CLEANUP_GATE_THRESHOLD_DB)}>|on|off`,
		'Noise gate threshold in dB. Defaults to the setting.',
	),
	level: valueParam(
		`<${String(MIN_CLEANUP_LEVELING_MAKEUP_DB)}-${String(MAX_CLEANUP_LEVELING_MAKEUP_DB)}>|on|off`,
		'Loudness leveling makeup gain in dB. Defaults to the setting.',
	),
	channels: choiceParam(
		CHANNEL_MODES,
		'Keep the channel layout, or downmix to mono.',
	),
	source: choiceParam(
		SOURCE_CHOICES,
		'Keep the source, or move it to the trash once the copy is linked.',
	),
};

/** One cleanup stage: switched on or off, at a value. */
interface Stage {
	enabled: boolean;
	value: number;
}

/**
 * Reads one stage: `on` or `off`, or a value that also switches it on.
 * @param args - The arguments as typed
 * @param name - Parameter name
 * @param stage - The stage as the settings have it
 * @param range - The values the dialog's slider reaches
 */
function readStage(
	args: CliData,
	name: string,
	stage: Stage,
	range: { min: number; max: number },
): Refusable<Stage> {
	const text = cliText(args, name)?.toLowerCase();
	if (text === 'on' || text === 'off') {
		return { value: { ...stage, enabled: text === 'on' } };
	}
	const read = cliNumber(args, name, range);
	if (isRefusal(read)) {
		return { refusal: `${read.refusal} Or on, or off.` };
	}
	// Not typed at all: the stage stays as the settings have it.
	return {
		value:
			read.value === null ? stage : { enabled: true, value: read.value },
	};
}

/**
 * The stages a cleanup applies: the settings, as the dialog starts on them,
 * changed by what was typed.
 * @param context - The recording
 * @param args - The arguments as typed
 */
function cleanupConfig(
	context: FileContext,
	args: CliData,
): Refusable<AudioDspConfig> {
	const base = resolveAudioDspConfig(context.services.getSettings());
	const highPass = readStage(
		args,
		'highpass',
		{ enabled: base.highPass.enabled, value: base.highPass.hz },
		{ min: MIN_CLEANUP_HIGHPASS_HZ, max: MAX_CLEANUP_HIGHPASS_HZ },
	);
	const gate = readStage(
		args,
		'gate',
		{ enabled: base.gate.enabled, value: base.gate.thresholdDb },
		{
			min: MIN_CLEANUP_GATE_THRESHOLD_DB,
			max: MAX_CLEANUP_GATE_THRESHOLD_DB,
		},
	);
	const leveling = readStage(
		args,
		'level',
		{ enabled: base.leveling.enabled, value: base.leveling.makeupDb },
		{
			min: MIN_CLEANUP_LEVELING_MAKEUP_DB,
			max: MAX_CLEANUP_LEVELING_MAKEUP_DB,
		},
	);
	const channels = cliChoice(args, 'channels', CHANNEL_MODES);
	if (isRefusal(highPass)) {
		return highPass;
	}
	if (isRefusal(gate)) {
		return gate;
	}
	if (isRefusal(leveling)) {
		return leveling;
	}
	if (isRefusal(channels)) {
		return channels;
	}
	return {
		value: {
			highPass: {
				enabled: highPass.value.enabled,
				hz: highPass.value.value,
			},
			gate: {
				enabled: gate.value.enabled,
				thresholdDb: gate.value.value,
			},
			leveling: {
				enabled: leveling.value.enabled,
				makeupDb: leveling.value.value,
			},
			channelMode: channels.value ?? ChannelMode.Source,
		},
	};
}

/**
 * Cleans up a recording into a processed WAV copy.
 *
 * The copy is linked into the note the command named, in place of the source
 * when the source goes; with no note named, no note is touched, since the one
 * that happens to be active is not one a script chose.
 * @param context - The recording and the note it was reached through
 * @param args - The arguments as typed
 */
export async function cleanupFromCli(
	context: FileContext,
	args: CliData,
): Promise<string> {
	const { file, services, note } = context;
	const config = cleanupConfig(context, args);
	if (isRefusal(config)) {
		return config.refusal;
	}
	if (!hasActiveChange(config.value)) {
		return 'Every stage is off: switch one on (highpass, gate, level) or choose a mono channels option.';
	}
	const deleteSource = readDeleteSource(args, false);
	if (isRefusal(deleteSource)) {
		return deleteSource.refusal;
	}
	// The source goes once its copy is linked where it was, and the copy is
	// linked only into a note the command named: trashing it with no note
	// would leave every link to it broken and the copy linked nowhere.
	if (deleteSource.value && !note) {
		return `source=delete trashes ${file.path} once its copy is linked into its note: name the note with file=<note>, or note=<note> beside path=<recording>.`;
	}
	// The copy takes the place of the note's embeds of the recording; a note
	// that only links it, or links moments of it, has none to take.
	if (
		deleteSource.value &&
		note &&
		embedsOf(services.app, note, file).length === 0
	) {
		return `source=delete trashes ${file.path} once its copy has replaced its embed in ${note.path}, which embeds it nowhere. Keep the source with source=keep.`;
	}
	const result = await cleanUpRecording(services.app, file, config.value, {
		deleteSource: deleteSource.value,
		onProcessed: async ({ outputPath, replaceSource }) => {
			if (note) {
				await insertProcessedAudioEmbed(
					services.app,
					file,
					outputPath,
					replaceSource,
					note,
				);
			}
			services.primeForEnhancement([outputPath]);
		},
	});
	return describeCleanup(result);
}
