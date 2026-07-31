/**
 * The settings tab described as data: one tree of Obsidian setting definitions
 * that both render paths read.
 *
 * From Obsidian 1.13 this tree is the tab - the framework renders it, indexes
 * every setting for the settings search, reads and writes the values, runs the
 * validators, and re-evaluates the `visible`/`disabled` predicates. Below 1.13
 * none of that exists, so {@link module:settings/legacySettingsRenderer} walks
 * the same tree with the old `Setting` API. The official migration guide's
 * dual-support path keeps two hand-written implementations instead; for a tab
 * with sixty-odd settings that is a drift generator, and the guide says as much.
 *
 * A handful of rows cannot be declared: the documentation callout, the format
 * list blocked per option by an asynchronous encoder probe, the output summary
 * derived from two other rows, the test capture that reports into its own row,
 * and the transcription engine fields that are not migrated yet. Those use the
 * framework's own escape hatch, a render callback, and nothing else does.
 * @module settings/settingsDefinitions
 */

import type {
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	SettingGroupItem,
} from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import {
	ADVANCED_SECOND_PASS_RATIO_STEP,
	MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
	MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
	MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
	MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
	TRANSCRIPTION_PROVIDER_IDS,
	CLEANUP_GATE_STEP_DB,
	CLEANUP_HIGHPASS_STEP_HZ,
	CLEANUP_LEVELING_STEP_DB,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	SPLIT_PART_SUFFIX_PATTERN,
} from '../constants';
import { TRANSCRIPTION_PROVIDER_OPTIONS } from './labels';
import {
	isAutoSplitSupported,
	isChannelModeSelectionSupported,
	isDeviceSelectionSupported,
	isMultiTrackCaptureSupported,
	isSampleRateSelectionSupported,
} from '../platform/capabilities';
import {
	CHANNEL_MODE_LABELS,
	CONVERSION_LINK_ACTION_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
} from './labels';
import {
	effectiveDiarize,
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
} from '../transcription/providers/capabilities';
import type { TranscriptionProviderId } from './settingsSchema';

/** Bitrates the output-format section offers, in kbps. */
const BITRATE_OPTIONS_KBPS = [64, 96, 128, 160, 192, 256, 320];

/** Highest track count the multi-track section offers. */
export const MAX_TRACK_COUNT = 8;

/** Control key for one field of one track's audio source. */
export const trackControlKey = (
	track: number,
	field: 'deviceId' | 'channelMode',
): string => `track.${String(track)}.${field}`;

/**
 * Reads a track control key back into the track and field it addresses.
 * @param key - A key produced by {@link trackControlKey}
 * @returns The track number and field, or undefined for any other key
 */
export function parseTrackControlKey(
	key: string,
): { track: number; field: 'deviceId' | 'channelMode' } | undefined {
	const match = /^track\.(\d+)\.(deviceId|channelMode)$/.exec(key);
	if (!match) {
		return undefined;
	}
	return {
		track: Number(match[1]),
		field: match[2] as 'deviceId' | 'channelMode',
	};
}

/** Accepted shape of the transcription language field: an ISO code or empty. */
const LANGUAGE_CODE_PATTERN = /^([a-z]{2,3}(-[a-z0-9]{2,8})?|auto)?$/i;

/**
 * Marks the row that hosts the sections not described here yet. From 1.13 on,
 * the row of a render definition is the only DOM that definition owns, so the
 * stylesheet strips that row's own flex layout, padding, background, and
 * divider to let a whole imperative body read as an ordinary settings column.
 */
export const SETTINGS_ROOT_CLASS = 'aar-settings-root';

/**
 * Marks a row whose render callback puts block content (a status line, a
 * playback element) under its control instead of beside it. The stylesheet lets
 * such a row wrap so the block starts on its own line.
 */
export const SETTINGS_BLOCK_ROW_CLASS = 'aar-setting-block-row';

/**
 * The live audio-input picture the device-bound rows are built from. The tab
 * enumerates devices asynchronously and asks for a re-render when the list
 * changes, so the definitions themselves only read what is already known.
 */
export interface DeviceOptions {
	/** Device id to label, for the input dropdowns. */
	readonly inputs: Record<string, string>;
	/**
	 * Whether a device offers a channel layout worth choosing. False for a
	 * device that positively reports a single capture channel, and for no
	 * device at all.
	 */
	channelSelectable(deviceId: string): boolean;
}

