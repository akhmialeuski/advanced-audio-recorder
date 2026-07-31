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
 * Sections migrate into this tree from the bottom of the tab upwards, so the
 * part still rendered imperatively stays one contiguous block at the top and row
 * order never changes while the migration runs. That block is the remainder
 * definition below; it shrinks with each migrated section and goes away with the
 * last one.
 * @module settings/settingsDefinitions
 */

import type { Setting, SettingDefinitionItem } from 'obsidian';
import type { AudioRecorderSettings } from './settingsSchema';
import {
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
} from '../constants';
import { TRANSCRIPTION_PROVIDER_OPTIONS } from './labels';
import {
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
} from '../transcription/providers/capabilities';
import type { TranscriptionProviderId } from './settingsSchema';

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
 * The sections still rendered by the tab's own imperative body.
 */
export interface ImperativeRemainder {
	/** Row name, which is also what the settings search matches the tab by. */
	readonly name: string;
	/** Names of the settings inside the remainder, carried as search aliases. */
	readonly aliases: readonly string[];
	/** Draws those sections into a host the definition has already cleared. */
	render(host: HTMLElement): void;
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
	/** The sections not migrated into this tree yet. */
	readonly remainder: ImperativeRemainder;
	/** Handlers for the diagnostics rows. */
	readonly diagnostics: DiagnosticsActions;
	/**
	 * Draws the transcription settings that are not definitions yet, into the
	 * row the transcription section keeps for them.
	 */
	renderTranscriptionRest(host: HTMLElement): void;
}

/**
 * The definition for the sections still rendered imperatively. Its row is the
 * only host that survives the framework's post-render pass, so the body is
 * rendered into the row itself, over the name, description, and control
 * elements the framework prefilled it with.
 * @param remainder - The imperative body and its search metadata
 */
function remainderDefinition(
	remainder: ImperativeRemainder,
): SettingDefinitionItem {
	return {
		name: remainder.name,
		// The settings inside this block are not definitions of their own yet,
		// so the search cannot index them individually. Their names travel as
		// aliases until they are migrated, which at least finds the tab.
		aliases: [...remainder.aliases],
		render: (setting: Setting): void => {
			const host = setting.settingEl;
			host.empty();
			host.addClass(SETTINGS_ROOT_CLASS);
			remainder.render(host);
		},
	};
}

/**
 * The transcription section. Everything below the section's own switch is
 * revealed by a predicate rather than by re-rendering the section, and the
 * options an engine cannot deliver are disabled rather than hidden, so the user
 * can see the option exists and why it is unavailable.
 * @param settings - Live settings, read by the predicates
 * @param renderRest - Draws the parts of the section that are not definitions
 * yet, into the row the tree keeps for them
 */
function transcriptionGroup(
	settings: AudioRecorderSettings,
	renderRest: (host: HTMLElement) => void,
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
			{
				name: 'Transcription engine settings',
				visible: enabled,
				render: (setting: Setting): void => {
					const host = setting.settingEl;
					host.empty();
					host.addClass(SETTINGS_ROOT_CLASS);
					renderRest(host);
				},
			},
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
		remainderDefinition(ctx.remainder),
		transcriptionGroup(ctx.settings, (host) => {
			ctx.renderTranscriptionRest(host);
		}),
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
