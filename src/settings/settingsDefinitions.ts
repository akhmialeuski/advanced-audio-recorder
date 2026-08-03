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
 * and the two credential blocks, whose fields are password inputs the control
 * set has no type for and whose identity changes with the selected engine.
 * Those use the framework's own escape hatch, a render callback, and nothing
 * else does.
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
	MIN_LLM_MAX_TOKENS,
	MAX_LLM_MAX_TOKENS,
	LLM_MAX_TOKENS_STEP,
	MIN_TRANSCRIBE_CHUNK_MB,
	MAX_TRANSCRIBE_CHUNK_MB,
} from '../constants';
import {
	LLM_PROVIDER_OPTIONS,
	LLM_TASK_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
} from './labels';
import { PROFILE_KINDS, type ProfileSection } from './profileKinds';
import { LLM_JOBS } from '../transcription/llm/vendors';
import {
	ACCOUNTS,
	ENGINES,
	ENGINE_ORDER,
	accountOf,
	type EngineDescriptor,
	type EngineId,
	type ProviderModels,
} from '../providers/providers';
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

/**
 * Control key for one field of one profile. A profile is an entry in a stored
 * list rather than a settings property, so the key carries the id of the entry
 * it addresses, the way a track control key carries its track number.
 * @param base - Key naming the field, e.g. `dictionaryProfile.terms`
 * @param id - Id of the profile the field belongs to
 */
export const profileControlKey = (base: string, id: string): string =>
	`${base}#${id}`;

/**
 * Reads a profile control key back into the field and the profile it addresses.
 * @param key - A key produced by {@link profileControlKey}
 * @returns The base key and the profile id, or undefined for any other key
 */
export function parseProfileControlKey(
	key: string,
): { base: string; id: string } | undefined {
	const separator = key.indexOf('#');
	if (separator <= 0 || separator === key.length - 1) {
		return undefined;
	}
	return {
		base: key.slice(0, separator),
		id: key.slice(separator + 1),
	};
}

/** Accepted shape of the transcription language field: an ISO code or empty. */
const LANGUAGE_CODE_PATTERN = /^([a-z]{2,3}(-[a-z0-9]{2,8})?|auto)?$/i;

/**
 * Marks a row whose whole body is drawn by hand: the documentation callout and
 * the credential blocks. From 1.13 on, the row of a render definition is the
 * only DOM that definition owns, so the stylesheet strips that row's own flex
 * layout, padding, background, and divider to let the body inside it read as an
 * ordinary settings column rather than as one setting's control.
 */
export const SETTINGS_ROOT_CLASS = 'aar-settings-root';

/**
 * Marks a row whose render callback puts block content (a status line, a
 * playback element) under its control instead of beside it. The stylesheet lets
 * such a row wrap so the block starts on its own line.
 */
export const SETTINGS_BLOCK_ROW_CLASS = 'aar-setting-block-row';

/**
 * Marks a group whose text areas are laid out under their name across the whole
 * row. A glossary or a guidance prompt is edited in paragraphs, and the control
 * column a row gives a text area by default is a few characters wide.
 */
export const STACKED_TEXT_CLASS = 'aar-stacked-text';

/**
 * Marks a block of settings: a group of this tree, whatever it is headed by.
 *
 * The block is what the eye should group by, so the stylesheet draws the line
 * between blocks and switches off the one Obsidian draws between the rows
 * inside them. It needs a handle for that, and a group is the only shape in the
 * tree that takes a class, so every group declared here carries this one - the
 * class also tells the stylesheet which containers are this plugin's, so
 * nothing outside its own settings is restyled.
 */
export const SETTINGS_SECTION_CLASS = 'aar-settings-section';

/**
 * Marks the tab's own container. On 1.13 the blocks carry their own class and
 * the stylesheet finds them there, but the Obsidian below it renders the same
 * tree as a flat list of rows with no group element at all, and its only block
 * boundaries are the heading rows. This is what scopes that half to this tab.
 */
export const SETTINGS_TAB_CLASS = 'aar-settings-tab';

/**
 * The rows of a page that is a single block, wrapped in the group the
 * stylesheet separates. The page title already names the block, so the group
 * carries no heading of its own; without it the framework would wrap the rows
 * in a group of its own that nothing here can mark.
 * @param rows - The page's rows, in the order they are shown
 * @param extraClass - Class the block carries beyond the shared one, where its
 * rows need a layout of their own
 * @returns The page's items
 */
function sectionItems(
	rows: SettingGroupItem[],
	extraClass?: string,
): SettingDefinitionItem[] {
	return [
		{
			type: 'group',
			cls: extraClass
				? `${SETTINGS_SECTION_CLASS} ${extraClass}`
				: SETTINGS_SECTION_CLASS,
			items: rows,
		},
	];
}

/**
 * Marks the block whose rows repeat the same pair of pickers. Sized to its own
 * text, each picker ends where its longest option ends, which turns a block of
 * identical rows into a ragged column; the stylesheet gives them one width.
 */
export const TRACK_ROWS_CLASS = 'aar-track-rows';

/** Visible lines a profile body field opens with. */
const PROFILE_BODY_ROWS = 8;

/**
 * What a page of independent switches says on its entry: how many of them are
 * on. Counted from the rows themselves rather than from a second list of keys,
 * so a switch added to the page is counted without being registered twice.
 * @param rows - The page's rows
 * @param settings - Live settings, read by each row's own key
 * @returns The count, as the entry shows it
 */
function toggleSummary(
	rows: readonly SettingDefinition[],
	settings: AudioRecorderSettings,
): string {
	const keys = rows.flatMap((row) =>
		'control' in row && row.control?.type === 'toggle'
			? [row.control.key]
			: [],
	);
	const on = keys.filter(
		(key) => settings[key as keyof AudioRecorderSettings] === true,
	).length;
	return `${String(on)} of ${String(keys.length)} on`;
}