/**
 * The transcription blocks still rendered by hand, each into the row its
 * section keeps for it: the selected engine's own fields, and the two profile
 * managers, which are collections with their own add and delete affordances.
 */
export interface TranscriptionBlocks {
	/** The selected engine's endpoint, credentials, model, or file paths. */
	readonly renderEngineFields: (host: HTMLElement) => void;
	/** The dictionary profile manager. */
	readonly renderDictionaryProfiles: (host: HTMLElement) => void;
	/** The chapter-guidance profile manager. */
	readonly renderChapterProfiles: (host: HTMLElement) => void;
	/** The LLM post-processing block. */
	readonly renderLlmSection: (host: HTMLElement) => void;
}

/**
 * The output-format rows that stay imperative. The format list is blocked per
 * option by an asynchronous encoder probe, which no control type expresses, and
 * the summary is derived from two other rows rather than stored.
 */
export interface OutputFormatRows {
	/** Fills the recording-format row and starts its availability probe. */
	readonly renderFormatRow: (setting: Setting) => void;
	/** Fills the row that summarises the effective output. */
	readonly renderSummaryRow: (setting: Setting) => void;
}

/**
 * The diagnostics actions, which act on the plugin rather than on a setting.
 */
export interface DiagnosticsActions {
	/** Starts the fixed-length test capture, reporting into the row it is given. */
	startTestRecording(rowEl: HTMLElement): void;
	/** Releases the test capture and the blob URL of its playback element. */
	releaseTestRecording(): void;
	/** Opens the system-information dialog. */
	showSystemInfo(): void;
}

/**
 * What the definitions need from the tab that owns them.
 */
export interface SettingsDefinitionContext {
	/**
	 * The live settings, read by the `visible` and `disabled` predicates. Values
	 * themselves travel through the tab's control-value hooks, not from here.
	 */
	readonly settings: AudioRecorderSettings;
	/** Input devices and their channel capability, as last enumerated. */
	readonly devices: DeviceOptions;
	/** Capture sample rates this device offers. */
	readonly sampleRates: readonly number[];
	/** The two output-format rows the declarative controls cannot express. */
	readonly outputFormat: OutputFormatRows;
	/** Draws the documentation callout that opens the tab. */
	renderDocumentationLink(host: HTMLElement): void;
	/** Handlers for the diagnostics rows. */
	readonly diagnostics: DiagnosticsActions;
	/** The transcription blocks that are not definitions yet. */
	readonly transcriptionBlocks: TranscriptionBlocks;
}

/**
 * A row whose body is still rendered by hand, hosted in the row itself, which
 * is the only DOM a render definition owns.
 * @param name - Row name, used by the settings search
 * @param render - Draws the block into the row
 * @param visible - When the row applies
 */
function imperativeBlockRow(
	name: string,
	render: (host: HTMLElement) => void,
	visible: () => boolean,
): SettingDefinition {
	return {
		name,
		visible,
		render: (setting: Setting): void => {
			const host = setting.settingEl;
			host.empty();
			host.addClass(SETTINGS_ROOT_CLASS);
			render(host);
		},
	};
}

/**
 * Where a recording is written and how it is named.
 * @param settings - Live settings, read by the predicates
 */
function fileStorageGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'File storage',
		items: [
			{
				name: 'Save folder',
				desc: 'Where recordings are saved in your vault.',
				// The folder control brings Obsidian's own folder suggestions,
				// which the tab used to wire by hand.
				control: {
					type: 'folder',
					key: 'saveFolder',
					includeRoot: true,
					placeholder: '/',
				},
			},
			{
				name: 'Save recordings near active file',
				desc: 'Save recordings beside the active Markdown file. Takes priority over the save folder.',
				control: { type: 'toggle', key: 'saveNearActiveFile' },
			},
			{
				name: 'Active file subfolder',
				desc: 'Optional subfolder beside the active file (for example: audio). Created if missing.',
				visible: (): boolean => settings.saveNearActiveFile,
				control: { type: 'text', key: 'activeFileSubfolder' },
			},
			{
				name: 'File prefix',
				desc: 'Filename prefix used for exported recordings.',
				control: { type: 'text', key: 'filePrefix' },
			},
			{
				name: 'Insert at original position',
				desc: 'Insert the audio link where recording started, even if you navigate away during it.',
				control: { type: 'toggle', key: 'insertAtOriginalPosition' },
			},
		],
	};
}

/**
 * The recorded file's format, its bitrate, and what a conversion does with the
 * source file it replaces.
 * @param rows - The two rows that cannot be expressed as controls
 */
function outputFormatGroup(rows: OutputFormatRows): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'Output format',
		items: [
			{
				name: 'Recording format',
				desc: 'Final file format. Formats this device cannot record are shown blocked.',
				render: (setting: Setting): void => {
					rows.renderFormatRow(setting);
				},
			},
			{
				name: 'Audio bitrate',
				desc: 'Compression quality and resulting file size.',
				control: {
					type: 'dropdown',
					key: 'bitrate',
					options: Object.fromEntries(
						BITRATE_OPTIONS_KBPS.map((kbps) => [
							String(kbps * 1000),
							`${String(kbps)} kbps`,
						]),
					),
				},
			},
			{
				name: 'Output summary',
				desc: 'The exact format, compression type, and bitrate used for recording.',
				render: (setting: Setting): void => {
					rows.renderSummaryRow(setting);
				},
			},
			{
				name: 'Delete source after conversion',
				desc: 'Delete the original file after a successful conversion from the context menu.',
				control: {
					type: 'toggle',
					key: 'deleteSourceAfterConversion',
				},
			},
			{
				name: 'Update links after conversion',
				desc: 'What to do with links to the source file in your notes.',
				control: {
					type: 'dropdown',
					key: 'conversionLinkAction',
					options: Object.fromEntries(
						CONVERSION_LINK_ACTION_OPTIONS.map((option) => [
							option.value,
							option.label,
						]),
					),
				},
			},
		],
	};
}

/**
 * The capture hardware: which input, at what rate, in what channel layout.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 * @param sampleRates - Capture rates this device offers
 */
function audioInputGroup(
	settings: AudioRecorderSettings,
	devices: DeviceOptions,
	sampleRates: readonly number[],
): SettingDefinitionItem {
	const deviceSelectable = isDeviceSelectionSupported();
	const rateSelectable = isSampleRateSelectionSupported();
	return {
		type: 'group',
		heading: 'Audio input',
		items: [
			{
				name: 'Input device',
				desc: deviceSelectable
					? 'Default input device for single-track recordings. Also changeable from the command palette.'
					: 'Not selectable on this device; recording uses the system default microphone.',
				control: {
					type: 'dropdown',
					key: 'audioDeviceId',
					options: devices.inputs,
					disabled: !deviceSelectable,
				},
			},
			{
				name: 'Sample rate',
				desc: rateSelectable
					? 'Audio sample rate in hertz.'
					: 'Not selectable on this device; the system capture rate is used.',
				control: {
					type: 'dropdown',
					key: 'sampleRate',
					options: Object.fromEntries(
						sampleRates.map((rate) => [String(rate), String(rate)]),
					),
					disabled: !rateSelectable,
				},
			},
			{
				name: 'Recording channels',
				desc: 'Channel layout for single-track recordings: keep the device layout, or reduce to mono during capture. Multi-track sessions use the per-track selectors instead.',
				control: {
					type: 'dropdown',
					key: 'recordingChannels',
					options: CHANNEL_MODE_LABELS,
					// An empty device id means the platform default, whose
					// capability is not knowable here, so the choice stays open.
					disabled: (): boolean =>
						!isChannelModeSelectionSupported() ||
						(settings.audioDeviceId !== '' &&
							!devices.channelSelectable(settings.audioDeviceId)),
				},
			},
		],
	};
}

/**
 * Automatic splitting of a long recording into part files.
 */
function audioSplittingGroup(): SettingDefinitionItem {
	const available = isAutoSplitSupported();
	return {
		type: 'group',
		heading: 'Audio splitting',
		items: [
			{
				name: 'Split recordings automatically',
				desc: available
					? 'Save the recording as separate part files of fixed duration instead of one long file. Not applied to merged multi-track recordings.'
					: 'Not available on this device. Recordings are saved as one file; manual splitting from the context menu still works.',
				control: {
					type: 'toggle',
					key: 'autoSplitEnabled',
					disabled: !available,
				},
			},
			{
				name: 'Part duration',
				desc: 'Length of each part in minutes. Also the default for manual splitting from the context menu.',
				control: {
					type: 'number',
					key: 'splitChunkMinutes',
					min: MIN_SPLIT_CHUNK_MINUTES,
					max: MAX_SPLIT_CHUNK_MINUTES,
					step: 1,
				},
			},
			{
				name: 'Part name suffix',
				desc: `Appended with the part number to part file names, e.g. "recording-${DEFAULT_SPLIT_PART_SUFFIX}1.webm".`,
				control: {
					type: 'text',
					key: 'splitPartSuffix',
					placeholder: DEFAULT_SPLIT_PART_SUFFIX,
					validate: (value: string): string | undefined =>
						SPLIT_PART_SUFFIX_PATTERN.test(value.trim())
							? undefined
							: 'Letters, digits, hyphens and underscores only.',
				},
			},
			{
				name: 'Delete source after split',
				desc: 'Default state of the delete source file option in the manual split dialog.',
				control: { type: 'toggle', key: 'deleteSourceAfterSplit' },
			},
		],
	};
}