/** The cleanup stages, in the order their rows appear. */
const CLEANUP_STAGES: ReadonlyArray<{
	readonly key: keyof AudioRecorderSettings;
	readonly label: string;
}> = [
	{ key: 'cleanupHighPassEnabled', label: 'High-pass' },
	{ key: 'cleanupNoiseGateEnabled', label: 'Noise gate' },
	{ key: 'cleanupLevelingEnabled', label: 'Leveling' },
];

/**
 * What the cleanup entry says: which stages the dialog would open with, since
 * "2 of 3" would not say which two.
 * @param settings - Live settings, read by each stage's switch
 * @returns The enabled stages, or Off
 */
function enabledStages(settings: AudioRecorderSettings): string {
	const enabled = CLEANUP_STAGES.filter(
		(stage) => settings[stage.key] === true,
	).map((stage) => stage.label);
	return enabled.length > 0 ? enabled.join(', ') : 'Off';
}

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
 * What the transcription sections need from the tab: the two credential blocks
 * rendered by hand into the row their section keeps for them, and the edits
 * behind the add and delete affordances of the two model lists, which the
 * framework draws but the tab owns.
 */
export interface TranscriptionBlocks {
	/**
	 * A provider's API key, which is a password field rather than a plain one,
	 * so no control type covers it.
	 */
	readonly renderProviderKey: (host: HTMLElement, engineId: EngineId) => void;
	/** The local engine's binary and model paths, which are file pickers. */
	readonly renderLocalWhisperFields: (host: HTMLElement) => void;
	/**
	 * The three edits a model catalogue takes, named by the engine whose
	 * catalogue it is: one mechanism for every provider and both capabilities.
	 *
	 * A model is addressed by its id rather than by its position. The rows are
	 * built from the catalogue as it stood when the tree was built, while the
	 * edit runs against the catalogue as it stands when the row is clicked, and
	 * between those two moments the list can move - another window, a config
	 * reloaded from disk, an id added from a dialog. An id means the same thing
	 * in both.
	 */
	readonly addModel: (engine: EngineId) => void;
	readonly removeModel: (engine: EngineId, model: string) => void;
	readonly selectModel: (engine: EngineId, model: string) => void;
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
	/**
	 * Every profile catalogue, in the order their kinds are declared. A block
	 * takes the ones whose section names it, so a kind added to the registry
	 * needs no branch here.
	 */
	readonly profiles: readonly ProfileCatalogue[];
	/**
	 * Whether a list in this tree needs a labelled add row of its own. False
	 * wherever the renderer already draws one, which the render mode answers.
	 */
	readonly declareListAddRow: boolean;
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
 * A row whose body is rendered by hand, hosted in the row itself, which is the
 * only DOM a render definition owns. The fields inside such a block are
 * invisible to the settings search - it indexes definitions, and the block is
 * one - so the row carries what a user would type looking for them.
 * @param row - Row name, its extra search terms, its body and when it applies
 */
function imperativeBlockRow(row: {
	name: string;
	aliases: string[];
	render: (host: HTMLElement) => void;
	visible: () => boolean;
}): SettingDefinition {
	return {
		name: row.name,
		aliases: row.aliases,
		visible: row.visible,
		render: (setting: Setting): void => {
			const host = setting.settingEl;
			host.empty();
			host.addClass(SETTINGS_ROOT_CLASS);
			row.render(host);
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
		cls: SETTINGS_SECTION_CLASS,
		heading: 'File storage',
		items: [
			{
				name: 'Save folder',
				aliases: ['recordings folder', 'output folder', 'path'],
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
				aliases: ['file name', 'filename', 'naming'],
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
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Output format',
		items: [
			{
				name: 'Recording format',
				aliases: ['codec', 'container', 'mp3', 'wav', 'webm', 'm4a'],
				desc: 'Final file format. Formats this device cannot record are shown blocked.',
				render: (setting: Setting): void => {
					rows.renderFormatRow(setting);
				},
			},
			{
				name: 'Audio bitrate',
				aliases: ['quality', 'kbps'],
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
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Audio input',
		items: [
			{
				name: 'Input device',
				aliases: ['microphone', 'mic', 'source'],
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
				aliases: ['hz', 'khz'],
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
				aliases: ['mono', 'stereo', 'channel'],
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
 * Automatic splitting of a long recording into part files, behind an entry of
 * its own. Four rows nobody reads on the way to something else, and the entry
 * already says whether recordings are split and how often.
 * @param settings - Live settings, read by the entry's value
 */
function audioSplittingPage(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const available = isAutoSplitSupported();
	return {
		type: 'page',
		name: 'Audio splitting',
		desc: 'Saving a long recording as fixed-length part files instead of one.',
		displayValue: (): string =>
			available && settings.autoSplitEnabled
				? `Every ${String(settings.splitChunkMinutes)} min`
				: 'Off',
		items: sectionItems([
			{
				name: 'Split recordings automatically',
				aliases: ['chunk', 'segment', 'long recording'],
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
		]),
	};
}

/**
 * Multi-track capture: the switch, how many tracks to offer, how they are
 * exported, and one input plus channel layout per track. Behind an entry of its
 * own, since two tracks alone are four device rows nobody configures twice. The
 * per-track rows are declared for every track the section can offer and
 * revealed by predicate, so changing the track count reveals rows instead of
 * rebuilding the tab.
 * @param settings - Live settings, read by the predicates
 * @param devices - Input devices as last enumerated
 */
function multiTrackPage(
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
					name: `Track ${String(track)} input`,
					aliases: ['audio source', 'device'],
					desc: `Input device recorded into track ${String(track)}.`,
					visible: offered,
					control: {
						type: 'dropdown',
						key: trackControlKey(track, 'deviceId'),
						options: devices.inputs,
					},
				},
				{
					name: `Track ${String(track)} channels`,
					aliases: ['channel layout', 'mono'],
					desc: `Channel layout recorded into track ${String(track)}: keep the device layout, or reduce it to mono.`,
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
		type: 'page',
		name: 'Multi-track recording',
		desc: 'Recording several input devices at the same time.',
		displayValue: (): string =>
			active() ? `${String(settings.maxTracks)} tracks` : 'Off',
		items: sectionItems(
			[
				{
					name: 'Enable multi-track recording',
					aliases: ['multitrack', 'interview', 'two mics'],
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
			TRACK_ROWS_CLASS,
		),
	};
}

/**
 * The enhanced player and the two windows it can open, behind an entry of its
 * own. The sub-options are revealed by a predicate rather than by redrawing the
 * section.
 * @param settings - Live settings, read by the predicates
 */
function audioPlayerPage(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const enhanced = (): boolean => settings.enhancedPlayerEnabled;
	return {
		type: 'page',
		name: 'Audio player',
		desc: "The embed that replaces Obsidian's own audio player.",
		displayValue: (): string => (enhanced() ? 'On' : 'Off'),
		items: sectionItems([
			{
				name: 'Enhanced audio player',
				aliases: ['waveform player', 'embed'],
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
		]),
	};
}

/**
 * LLM post-processing: the switch, the engine that writes it, and the task and
 * prompt that steer it. Nothing here is shared with the other two LLM jobs any
 * more - each names its own engine beside its own switch - so the rows follow
 * this feature alone.
 * @param settings - Live settings, read by the predicates
 */
function llmGroup(settings: AudioRecorderSettings): SettingDefinitionItem {
	const postProcessing = (): boolean =>
		settings.transcriptionEnabled && settings.llmPostProcessEnabled;
	const promptRow = (
		task: string,
		name: string,
		desc: string,
		key: string,
		rows?: number,
	): SettingDefinition => ({
		name,
		desc,
		visible: (): boolean =>
			postProcessing() && settings.llmPostProcessTask === task,
		control: {
			type: 'textarea',
			key,
			...(rows === undefined ? {} : { rows }),
		},
	});
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'LLM post-processing',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Enable LLM post-processing',
				aliases: ['ai', 'summary', 'cleanup', 'gpt'],
				desc: 'Clean up punctuation and formatting, or summarize the transcript with an LLM.',
				control: { type: 'toggle', key: 'llmPostProcessEnabled' },
			},
			engineChoiceRow(
				'Post-processing engine',
				'Which engine writes the post-processed transcript. Set it up under Engines.',
				LLM_JOBS.postProcess.key,
				postProcessing,
			),
			{
				name: 'Task',
				desc: 'Clean up, summarize into key points, or apply a custom instruction.',
				visible: postProcessing,
				control: {
					type: 'dropdown',
					key: 'llmPostProcessTask',
					options: Object.fromEntries(
						LLM_TASK_OPTIONS.map((option) => [
							option.value,
							option.label,
						]),
					),
				},
			},
			promptRow(
				'cleanup',
				'Cleanup prompt',
				'System instruction for the cleanup pass. The transcript language is appended automatically; empty uses the built-in default.',
				'llmCleanupPrompt',
			),
			promptRow(
				'summary',
				'Summary prompt',
				'System instruction for the summary pass. The transcript language is appended automatically; empty uses the built-in default.',
				'llmSummaryPrompt',
			),
			promptRow(
				'custom',
				'Custom instruction',
				'System instruction applied to the transcript text, sent verbatim.',
				'llmCustomInstruction',
				8,
			),
		],
	};
}

/** One stored profile, as its entry in the catalogue presents it. */
export interface ProfileEntry {
	/** Stable id. Control keys and the edit actions address a profile by it. */
	readonly id: string;
	/** Display name, which is also the name of this profile's page. */
	readonly name: string;
	/** What the entry says about the profile without opening it. */
	readonly summary: string;
}

/** One profile catalogue, as the definitions address it. */
export interface ProfileCatalogue {
	/** Block of the settings this catalogue is shown in. */
	readonly section: ProfileSection;
	/** Heading of the catalogue page, e.g. "Dictionary profiles". */
	readonly heading: string;
	/** Description of the entry that opens the catalogue. */
	readonly selectorDesc: string;
	/** Label and description of the profile body field. */
	readonly bodyName: string;
	readonly bodyDesc: string;
	/** Label and description of the row that makes a profile the default one. */
	readonly selectionName: string;
	readonly selectionDesc: string;
	/** Settings key holding the selected profile id. */
	readonly selectionKey: string;
	/** Control key of a profile's body. */
	readonly bodyKey: string;
	/** The stored profiles, in the order they are shown. */
	entries(settings: AudioRecorderSettings): readonly ProfileEntry[];
	/** Whether this catalogue is on screen at all. */
	visible(settings: AudioRecorderSettings): boolean;
	/** Adds an empty profile under a free name. */
	add(): void;
	/** Asks for a new name for a profile and applies it. */
	rename(id: string): void;
	/** Removes a profile. */
	remove(id: string): void;
}

/**
 * The filter a list of named entries carries in its header. Every collection
 * here is a flat list of names, so they all narrow the same way: the framework
 * draws the field, keeps the query across re-renders, and reapplies it.
 * @param placeholder - Prompt shown in the empty filter field
 * @returns The group's search declaration
 */
function nameFilter(placeholder: string): {
	placeholder: string;
	match: (definition: SettingDefinition, query: string) => boolean;
} {
	return {
		placeholder,
		match: (definition, query): boolean =>
			definition.name.toLowerCase().includes(query.toLowerCase()),
	};
}

/**
 * A labelled row repeating a list's add affordance, declared where the renderer
 * draws only a plus icon in the list header. It sits beside the list rather
 * than in it, since a row inside would be filtered away by the list's own
 * search exactly when an empty result makes adding one the obvious next move.
 * @param name - The label, which is also the icon's tooltip
 * @param desc - What the row creates
 * @param action - The list's own add action
 */
function addItemRow(
	name: string,
	desc: string,
	action: () => void,
): SettingDefinition {
	return {
		name,
		desc,
		action: (): void => {
			action();
		},
	};
}

/**
 * One saved profile, as a page of its own.
 *
 * A profile is an entity, not a setting: it has a name, a body that is edited
 * in paragraphs, and a lifecycle. Giving each one a page means the collection
 * reads as a list of names and nothing else, and every field belongs to the
 * profile whose page it is on rather than to "whichever one is selected".
 *
 * The name is edited through a dialog rather than a field on the page, because
 * the framework addresses an open page by its name: renaming under itself
 * leaves the page unresolvable, so a rename applies and returns to the list.
 * @param catalogue - The profile kind being declared
 * @param entry - The profile this page belongs to
 */
function profilePage(
	catalogue: ProfileCatalogue,
	entry: ProfileEntry,
): SettingGroupItem {
	return {
		type: 'page',
		name: entry.name,
		displayValue: entry.summary,
		items: [
			{
				type: 'group',
				cls: `${SETTINGS_SECTION_CLASS} ${STACKED_TEXT_CLASS}`,
				items: [
					{
						name: catalogue.selectionName,
						desc: catalogue.selectionDesc,
						control: {
							type: 'toggle',
							key: profileControlKey(
								catalogue.selectionKey,
								entry.id,
							),
						},
					},
					{
						name: catalogue.bodyName,
						desc: catalogue.bodyDesc,
						control: {
							type: 'textarea',
							key: profileControlKey(catalogue.bodyKey, entry.id),
							rows: PROFILE_BODY_ROWS,
						},
					},
				],
			},
			{
				type: 'group',
				cls: SETTINGS_SECTION_CLASS,
				items: [
					{
						name: 'Rename profile',
						desc: 'The name this profile is picked by. Applying a new one returns to the list, where it is shown.',
						action: (): void => {
							catalogue.rename(entry.id);
						},
					},
					{
						name: 'Delete profile',
						desc: 'Removes this profile and returns to the list.',
						action: (): void => {
							catalogue.remove(entry.id);
						},
					},
				],
			},
		],
	};
}

/**
 * Every catalogue one block of the settings shows, each as the same pair: the
 * row that picks the profile in use, and the entry that manages them.
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block being built
 */
function profileCatalogues(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingGroupItem[] {
	return ctx.profiles
		.filter((catalogue) => catalogue.section === section)
		.flatMap((catalogue) =>
			profileGroups(ctx.settings, catalogue, ctx.declareListAddRow),
		);
}

/**
 * A profile catalogue: the saved profiles as a list of pages, behind a single
 * entry that names the one in use.
 *
 * A glossary runs to dozens of profiles and every one of them was a row on the
 * transcription page, pushing the settings after it off the screen. On a page
 * of their own they cost one row, which reads the way the style guide wants a
 * collection to read: the name of the thing, the value in use, and a way in.
 * @param settings - Live settings, read by the predicates
 * @param catalogue - The profile kind being declared
 * @param declareAddRow - Whether this tree owes the list a labelled add row,
 * which is the case wherever the renderer draws only a plus icon
 */
function profileGroups(
	settings: AudioRecorderSettings,
	catalogue: ProfileCatalogue,
	declareAddRow: boolean,
): SettingGroupItem[] {
	const entries = catalogue.entries(settings);
	const visible = (): boolean => catalogue.visible(settings);
	const selectedName = (): string => {
		const selected = settings[
			catalogue.selectionKey as keyof AudioRecorderSettings
		] as string;
		return (
			catalogue.entries(settings).find((entry) => entry.id === selected)
				?.name ?? 'None'
		);
	};
	const add = (): void => {
		catalogue.add();
	};
	const selectionRow: SettingGroupItem = {
		name: catalogue.selectionName,
		aliases: ['profile', 'preset'],
		desc: catalogue.selectionDesc,
		visible,
		control: {
			type: 'dropdown',
			key: catalogue.selectionKey,
			// None is a real answer: a run then applies no profile of this kind.
			options: {
				'': 'None',
				...Object.fromEntries(
					entries.map((entry) => [entry.id, entry.name]),
				),
			},
		},
	};
	return [
		selectionRow,
		{
			type: 'page',
			name: catalogue.heading,
			desc: catalogue.selectorDesc,
			displayValue: selectedName,
			visible,
			items: [
				{
					type: 'list',
					cls: SETTINGS_SECTION_CLASS,
					emptyState: 'No profiles yet. Add one to start.',
					search: nameFilter('Filter profiles'),
					addItem: { name: 'Add profile', action: add },
					items: entries.map((entry) =>
						profilePage(catalogue, entry),
					),
				},
				// Beside the list rather than in it: a row inside would be
				// filtered away by the list's own search, exactly when an empty
				// result makes adding one the obvious next move.
				...(declareAddRow
					? [
							addItemRow(
								'Add profile',
								'Creates an empty profile at the end of the list.',
								add,
							),
						]
					: []),
			],
		},
	];
}

/**
 * The row that picks which engine does a job. Every job that calls an engine
 * declares one, right under the switch that turns the job on, so the engine is
 * settled before anything about how the job runs.
 * @param name - Row name, e.g. "Chapters engine"
 * @param desc - What the engine is called for
 * @param key - Settings key holding the choice
 * @param visible - Whether the job is on
 */
function engineChoiceRow(
	name: string,
	desc: string,
	key: keyof AudioRecorderSettings,
	visible: () => boolean,
): SettingGroupItem {
	return {
		name,
		aliases: ['provider', 'vendor', 'model', 'llm'],
		desc,
		visible,
		control: {
			type: 'dropdown',
			key,
			options: Object.fromEntries(
				LLM_PROVIDER_OPTIONS.map((option) => [
					option.value,
					option.label,
				]),
			),
		},
	};
}

/**
 * One engine's own page: the account it is reached through, the models it
 * serves, and the one it uses.
 *
 * Every engine is declared the same way, so the page asks the same questions of
 * each and shows only the answers that exist: an engine with no account has no
 * endpoint rows, one with no catalogue has no model rows, and one that sends a
 * recording whole has no chunk row. Two engines over one account share its
 * endpoint and its key, which is why the key is entered once.
 * @param settings - Live settings, read for the entry's value
 * @param engine - The engine being declared
 * @param blocks - The password field and the list edits, which the tab owns
 * @param declareAddRow - Whether the tree owes a list a labelled add row
 */
function enginePage(
	settings: AudioRecorderSettings,
	engine: EngineDescriptor,
	blocks: TranscriptionBlocks,
	declareAddRow: boolean,
): SettingGroupItem {
	const connection = accountOf(engine);
	const rows: SettingGroupItem[] = [];
	if (connection) {
		rows.push({
			name: 'Base URL',
			aliases: ['endpoint', 'api url', 'self hosted'],
			desc: connection.baseUrlFieldDesc,
			control: { type: 'text', key: connection.baseUrlKey },
		});
		rows.push(
			imperativeBlockRow({
				name: connection.keyFieldName,
				aliases: ['api key', 'token', 'credentials'],
				render: (host) => {
					blocks.renderProviderKey(host, engine.id);
				},
				visible: () => true,
			}),
		);
	}
	const models = engine.models;
	if (models) {
		// One row, not two: the catalogue entry names the id in use and opens
		// the list the choice is made in, so a dropdown beside it would be the
		// same value twice - and the one that does not refresh the entry.
		rows.push(
			modelCataloguePage(
				settings,
				engine.id,
				models,
				blocks,
				declareAddRow,
			),
		);
	}
	if (engine.maxTokens) {
		rows.push({
			name: 'Max output tokens',
			aliases: ['length', 'limit', 'response'],
			desc: "Longest answer this engine may write, whichever job calls it. The model's own maximum is the real limit; a budget above it is refused by the service, which names the maximum it allows.",
			control: {
				type: 'number',
				key: engine.maxTokens.key,
				min: MIN_LLM_MAX_TOKENS,
				max: MAX_LLM_MAX_TOKENS,
				step: LLM_MAX_TOKENS_STEP,
			},
		});
	}
	if (engine.uploadChunk) {
		rows.push({
			name: 'Upload chunk size',
			desc: `Megabytes per WAV chunk when a recording is too large to upload whole (this engine accepts ${String(engine.uploadLimitMb)} MB per request). Files under the limit are sent untouched.`,
			control: {
				type: 'number',
				key: engine.uploadChunk.key,
				min: MIN_TRANSCRIBE_CHUNK_MB,
				max: MAX_TRANSCRIBE_CHUNK_MB,
				step: 1,
			},
		});
	}
	if (!connection) {
		rows.push(
			imperativeBlockRow({
				name: 'Binary and model paths',
				aliases: ['whisper.cpp', 'offline', 'local'],
				render: blocks.renderLocalWhisperFields,
				visible: () => true,
			}),
		);
	}
	return {
		type: 'page',
		name: engine.label,
		desc: engineJobsDesc(engine),
		displayValue: (): string => engineSummary(settings, engine),
		items: sectionItems(rows),
	};
}

/** What an engine can be asked to do, for its entry's description. */
function engineJobsDesc(engine: EngineDescriptor): string {
	if (engine.transcriptionId && engine.llmId) {
		return 'Transcribes recordings and answers the post-processing prompts.';
	}
	if (engine.transcriptionId) {
		return 'Transcribes recordings.';
	}
	return 'Answers the post-processing prompts.';
}

/**
 * What an engine's entry says without being opened: whether it is reachable,
 * and which model it uses. Both halves are needed to run, so an engine with a
 * key but an emptied catalogue reports the half it is still missing rather than
 * reading as configured.
 * @param settings - Live settings, read for the key and the choice
 * @param engine - The engine being described
 */
function engineSummary(
	settings: AudioRecorderSettings,
	engine: EngineDescriptor,
): string {
	const connection = accountOf(engine);
	if (!connection) {
		return settings.localWhisperBinaryPath ? 'Configured' : 'No binary';
	}
	if (!connection.apiKey(settings)) {
		return 'No key';
	}
	if (!engine.models) {
		return 'Key set';
	}
	return engine.models.model(settings) || 'No model';
}

/**
 * How many accounts a key has been entered for. An account is what a key
 * belongs to, so the accounts themselves are counted rather than the engines
 * behind them: two engines over one account are one answer, not two.
 * @param settings - Live settings, read for each account's key
 */
function configuredAccountCount(settings: AudioRecorderSettings): number {
	return Object.values(ACCOUNTS).filter((account) => account.apiKey(settings))
		.length;
}

/**
 * Every engine, each on a page of its own. One place to set a service up,
 * whatever it is later used for, which is what the transcription block and the
 * post-processing block point at instead of holding their own copies.
 * @param ctx - Everything the tree reads from the tab
 */
function enginesPage(ctx: SettingsDefinitionContext): SettingGroupItem {
	return {
		type: 'page',
		name: 'Engines',
		desc: 'The services this plugin calls: where each one is reached, and the models it serves.',
		// Counted by account rather than by engine: a key configures the account
		// it belongs to, and the two engines over the OpenAI account would
		// otherwise both report the one key that was entered.
		displayValue: (): string =>
			`${String(configuredAccountCount(ctx.settings))} configured`,
		visible: (): boolean => ctx.settings.transcriptionEnabled,
		items: sectionItems(
			ENGINE_ORDER.map((id) =>
				enginePage(
					ctx.settings,
					ENGINES[id],
					ctx.transcriptionBlocks,
					ctx.declareListAddRow,
				),
			),
		),
	};
}

/**
 * What a model catalogue says about itself: how to pick an id, followed by the
 * provider's own list of the ids it serves. A description is where Obsidian
 * puts such a link, which is why this is a fragment rather than a string.
 * @param models - The catalogue's own copy and catalogue link
 * @returns The description, link included
 */
function catalogueDesc(models: ProviderModels): DocumentFragment {
	return createFragment((fragment) => {
		fragment.appendChild(createSpan({ text: `${models.pickerDesc} ` }));
		fragment.appendChild(
			createEl('a', {
				text: models.docLabel,
				attr: {
					href: models.docUrl,
					target: '_blank',
					rel: 'noopener',
				},
			}),
		);
	});
}

/**
 * A provider's saved model ids, as the page the picking happens on. The list is
 * a collection the user edits, so it is declared as one: the framework renders
 * its add and delete affordances and its filter, and tapping a row makes that
 * id the one in use. One builder serves every catalogue - a speech one, a text
 * one, whichever provider they belong to - because a catalogue differs only in
 * which fields it reads.
 * @param settings - Live settings, read for the current selection
 * @param engine - The engine whose catalogue this is
 * @param models - The catalogue's own settings fields and copy
 * @param blocks - The list edits, which the tab owns
 * @param declareAddRow - Whether the tree owes the list a labelled add row
 */
function modelCataloguePage(
	settings: AudioRecorderSettings,
	engine: EngineId,
	models: ProviderModels,
	blocks: TranscriptionBlocks,
	declareAddRow: boolean,
): SettingGroupItem {
	const saved = models.models(settings);
	const add = (): void => {
		blocks.addModel(engine);
	};
	return {
		// The entry is the picker: it says which id is in use, and opens the
		// catalogue it was chosen from. A vendor's catalogue runs to thirty-odd
		// ids, which inline is thirty rows between the endpoint and everything
		// configured after it.
		type: 'page',
		name: models.pickerName,
		// The catalogue link belongs here, with the catalogue it lists: it used
		// to hang off the API-key row, which is a password field and has nothing
		// to do with which ids the endpoint serves.
		desc: catalogueDesc(models),
		// Read when the entry is drawn, not when the tree was built: the
		// framework re-evaluates an entry's value without re-reading the
		// definitions, and an entry naming the previous model is the same
		// stale copy the dropdown beside it used to be.
		displayValue: (): string => models.model(settings) || 'None',
		items: [
			{
				type: 'list',
				cls: SETTINGS_SECTION_CLASS,
				emptyState:
					'No models saved yet. Add the model id your endpoint serves.',
				search: nameFilter('Filter models'),
				addItem: { name: 'Add model', action: add },
				onDelete: (index): void => {
					const id = saved[index];
					if (id !== undefined) {
						blocks.removeModel(engine, id);
					}
				},
				items: saved.map(
					(id): SettingGroupItem => ({
						name: id,
						// The row is the choice: tapping an id puts it to work,
						// and the one in use says so. A row's description is a
						// string the framework renders, not a predicate it
						// re-evaluates, so this is the selection as the tree was
						// built - which is what a rebuild is for.
						...(id === models.model(settings)
							? { desc: 'In use' }
							: {}),
						action: (): void => {
							blocks.selectModel(engine, id);
						},
					}),
				),
			},
			...(declareAddRow
				? [
						addItemRow(
							'Add model',
							'Saves another model id for this provider.',
							add,
						),
					]
				: []),
		],
	};
}

/**
 * The transcription section. Everything below the section's own switch is
 * revealed by a predicate rather than by re-rendering the section, and the
 * options an engine cannot deliver are disabled rather than hidden, so the user
 * can see the option exists and why it is unavailable.
 * @param ctx - Everything the tree reads from the tab
 * @param enginesEntry - The entry opening the page every engine is set up on,
 * placed right under the engine choice it configures
 */
function transcriptionGroup(
	ctx: SettingsDefinitionContext,
	enginesEntry: SettingGroupItem,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const enabled = (): boolean => settings.transcriptionEnabled;
	const canDiarize = (): boolean =>
		providerSupportsDiarization(settings.transcriptionProvider);
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Transcription',
		items: [
			{
				name: 'Enable transcription',
				aliases: ['speech to text', 'stt', 'subtitles', 'whisper'],
				desc: 'Transcribe recordings to text, with optional speaker labels and LLM post-processing.',
				control: { type: 'toggle', key: 'transcriptionEnabled' },
			},
			// The first thing to settle once transcription is on, so it opens
			// the block rather than sitting below the run options: which
			// service transcribes, and the page where every service is set up.
			transcriptionEngineRow(settings),
			enginesEntry,
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
				name: 'Language',
				aliases: ['locale', 'spoken language'],
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
				aliases: ['speakers', 'who spoke', 'diarisation'],
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
			// The rosters a run labels speakers with, beside the switch that
			// asks for the labels.
			...profileCatalogues(ctx, 'transcription'),
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
		],
	};
}

/**
 * Which service transcribes. Only the choice: where that service is reached and
 * which models it serves are configured once, on its own page under Engines.
 * @param settings - Live settings, read by the predicate
 */
function transcriptionEngineRow(
	settings: AudioRecorderSettings,
): SettingGroupItem {
	return {
		// Named for the job it configures rather than "Engine": three rows pick
		// an engine, on three pages, and the settings search lists them by name
		// alone - three results reading "Engine" name nothing.
		name: 'Transcription engine',
		aliases: ['provider', 'whisper', 'deepgram', 'gemini', 'elevenlabs'],
		desc: 'Whisper API, Deepgram, or Google Gemini (cloud), or a local whisper.cpp binary (desktop). Configure each one under Engines.',
		visible: (): boolean => settings.transcriptionEnabled,
		control: {
			type: 'dropdown',
			key: 'transcriptionProvider',
			// Every device lists every engine, so the dropdown reads the same
			// everywhere; picking one this device cannot run is refused with
			// the reason instead of silently blocked.
			options: Object.fromEntries(
				TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => [
					option.value,
					option.label,
				]),
			),
			validate: (value: string): string | undefined =>
				isProviderAvailableOnPlatform(value as TranscriptionProviderId)
					? undefined
					: 'Not available on this device.',
		},
	};
}

/**
 * The advanced transcription block: dictionary term biasing and the two-pass
 * mode, both behind a master switch that is off for a plain run.
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block whose profile catalogues belong here
 */
function transcriptionAdvancedGroup(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const advanced = (): boolean =>
		settings.transcriptionEnabled &&
		settings.transcriptionAdvancedSettingsEnabled;
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
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
			{
				name: 'Advanced two-pass transcription (experimental)',
				desc: 'Transcribe twice: LLM agents mine the first draft for names and jargon, and the second pass re-decodes biased toward them. Roughly twice the engine cost and time, plus several LLM calls per file.',
				visible: advanced,
				control: {
					type: 'toggle',
					key: 'transcriptionAdvancedEnabled',
				},
			},
			engineChoiceRow(
				'Context agents engine',
				'Which engine the context agents call between the two passes. Set it up under Engines.',
				LLM_JOBS.contextAgents.key,
				(): boolean =>
					advanced() && settings.transcriptionAdvancedEnabled,
			),
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
			// The profiles this block owns, inside the block that gates them.
			...profileCatalogues(ctx, section),
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
		cls: SETTINGS_SECTION_CLASS,
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
				aliases: ['speaker names', 'labels'],
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
 * @param ctx - Everything the tree reads from the tab
 * @param section - The block whose profile catalogues belong here
 */
function autoChaptersGroup(
	ctx: SettingsDefinitionContext,
	section: ProfileSection,
): SettingDefinitionItem {
	const settings = ctx.settings;
	const enabled = (): boolean =>
		settings.transcriptionEnabled &&
		settings.transcriptionAutoChaptersEnabled;
	return {
		type: 'group',
		cls: SETTINGS_SECTION_CLASS,
		heading: 'Auto chapters',
		visible: (): boolean => settings.transcriptionEnabled,
		items: [
			{
				name: 'Auto chapters',
				aliases: ['sections', 'headings'],
				desc: 'Add an action that asks the LLM to divide a transcribed recording into titled chapters, shown in the enhanced player.',
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersEnabled',
				},
			},
			engineChoiceRow(
				'Chapters engine',
				'Which engine divides a transcript into chapters. Set it up under Engines.',
				LLM_JOBS.autoChapters.key,
				enabled,
			),
			{
				name: 'Generate after transcription',
				desc: 'Generate chapters each time a recording is transcribed.',
				visible: enabled,
				control: {
					type: 'toggle',
					key: 'transcriptionAutoChaptersOnTranscribe',
				},
			},
			// The profiles this block owns, inside the block that gates them.
			...profileCatalogues(ctx, section),
		],
	};
}

/**
 * The input-processing constraints and the live recording feedback, behind an
 * entry of its own. Seven switches that are set once and then read past, so the
 * entry counts how many are on rather than showing them all.
 * @param settings - Live settings, read by the entry's value
 */
function audioProcessingPage(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	const rows: SettingDefinition[] = [
		{
			name: 'Noise suppression',
			aliases: ['background noise'],
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
	];
	return {
		type: 'page',
		name: 'Audio processing & feedback',
		desc: 'Filters applied to the input, and what is shown while recording.',
		displayValue: (): string => toggleSummary(rows, settings),
		items: sectionItems(rows),
	};
}

/**
 * The defaults for the on-demand cleanup dialog. Each stage is a switch and the
 * one number it takes, on rows of their own: a row holds a single control, and
 * the number follows the switch that decides whether it is used at all.
 * @param settings - Live settings, read by the disabled predicates
 */
function audioCleanupPage(
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'page',
		name: 'Audio cleanup defaults',
		desc: 'What the on-demand cleanup dialog opens with.',
		displayValue: (): string => enabledStages(settings),
		items: sectionItems([
			{
				name: 'High-pass filter',
				aliases: ['low cut', 'rumble'],
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
				aliases: ['silence', 'gate'],
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
				aliases: ['normalize', 'normalisation', 'lufs'],
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
		]),
	};
}

/**
 * The diagnostics section: a test capture, the system-information dialog, and
 * the debug switch. Behind an entry of its own, since it is opened when
 * something is wrong rather than while a recording is being set up, and its
 * entry reports the one state it holds.
 * @param diagnostics - Handlers for the two action rows
 * @param settings - Live settings, read by the entry's value
 */
function diagnosticsPage(
	diagnostics: DiagnosticsActions,
	settings: AudioRecorderSettings,
): SettingDefinitionItem {
	return {
		type: 'page',
		name: 'Diagnostics',
		desc: 'A test capture, the system report, and verbose logging.',
		displayValue: (): string => (settings.debug ? 'Debug on' : 'Debug off'),
		items: sectionItems([
			{
				name: 'Test recording',
				aliases: ['microphone test', 'check mic'],
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
				aliases: ['diagnostics', 'support', 'report'],
				desc: 'Show full system diagnostics including plugin settings, audio devices, and browser capabilities.',
				action: (): void => {
					diagnostics.showSystemInfo();
				},
			},
			{
				name: 'Debug mode',
				aliases: ['logs', 'logging', 'verbose'],
				desc: 'Enable verbose logs for troubleshooting recording issues.',
				control: { type: 'toggle', key: 'debug' },
			},
		]),
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
		audioSplittingPage(ctx.settings),
		multiTrackPage(ctx.settings, ctx.devices),
		audioPlayerPage(ctx.settings),
		{
			// Forty-odd settings with a scope of their own: the style guide's
			// case for a sub-page, and it keeps the main tab scannable.
			type: 'page',
			name: 'Transcription',
			desc: 'Speech-to-text, transcript output, chapters, and LLM post-processing.',
			displayValue: (): string =>
				ctx.settings.transcriptionEnabled ? 'On' : 'Off',
			items: [
				// Each block holds what belongs to it, catalogues included:
				// nothing floats on the page beside the section it configures.
				transcriptionGroup(ctx, enginesPage(ctx)),
				transcriptOutputGroup(ctx.settings),
				autoChaptersGroup(ctx, 'chapters'),
				llmGroup(ctx.settings),
				transcriptionAdvancedGroup(ctx, 'advanced'),
			],
		},
		audioProcessingPage(ctx.settings),
		audioCleanupPage(ctx.settings),
		diagnosticsPage(ctx.diagnostics, ctx.settings),
	];
}

/**
 * What writing a control means beyond storing its value.
 *
 * A `visible` predicate covers a setting that reveals another one, which is
 * most of them. It cannot cover the rest of what a write can mean: a value the
 * plugin stores in a form of its own, or a choice that leaves the same rows on
 * screen holding different things. Both live here, next to the declarations
 * they belong to, rather than as branches in the tab's write path.
 */
export interface ControlWriteEffect {
	/** Rewrites the value before it is stored. */
	readonly normalize?: (value: string) => string;
	/**
	 * Whether the setting holds a number while the control bound to it speaks
	 * strings, which is the case for the two dropdowns that pick one. Both
	 * directions convert: without it the string a dropdown hands back would be
	 * stored where the schema declares a number - past the type system, since a
	 * control key addresses the settings object dynamically - and the number
	 * read back would match no option, leaving the dropdown blank.
	 */
	readonly numeric?: boolean;
	/**
	 * Whether the write changes what other rows *show*, not merely whether they
	 * show. Picking another engine swaps the model catalogue and the credential
	 * fields; picking another profile repoints the editor below it. The rows
	 * are the same rows with different contents, which no predicate expresses,
	 * so the tree is read again.
	 */
	readonly reshapesTree?: boolean;
}

/** The writes that mean more than "store this". Keyed by control key. */
export const CONTROL_WRITE_EFFECTS: Readonly<
	Record<string, ControlWriteEffect>
> = {
	transcriptionLanguage: {
		// Stored as the engines receive it: " en " is the same language as
		// "en", and an untrimmed code reaches the request verbatim.
		normalize: (value) => value.trim(),
	},
	// The only two settings a dropdown edits that are not stored as text; every
	// other numeric setting uses a number control, which speaks numbers.
	bitrate: { numeric: true },
	sampleRate: { numeric: true },
	// Picking another transcription engine rewrites the descriptions the
	// speaker rows carry, which are built from the engine rather than
	// re-evaluated per pass. The three rows that pick an engine for an LLM job
	// need no entry: every service is configured on its own page now, so
	// nothing under such a row holds the chosen vendor's fields.
	transcriptionProvider: { reshapesTree: true },
	// Every catalogue names the profile in use on the entry that opens it, so
	// moving that selection leaves those rows holding something else. Read from
	// the kinds themselves, so a kind added there arrives with this behaviour
	// instead of silently missing it.
	...Object.fromEntries(
		PROFILE_KINDS.map((kind) => [
			kind.selectionKey,
			{ reshapesTree: true },
		]),
	),
};

/**
 * Projects a stored value into what its control speaks, and back. The two
 * halves sit together so a conversion cannot be applied in one direction only.
 */
export const controlValue = {
	/**
	 * The stored value as the control reads it.
	 * @param key - The settings key the control is bound to
	 * @param stored - The stored value
	 */
	read(key: string, stored: unknown): unknown {
		return CONTROL_WRITE_EFFECTS[key]?.numeric ? String(stored) : stored;
	},
	/**
	 * The control's value as the setting stores it. A field left empty or
	 * holding something unparseable keeps the stored value rather than writing
	 * NaN into it.
	 * @param key - The settings key the control is bound to
	 * @param value - The value the control produced
	 * @param stored - What the setting holds now
	 */
	write(key: string, value: unknown, stored: unknown): unknown {
		const effect = CONTROL_WRITE_EFFECTS[key];
		if (effect?.numeric) {
			// An empty field reads as 0 through Number(), which is a value no
			// numeric setting here can take, so it counts as unparseable.
			const empty = typeof value === 'string' && value.trim() === '';
			const parsed = Number(value);
			return !empty && Number.isFinite(parsed) ? parsed : stored;
		}
		return effect?.normalize && typeof value === 'string'
			? effect.normalize(value)
			: value;
	},
};

/**
 * Largest share of one step a value may miss its grid point by and still count
 * as sitting on it. A grid of tenths cannot be walked in binary floating point
 * - `0.5 + 7 * 0.05` is not `0.85` - so the comparison is made against the
 * nearest grid point rather than by asking whether the quotient is an integer.
 */
const STEP_GRID_TOLERANCE = 1e-6;

/**
 * Why a number is outside what its control accepts, or undefined when it is
 * inside.
 *
 * A number control declares a value space, and the whole of it: the bounds the
 * value lies between and the grid it sits on, which is `min + n * step`. From
 * 1.13 the framework enforces that space itself, refusing anything between two
 * grid points; below it {@link module:settings/legacySettingsRenderer} enforces
 * this, so one declaration means one set of accepted values on both Obsidians
 * rather than two.
 *
 * It follows that a bound no grid point reaches is a declaration that cannot be
 * satisfied - the ceiling of a 512-token grid at 32000 was one - which is why
 * the tree is tested for it rather than left to be discovered as a setting that
 * will not save.
 * @param control - The number control the value was entered into
 * @param value - The number the field produced
 * @returns The reason it is refused, or undefined when it is accepted
 */
export function numberControlRejection(
	control: {
		min?: number | undefined;
		max?: number | undefined;
		/** `'any'` is the input's own way of declaring no grid at all. */
		step?: number | 'any' | undefined;
	},
	value: number,
): string | undefined {
	if (!Number.isFinite(value)) {
		return 'Enter a number.';
	}
	const { min, max, step } = control;
	if (min !== undefined && value < min) {
		return `Enter ${String(min)} or more.`;
	}
	if (max !== undefined && value > max) {
		return `Enter ${String(max)} or less.`;
	}
	if (step === undefined || step === 'any' || step <= 0) {
		return undefined;
	}
	const base = min ?? 0;
	const snapped = base + Math.round((value - base) / step) * step;
	return Math.abs(value - snapped) > step * STEP_GRID_TOLERANCE
		? `Enter a multiple of ${String(step)}${
				min === undefined ? '' : ` above ${String(min)}`
			}.`
		: undefined;
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