/**
 * Multi-track capture: the switch, how many tracks to offer, how they are
 * exported, and one input plus channel layout per track. The per-track rows are
 * declared for every track the section can offer and revealed by predicate, so
 * changing the track count reveals rows instead of rebuilding the tab.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 */
function multiTrackGroup(
	settings: AudioRecorderSettings,
	devices: DeviceOptions,
): SettingDefinitionItem {
	const available = isMultiTrackCaptureSupported();
	const active = (): boolean => settings.enableMultiTrack && available;
	const trackRows = (): SettingGroupItem[] => {
		const rows: SettingGroupItem[] = [];
		for (let track = 1; track <= MAX_TRACK_COUNT; track++) {
			const offered = (): boolean =>
				active() && track <= settings.maxTracks;
			rows.push(
				{
					name: `Audio source for track ${String(track)}`,
					desc: `Input device assigned to track ${String(track)}.`,
					visible: offered,
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'deviceId'),
						options: devices.inputs,
					},
				},
				{
					name: `Channels for track ${String(track)}`,
					desc: `Channel layout for track ${String(track)}: keep the device layout, or reduce this track to mono during capture.`,
					visible: offered,
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'channelMode'),
						options: CHANNEL_MODE_LABELS,
						// A track with no device, or one whose device reports a
						// single capture channel, has no layout to choose.
						disabled: (): boolean =>
							!isChannelModeSelectionSupported() ||
							!devices.channelSelectable(
								settings.trackAudioSources.get(track)
									?.deviceId ?? '',
							),
					},
				},
			);
		}
		return rows;
	};
	return {
		type: 'group',
		heading: 'Multi-track recording',
		items: [
			{
				name: 'Enable multi-track recording',
				desc: available
					? 'Record from several input devices at the same time.'
					: 'Not available on this device. Recording captures a single track from the default microphone.',
				control: {
					type: 'toggle',
					key: 'enableMultiTrack',
					disabled: !available,
				},
			},
			{
				name: 'Maximum tracks',
				desc: 'Number of simultaneous tracks to configure. Use only what you need.',
				visible: active,
				control: {
					type: 'number',
					key: 'maxTracks',
					min: 1,
					max: MAX_TRACK_COUNT,
					step: 1,
				},
			},
			{
				name: 'Output mode',
				desc: 'Export multi-track output as one combined file or one file per track.',
				visible: active,
				control: {
					type: 'dropdown',
					key: 'outputMode',
					options: {
						single: 'Single file',
						multiple: 'Multiple files',
					},
				},
			},
			...trackRows(),
		],
	};
}

/**
 * The enhanced player and the two windows it can open. The sub-options are
 * revealed by a predicate rather than by redrawing the section.
 * @param settings - Live settings, read by the predicates
 */
function audioPlayerGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const enhanced = (): boolean => settings.enhancedPlayerEnabled;
	return {
		type: 'group',
		heading: 'Audio player',
		items: [
			{
				name: 'Enhanced audio player',
				desc: 'Replace the built-in audio embed with a richer player (waveform, speed, skip, volume, loop, timecode links, markers and chapters). Video files keep the built-in player.',
				control: { type: 'toggle', key: 'enhancedPlayerEnabled' },
			},
			{
				name: 'Show waveform',
				desc: 'Draw a waveform behind the seek bar.',
				visible: enhanced,
				control: { type: 'toggle', key: 'playerShowWaveform' },
			},
			{
				name: 'Markers and chapters',
				desc: 'Show the markers and chapters list below the player. Markers are stored next to the recording, not in your vault.',
				visible: enhanced,
				control: { type: 'toggle', key: 'playerEnableMarkers' },
			},
		],
	};
}

/**
 * The transcription section. Everything below the section's own switch is
 * revealed by a predicate rather than by re-rendering the section, and the
 * options an engine cannot deliver are disabled rather than hidden, so the user
 * can see the option exists and why it is unavailable.
 * @param settings - Live settings, read by the predicates
 * @param blocks - The parts of the section that are not definitions yet
 */
function transcriptionGroup(
	settings: AudioRecorderSettings,
	blocks: TranscriptionBlocks,
): SettingDefinitionItem {
	const enabled = (): boolean => settings.transcriptionEnabled;
	const canDiarize = (): boolean =>
		providerSupportsDiarization(settings.transcriptionProvider);
	return {
		type: 'group',
		heading: 'Transcription',
		items: [
			{
				name: 'Enable transcription',
				desc: 'Transcribe recordings to text, with optional speaker labels and LLM post-processing.',
				control: { type: 'toggle', key: 'transcriptionEnabled' },
			},
			{
				name: 'Transcribe after recording',
				desc: 'Automatically transcribe each recording once it is saved.',
				visible: enabled,
				control: { type: 'toggle', key: 'transcribeOnSave' },
			},
			{
				name: 'Show cost estimates',
				desc: 'Show an approximate API cost before a run and a running session total (built-in rates; cloud engines only).',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionShowCostEstimates',
				},
			},
			{
				name: 'Engine',
				desc: 'Whisper API, Deepgram, or Google Gemini (cloud), or a local whisper.cpp binary (desktop).',
				visible: enabled,
				control: {
					type: 'dropdown',
					key: 'transcriptionProvider',
					// Every device lists every engine, so the dropdown reads the
					// same everywhere; picking one this device cannot run is
					// refused with the reason instead of silently blocked.
					options: Object.fromEntries(
						TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => [
							option.value,
							option.label,
						]),
					),
					validate: (value: string): string | undefined =>
						isProviderAvailableOnPlatform(
							value as TranscriptionProviderId,
						)
							? undefined
							: 'Not available on this device.',
				},
			},
			{
				name: 'Language',
				desc: 'ISO code (e.g. en, ru, es). Leave empty, or write "auto", to detect it.',
				visible: enabled,
				control: {
					type: 'text',
					key: 'transcriptionLanguage',
					placeholder: 'auto',
					validate: (value: string): string | undefined =>
						LANGUAGE_CODE_PATTERN.test(value.trim())
							? undefined
							: 'Use an ISO code such as en or ru, or "auto".',
				},
			},
			{
				name: 'Speaker diarization',
				desc: 'Request speaker labels. Speaker count is detected automatically.',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionDiarize',
					// Kept visible on an engine that cannot diarize: the option
					// exists, this engine just cannot deliver it.
					disabled: (): boolean => !canDiarize(),
				},
			},
			{
				name: 'Word-level timestamps',
				desc: 'Request per-word timing when the provider supports it. Recorded in JSON file output only.',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionWordTimestamps',
				},
			},
			{
				name: 'Request timeout',
				desc: 'Minutes before one transcription request is aborted, so a stalled request cannot hang the run.',
				// Local whisper.cpp runs no HTTP request, so the timeout has
				// nothing to bound there.
				visible: (): boolean =>
					enabled() &&
					settings.transcriptionProvider !==
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				control: {
					type: 'number',
					key: 'transcriptionTimeoutMinutes',
					min: MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
					max: MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
					step: 1,
				},
			},
			imperativeBlockRow(
				'Transcription engine settings',
				blocks.renderEngineFields,
				enabled,
			),
		],
	};
}

/**
 * The advanced transcription block: dictionary term biasing and the two-pass
 * mode, both behind a master switch that is off for a plain run.
 * @param settings - Live settings, read by the predicates
 * @param blocks - The profile manager that is not a definition yet
 */
function transcriptionAdvancedGroup(
	settings: AudioRecorderSettings,
	blocks: TranscriptionBlocks,
): SettingDefinitionItem {
	const advanced = (): boolean =>
		settings.transcriptionEnabled &&
		settings.transcriptionAdvancedSettingsEnabled;
	return {
		type: 'group',
		heading: 'Advanced',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Advanced settings',
				desc: 'Reveal dictionary term biasing and the experimental two-pass mode. Off by default: a recording then transcribes in a single plain pass.',
				control: {
					type: 'toggle',
					key: 'transcriptionAdvancedSettingsEnabled',
				},
			},
			imperativeBlockRow(
				'Dictionary profiles',
				blocks.renderDictionaryProfiles,
				advanced,
			),
			{
				name: 'Advanced two-pass transcription (experimental)',
				desc: 'Transcribe twice: LLM agents mine the first draft for names and jargon, and the second pass re-decodes biased toward them. Roughly twice the engine cost and time, plus several LLM calls per file.',
				visible: advanced,
				control: {
					type: 'toggle',
					key: 'transcriptionAdvancedEnabled',
				},
			},
			{
				name: 'Second-pass length safeguard',
				desc: 'Keep the second pass only when its text is at least this fraction of the first. A shorter biased decode lost content, so the run falls back.',
				visible: (): boolean =>
					advanced() && settings.transcriptionAdvancedEnabled,
				control: {
					type: 'number',
					key: 'advancedSecondPassMinRatio',
					min: MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
					max: MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
					step: ADVANCED_SECOND_PASS_RATIO_STEP,
				},
			},
		],
	};
}

/**
 * Where a finished transcript goes and how it is written. The speaker-related
 * rows are disabled without diarization in effect: they exist, the current
 * engine and settings just produce no speaker labels for them to format.
 * @param settings - Live settings, read by the predicates
 */
function transcriptOutputGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const diarizes = (): boolean =>
		effectiveDiarize(
			settings.transcriptionProvider,
			settings.transcriptionDiarize,
		);
	const speakerHint =
		'Available only with speaker diarization; the current engine and settings produce no speaker labels.';
	const template = (
		key: string,
		name: string,
		desc: string,
		speakerOnly = false,
	): SettingDefinition => ({
		name,
		desc: speakerOnly && !diarizes() ? speakerHint : desc,
		control: {
			type: 'text',
			key,
			validate: (value: string): string | undefined =>
				value.trim() === '' ? 'A template cannot be empty.' : undefined,
			...(speakerOnly ? { disabled: (): boolean => !diarizes() } : {}),
		},
	});
	return {
		type: 'group',
		heading: 'Transcript output',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Destination',
				desc: 'Insert into the note, save as a sidecar file, both, or save a file and link it.',
				control: {
					type: 'dropdown',
					key: 'transcriptDestination',
					options: Object.fromEntries(
						TRANSCRIPT_DESTINATION_OPTIONS.map((option) => [
							option.value,
							option.label,
						]),
					),
				},
			},
			{
				name: 'File format',
				desc: 'Format for the transcript sidecar file.',
				visible: (): boolean =>
					settings.transcriptDestination !== 'note',
				control: {
					type: 'dropdown',
					key: 'transcriptFileFormat',
					options: Object.fromEntries(
						TRANSCRIPT_FILE_FORMAT_OPTIONS.map((option) => [
							option.value,
							option.label,
						]),
					),
				},
			},
			{
				name: 'Note heading',
				desc: 'Heading inserted above the transcript (empty for none).',
				control: { type: 'text', key: 'transcriptHeading' },
			},
			{
				name: 'Include timestamps',
				control: {
					type: 'toggle',
					key: 'transcriptIncludeTimestamps',
				},
			},
			{
				name: 'Timestamps as player links',
				desc: 'Render each timestamp as a #t= link that jumps the enhanced player.',
				control: { type: 'toggle', key: 'transcriptTimestampLinks' },
			},
			{
				name: 'Include speakers',
				desc: speakerHint,
				control: {
					type: 'toggle',
					key: 'transcriptIncludeSpeakers',
					disabled: (): boolean => !diarizes(),
				},
			},
			{
				name: 'Merge speaker turns',
				desc: 'Combine consecutive segments from the same speaker into one line.',
				control: {
					type: 'toggle',
					key: 'transcriptMergeConsecutiveSpeaker',
					disabled: (): boolean => !diarizes(),
				},
			},
			template(
				'transcriptTimestampFormat',
				'Timestamp format',
				'Template for the timestamp; {time} is the timecode or link.',
			),
			template(
				'transcriptSpeakerFormat',
				'Speaker format',
				'Template for the speaker label; {speaker} is the name.',
				true,
			),
			template(
				'transcriptLineFormat',
				'Line format',
				'Arrangement of {timestamp} {speaker} {text}.',
			),
			{
				name: 'Rename speakers',
				desc: 'Add a "Rename speakers" action that replaces diarized labels with participant names in an existing transcript.',
				control: {
					type: 'toggle',
					key: 'transcriptionSpeakerRenameEnabled',
				},
			},
		],
	};
}

/**
 * LLM-generated chapters, and the guidance profiles they use.
 * @param settings - Live settings, read by the predicates
 * @param blocks - The profile manager that is not a definition yet
 */
function autoChaptersGroup(
	settings: AudioRecorderSettings,
	blocks: TranscriptionBlocks,
): SettingDefinitionItem {
	const chapters = (): boolean =>
		settings.transcriptionEnabled &&
		settings.transcriptionAutoChaptersEnabled;
	return {
		type: 'group',
		heading: 'Auto chapters',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Auto chapters',
				desc: 'Add an action that asks the LLM to divide a transcribed recording into titled chapters, shown in the enhanced player.',
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersEnabled',
				},
			},
			{
				name: 'Generate after transcription',
				desc: 'Generate chapters each time a recording is transcribed.',
				visible: chapters,
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersOnTranscribe',
				},
			},
			imperativeBlockRow(
				'Chapter guidance profiles',
				blocks.renderChapterProfiles,
				chapters,
			),
		],
	};
}

/**
 * The input-processing constraints and the live recording feedback.
 */
function audioProcessingGroup(): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'Audio processing & feedback',
		items: [
			{
				name: 'Noise suppression',
				desc: 'Apply the browser noise-suppression filter to the input.',
				control: { type: 'toggle', key: 'inputNoiseSuppression' },
			},
			{
				name: 'Echo cancellation',
				desc: 'Apply the browser echo-cancellation filter to the input.',
				control: { type: 'toggle', key: 'inputEchoCancellation' },
			},
			{
				name: 'Automatic gain control',
				desc: 'Let the browser normalize the input level automatically.',
				control: { type: 'toggle', key: 'inputAutoGainControl' },
			},
			{
				name: 'Input level meter',
				desc: 'Show a live input-level meter while recording.',
				control: { type: 'toggle', key: 'showInputLevelMeter' },
			},
			{
				name: 'Recording stats',
				desc: 'Show the live elapsed time and total recorded size while recording.',
				control: { type: 'toggle', key: 'showRecordingStats' },
			},
			{
				name: 'Detect silent channel after recording',
				desc: 'Check a saved stereo recording for a silent channel - the typical result of one microphone on a dual-input interface - and offer to convert it to mono.',
				control: { type: 'toggle', key: 'detectSilentChannelOnSave' },
			},
			{
				name: 'Mobile recording banner',
				desc: 'Show a prominent recording banner on mobile, where there is no ribbon indicator.',
				control: { type: 'toggle', key: 'mobileRecordingBanner' },
			},
		],
	};
}

/**
 * The defaults for the on-demand cleanup dialog. Each stage is a switch and the
 * one number it takes, on rows of their own: a row holds a single control, and
 * the number follows the switch that decides whether it is used at all.
 * @param settings - Live settings, read by the disabled predicates
 */
function audioCleanupGroup(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'Audio cleanup defaults',
		items: [
			{
				name: 'High-pass filter',
				desc: 'Remove low-frequency rumble below the cutoff. These defaults prefill the cleanup dialog; cleanup writes a processed copy and never changes a live recording.',
				control: { type: 'toggle', key: 'cleanupHighPassEnabled' },
			},
			{
				name: 'High-pass cutoff',
				desc: 'Cutoff frequency in hertz.',
				control: {
					type: 'number',
					key: 'cleanupHighPassHz',
					min: MIN_CLEANUP_HIGHPASS_HZ,
					max: MAX_CLEANUP_HIGHPASS_HZ,
					step: CLEANUP_HIGHPASS_STEP_HZ,
					disabled: (): boolean => !settings.cleanupHighPassEnabled,
				},
			},
			{
				name: 'Noise gate',
				desc: 'Silence the signal below the threshold.',
				control: { type: 'toggle', key: 'cleanupNoiseGateEnabled' },
			},
			{
				name: 'Noise gate threshold',
				desc: 'Level in dBFS below which the signal is silenced.',
				control: {
					type: 'number',
					key: 'cleanupNoiseGateThresholdDb',
					min: MIN_CLEANUP_GATE_THRESHOLD_DB,
					max: MAX_CLEANUP_GATE_THRESHOLD_DB,
					step: CLEANUP_GATE_STEP_DB,
					disabled: (): boolean => !settings.cleanupNoiseGateEnabled,
				},
			},
			{
				name: 'Loudness leveling',
				desc: 'Even out quiet and loud passages (compressor).',
				control: { type: 'toggle', key: 'cleanupLevelingEnabled' },
			},
			{
				name: 'Makeup gain',
				desc: 'Gain in decibels applied after leveling.',
				control: {
					type: 'number',
					key: 'cleanupLevelingMakeupDb',
					min: MIN_CLEANUP_LEVELING_MAKEUP_DB,
					max: MAX_CLEANUP_LEVELING_MAKEUP_DB,
					step: CLEANUP_LEVELING_STEP_DB,
					disabled: (): boolean => !settings.cleanupLevelingEnabled,
				},
			},
		],
	};
}

/**
 * The diagnostics section: a test capture, the system-information dialog, and
 * the debug switch.
 * @param diagnostics - Handlers for the two action rows
 */
function diagnosticsGroup(
	diagnostics: DiagnosticsActions,
): SettingDefinitionItem {
	return {
		type: 'group',
		heading: 'Diagnostics',
		items: [
			{
				name: 'Test recording',
				desc: 'Records a 5-second test clip using your current settings and plays it back. Nothing is saved to your vault.',
				// A render row: the capture reports progress into the row and
				// leaves a playback element behind, which no control type covers.
				render: (setting: Setting): (() => void) => {
					setting.settingEl.addClass(SETTINGS_BLOCK_ROW_CLASS);
					setting.addButton((button) =>
						button.setButtonText('Start test').onClick(() => {
							diagnostics.startTestRecording(setting.settingEl);
						}),
					);
					// Handed to whoever renders the row - the framework on 1.13,
					// the legacy renderer below it - and run before the row is
					// rendered again or dropped, so a finished capture never
					// keeps its playback element and blob URL alive detached.
					return (): void => {
						diagnostics.releaseTestRecording();
					};
				},
			},
			{
				name: 'System info',
				desc: 'Show full system diagnostics including plugin settings, audio devices, and browser capabilities.',
				action: (): void => {
					diagnostics.showSystemInfo();
				},
			},
			{
				name: 'Debug mode',
				desc: 'Enable verbose logs for troubleshooting recording issues.',
				control: { type: 'toggle', key: 'debug' },
			},
		],
	};
}

/**
 * Builds the tab's definition tree.
 * @param ctx - The tab's remainder body and action handlers
 * @returns The definitions, in the order the tab renders them
 */
export function buildSettingsDefinitions(
	ctx: SettingsDefinitionContext,
): SettingDefinitionItem[] {
	return [
		{
			name: 'Documentation',
			searchable: false,
			render: (setting: Setting): void => {
				const host = setting.settingEl;
				host.empty();
				host.addClass(SETTINGS_ROOT_CLASS);
				ctx.renderDocumentationLink(host);
			},
		},
		audioInputGroup(ctx.settings, ctx.devices, ctx.sampleRates),
		outputFormatGroup(ctx.outputFormat),
		fileStorageGroup(ctx.settings),
		audioSplittingGroup(),
		multiTrackGroup(ctx.settings, ctx.devices),
		audioPlayerGroup(ctx.settings),
		transcriptionGroup(ctx.settings, ctx.transcriptionBlocks),
		transcriptionAdvancedGroup(ctx.settings, ctx.transcriptionBlocks),
		transcriptOutputGroup(ctx.settings),
		autoChaptersGroup(ctx.settings, ctx.transcriptionBlocks),
		imperativeBlockRow(
			'LLM post-processing',
			ctx.transcriptionBlocks.renderLlmSection,
			() => ctx.settings.transcriptionEnabled,
		),
		audioProcessingGroup(),
		audioCleanupGroup(ctx.settings),
		diagnosticsGroup(ctx.diagnostics),
	];
}

/**
 * The control keys whose writes are worth debouncing: the text-bearing ones,
 * which fire a change per keystroke. Obsidian persists a control change the
 * moment it happens, so without this a single typed word rewrites data.json a
 * dozen times. Derived from the tree rather than listed by hand, so a control
 * that becomes a text field cannot be forgotten here.
 * @param items - The definition tree to scan
 * @returns Keys of every text and textarea control in the tree
 */
export function collectDebouncedControlKeys(
	items: readonly SettingDefinitionItem[],
): Set<string> {
	const keys = new Set<string>();
	const scan = (entries: readonly SettingDefinitionItem[]): void => {
		for (const entry of entries) {
			if ('type' in entry) {
				scan(entry.items ?? []);
				continue;
			}
			const control = entry.control;
			if (
				control &&
				(control.type === 'text' || control.type === 'textarea')
			) {
				keys.add(control.key);
			}
		}
	};
	scan(items);
	return keys;
}
