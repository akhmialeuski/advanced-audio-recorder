/**
 * Settings interface and default values for the Audio Recorder plugin.
 * @module settings/Settings
 */

import type { ConversionLinkAction, OutputMode } from '../types';
import { SettingsValidationError } from '../errors';
import {
	FORMAT_WEBM,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	SPLIT_PART_SUFFIX_PATTERN,
	SPLIT_PART_SUFFIX_RULE_TEXT,
	DEFAULT_TRANSCRIBE_CHUNK_MB,
	DEFAULT_WHISPER_API_BASE_URL,
	DEFAULT_WHISPER_API_MODEL,
	WHISPER_API_MODEL_SUGGESTIONS,
	DEFAULT_DEEPGRAM_BASE_URL,
	DEFAULT_DEEPGRAM_MODEL,
	DEEPGRAM_MODEL_SUGGESTIONS,
	DEFAULT_GEMINI_BASE_URL,
	DEFAULT_GEMINI_MODEL,
	GEMINI_MODEL_SUGGESTIONS,
	DEFAULT_TRANSCRIPTION_TIMEOUT_MINUTES,
	TRANSCRIPTION_PROVIDER_IDS,
	LLM_PROVIDER_IDS,
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_OPENAI_MODEL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_MODEL,
	DEFAULT_LLM_GEMINI_BASE_URL,
	DEFAULT_LLM_GEMINI_MODEL,
	DEFAULT_LLM_MAX_TOKENS,
	LLM_OPENAI_MODEL_SUGGESTIONS,
	LLM_ANTHROPIC_MODEL_SUGGESTIONS,
	LLM_GEMINI_MODEL_SUGGESTIONS,
	DEFAULT_LLM_CLEANUP_PROMPT,
	DEFAULT_LLM_SUMMARY_PROMPT,
	DEFAULT_LLM_CUSTOM_INSTRUCTION,
	DEFAULT_CLEANUP_HIGHPASS_HZ,
	DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
	DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
} from '../constants';
import { getDefaultDeviceId } from '../utils/DeviceUtils';
import type {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import type { LlmTask } from '../transcription/llmPostProcess';

export type { OutputMode } from '../types';

/**
 * What to do with the converted file link in notes.
 * - 'none': just save the file, don't touch notes
 * - 'replace': replace source file link with the new file link
 * - 'after': insert new file link after the source file link
 */
export type { ConversionLinkAction } from '../types';

/**
 * Track audio sources mapping (track number -> device ID).
 */
export interface AudioSource {
	/** Selected device ID for the track. */
	deviceId: string;
}

/**
 * Track audio sources mapping (track number -> audio source).
 */
export type TrackAudioSources = Map<number, AudioSource>;

/**
 * Serialized track audio sources mapping (track number -> device ID).
 */
export type TrackAudioSourcesRecord = Record<number, string | AudioSource>;

/**
 * Plugin settings interface.
 */
export interface AudioRecorderSettings {
	/** Audio recording format (e.g., 'webm', 'ogg') */
	recordingFormat: string;
	/** Folder path to save recordings */
	saveFolder: string;
	/** Save recordings next to the currently active note */
	saveNearActiveFile: boolean;
	/** Optional subfolder (relative to active file directory) */
	activeFileSubfolder: string;
	/** Prefix for recorded file names */
	filePrefix: string;
	/** Hotkey for start/stop recording */
	startStopHotkey: string;
	/** Hotkey for pause */
	pauseHotkey: string;
	/** Hotkey for resume */
	resumeHotkey: string;
	/** Selected audio device ID */
	audioDeviceId: string;
	/** Audio sample rate in Hz */
	sampleRate: number;
	/** Audio bitrate in bps */
	bitrate: number;
	/** Enable multi-track recording */
	enableMultiTrack: boolean;
	/** Maximum number of tracks */
	maxTracks: number;
	/** Output mode for multi-track recordings */
	outputMode: OutputMode;
	/** Use source names for track file names */
	useSourceNamesForTracks: boolean;
	/** Audio source mapping for each track */
	trackAudioSources: TrackAudioSources;
	/** Enable debug logging */
	debug: boolean;
	/** Insert recording link at the note and cursor position where recording started */
	insertAtOriginalPosition: boolean;
	/** Delete original file after successful format conversion */
	deleteSourceAfterConversion: boolean;
	/** What to do with converted file links in notes */
	conversionLinkAction: ConversionLinkAction;
	/** Automatically split recordings into parts of fixed duration */
	autoSplitEnabled: boolean;
	/** Duration of one split part in minutes */
	splitChunkMinutes: number;
	/** Filename suffix for split parts (e.g. 'part' -> '-part1', '-part2') */
	splitPartSuffix: string;
	/** Delete the source file after a successful manual split */
	deleteSourceAfterSplit: boolean;
	/** Replace the built-in audio embed with the enhanced player */
	enhancedPlayerEnabled: boolean;
	/** Draw the waveform window behind the seek bar */
	playerShowWaveform: boolean;
	/** Show the markers and chapters window below the player */
	playerEnableMarkers: boolean;
	/** Enable the transcription feature */
	transcriptionEnabled: boolean;
	/** Automatically transcribe a recording after it is saved */
	transcribeOnSave: boolean;
	/** Transcription engine: Whisper API or local whisper.cpp */
	transcriptionProvider: TranscriptionProviderId;
	/** Language hint ('auto' to detect) */
	transcriptionLanguage: string;
	/** Request speaker diarization when the provider supports it */
	transcriptionDiarize: boolean;
	/** Request word-level timestamps when supported */
	transcriptionWordTimestamps: boolean;
	/** Upload size limit per chunk, in megabytes (Whisper API) */
	transcriptionChunkMb: number;
	/** Per-request transcription timeout, in minutes (a hung request fails after this) */
	transcriptionTimeoutMinutes: number;
	/** Whisper API base URL (OpenAI-compatible) */
	whisperApiBaseUrl: string;
	/** Whisper API key. Shared with the OpenAI LLM provider as the OpenAI vendor key. */
	whisperApiKey: string;
	/** Whisper API model id (the selected one) */
	whisperApiModel: string;
	/** Known Whisper API model ids offered in the picker (user-editable) */
	whisperApiModels: string[];
	/** Deepgram API base URL */
	deepgramBaseUrl: string;
	/** Deepgram API key */
	deepgramApiKey: string;
	/** Deepgram model id (the selected one) */
	deepgramModel: string;
	/** Known Deepgram model ids offered in the picker (user-editable) */
	deepgramModels: string[];
	/** Gemini API base URL */
	geminiBaseUrl: string;
	/** Gemini API key. Shared between Gemini transcription and the Gemini LLM provider. */
	geminiApiKey: string;
	/** Gemini model id (the selected one) */
	geminiModel: string;
	/** Known Gemini model ids offered in the picker (user-editable) */
	geminiModels: string[];
	/** Path to the local whisper.cpp binary */
	localWhisperBinaryPath: string;
	/** Path to the local whisper model file */
	localWhisperModelPath: string;
	/** Extra CLI arguments for the local whisper binary (space-separated) */
	localWhisperExtraArgs: string;
	/** Where to write the transcript */
	transcriptDestination: TranscriptDestination;
	/** File format when writing a transcript file */
	transcriptFileFormat: TranscriptFileFormat;
	/** Include timestamps in the in-note transcript */
	transcriptIncludeTimestamps: boolean;
	/** Render timestamps as clickable player links */
	transcriptTimestampLinks: boolean;
	/** Include speaker labels in the in-note transcript */
	transcriptIncludeSpeakers: boolean;
	/** Merge consecutive same-speaker segments onto one line */
	transcriptMergeConsecutiveSpeaker: boolean;
	/** Template for the timestamp fragment ({time}) */
	transcriptTimestampFormat: string;
	/** Template for the speaker fragment ({speaker}) */
	transcriptSpeakerFormat: string;
	/** Line arrangement template ({timestamp}/{speaker}/{text}) */
	transcriptLineFormat: string;
	/** Heading inserted above the in-note transcript (empty for none) */
	transcriptHeading: string;
	/** Enable LLM post-processing of the transcript */
	llmPostProcessEnabled: boolean;
	/** LLM post-processing task */
	llmPostProcessTask: LlmTask;
	/** Editable system prompt for the cleanup task (language clause auto-appended) */
	llmCleanupPrompt: string;
	/** Editable system prompt for the summary task (language clause auto-appended) */
	llmSummaryPrompt: string;
	/** Editable instruction for the 'custom' task (sent verbatim) */
	llmCustomInstruction: string;
	/** LLM provider: OpenAI, Anthropic, or Google Gemini */
	llmProvider: LlmProviderId;
	/** LLM base URL */
	llmBaseUrl: string;
	/**
	 * Anthropic API key. OpenAI and Gemini LLM reuse the transcription keys
	 * (whisperApiKey, geminiApiKey) so a vendor token is entered once; Anthropic
	 * has no transcription counterpart, so it keeps its own key here.
	 */
	anthropicApiKey: string;
	/** Selected OpenAI LLM model id */
	llmOpenAiModel: string;
	/** Known OpenAI LLM model ids offered in the picker (user-editable) */
	llmOpenAiModels: string[];
	/** Selected Anthropic LLM model id */
	llmAnthropicModel: string;
	/** Known Anthropic LLM model ids offered in the picker (user-editable) */
	llmAnthropicModels: string[];
	/** Selected Gemini LLM model id */
	llmGeminiModel: string;
	/** Known Gemini LLM model ids offered in the picker (user-editable) */
	llmGeminiModels: string[];
	/** Maximum output tokens for LLM post-processing */
	llmMaxTokens: number;
	/** Apply browser noise suppression to the input */
	inputNoiseSuppression: boolean;
	/** Apply browser echo cancellation to the input */
	inputEchoCancellation: boolean;
	/** Apply browser automatic gain control to the input */
	inputAutoGainControl: boolean;
	/** Show a live input-level meter while recording */
	showInputLevelMeter: boolean;
	/** Show live elapsed time and file size while recording */
	showRecordingStats: boolean;
	/** Show a prominent recording banner on mobile */
	mobileRecordingBanner: boolean;
	/** Default: enable the high-pass (low-rumble removal) stage */
	cleanupHighPassEnabled: boolean;
	/** High-pass filter cutoff in Hz */
	cleanupHighPassHz: number;
	/** Enable the noise gate */
	cleanupNoiseGateEnabled: boolean;
	/** Noise-gate threshold in dBFS */
	cleanupNoiseGateThresholdDb: number;
	/** Enable loudness leveling (compression) */
	cleanupLevelingEnabled: boolean;
	/** Makeup gain in dB applied after leveling */
	cleanupLevelingMakeupDb: number;
}

/** Transcription engine identifier, derived from {@link TRANSCRIPTION_PROVIDER_IDS}. */
export type TranscriptionProviderId =
	(typeof TRANSCRIPTION_PROVIDER_IDS)[keyof typeof TRANSCRIPTION_PROVIDER_IDS];

/** Display labels for each transcription engine (single source for UI). */
export const TRANSCRIPTION_PROVIDER_LABELS: Record<
	TranscriptionProviderId,
	string
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: 'Whisper API (OpenAI-compatible)',
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: 'Deepgram',
	[TRANSCRIPTION_PROVIDER_IDS.GEMINI]: 'Google Gemini',
	[TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER]: 'Local whisper.cpp (desktop)',
};

/** Display labels for each transcript destination (single source for UI). */
export const TRANSCRIPT_DESTINATION_LABELS: Record<
	TranscriptDestination,
	string
> = {
	note: 'Insert into note',
	file: 'Save to file',
	both: 'Note and file',
	link: 'Save to file and link it in the note',
};

/** Display labels for each transcript file format (single source for UI). */
export const TRANSCRIPT_FILE_FORMAT_LABELS: Record<
	TranscriptFileFormat,
	string
> = {
	json: 'JSON (full data + speakers)',
	srt: 'SubRip (.srt)',
	vtt: 'WebVTT (.vtt)',
	txt: 'Plain text (.txt)',
};

/** Display labels for each LLM post-processing task (single source for UI). */
export const LLM_TASK_LABELS: Record<LlmTask, string> = {
	cleanup: 'Clean up',
	summary: 'Summarize',
	custom: 'Custom',
};

/** LLM post-processing provider identifier (derived from {@link LLM_PROVIDER_IDS}). */
export type LlmProviderId =
	(typeof LLM_PROVIDER_IDS)[keyof typeof LLM_PROVIDER_IDS];

/** Display labels for each LLM provider (single source for the UI). */
export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
	[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE]: 'OpenAI',
	[LLM_PROVIDER_IDS.ANTHROPIC]: 'Anthropic (Claude)',
	[LLM_PROVIDER_IDS.GEMINI]: 'Google Gemini',
};

/** A value/label pair for a dropdown control (single source for the UI). */
export interface LabeledOption {
	value: string;
	label: string;
}

/**
 * Builds dropdown options from a label map, preserving key insertion order.
 * Lets the settings tab and the transcription modal share one source of
 * truth for both option values and their display labels.
 * @param labels - Map of value to display label
 * @returns Ordered value/label option pairs
 */
function optionsFromLabels<K extends string>(
	labels: Record<K, string>,
): LabeledOption[] {
	return (Object.keys(labels) as K[]).map((value) => ({
		value,
		label: labels[value],
	}));
}

/** Engine dropdown options, derived from the engine label map. */
export const TRANSCRIPTION_PROVIDER_OPTIONS = optionsFromLabels(
	TRANSCRIPTION_PROVIDER_LABELS,
);

/** Destination dropdown options, derived from the destination label map. */
export const TRANSCRIPT_DESTINATION_OPTIONS = optionsFromLabels(
	TRANSCRIPT_DESTINATION_LABELS,
);

/** File-format dropdown options, derived from the file-format label map. */
export const TRANSCRIPT_FILE_FORMAT_OPTIONS = optionsFromLabels(
	TRANSCRIPT_FILE_FORMAT_LABELS,
);

/** LLM-task dropdown options, derived from the task label map. */
export const LLM_TASK_OPTIONS = optionsFromLabels(LLM_TASK_LABELS);

/** LLM-provider dropdown options, derived from the provider label map. */
export const LLM_PROVIDER_OPTIONS = optionsFromLabels(LLM_PROVIDER_LABELS);

/**
 * Default plugin settings.
 */
export const DEFAULT_SETTINGS: AudioRecorderSettings = {
	recordingFormat: FORMAT_WEBM,
	saveFolder: '',
	saveNearActiveFile: false,
	activeFileSubfolder: '',
	filePrefix: 'recording',
	startStopHotkey: '',
	pauseHotkey: '',
	resumeHotkey: '',
	audioDeviceId: '',
	sampleRate: DEFAULT_SAMPLE_RATE,
	bitrate: DEFAULT_BITRATE,
	enableMultiTrack: false,
	maxTracks: 2,
	outputMode: 'single',
	useSourceNamesForTracks: true,
	trackAudioSources: new Map(),
	debug: false,
	insertAtOriginalPosition: false,
	deleteSourceAfterConversion: false,
	conversionLinkAction: 'replace',
	autoSplitEnabled: false,
	splitChunkMinutes: DEFAULT_SPLIT_CHUNK_MINUTES,
	splitPartSuffix: DEFAULT_SPLIT_PART_SUFFIX,
	deleteSourceAfterSplit: false,
	enhancedPlayerEnabled: false,
	playerShowWaveform: true,
	playerEnableMarkers: true,
	transcriptionEnabled: false,
	transcribeOnSave: false,
	transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	transcriptionLanguage: 'auto',
	transcriptionDiarize: false,
	transcriptionWordTimestamps: false,
	transcriptionChunkMb: DEFAULT_TRANSCRIBE_CHUNK_MB,
	transcriptionTimeoutMinutes: DEFAULT_TRANSCRIPTION_TIMEOUT_MINUTES,
	whisperApiBaseUrl: DEFAULT_WHISPER_API_BASE_URL,
	whisperApiKey: '',
	whisperApiModel: DEFAULT_WHISPER_API_MODEL,
	whisperApiModels: [...WHISPER_API_MODEL_SUGGESTIONS],
	deepgramBaseUrl: DEFAULT_DEEPGRAM_BASE_URL,
	deepgramApiKey: '',
	deepgramModel: DEFAULT_DEEPGRAM_MODEL,
	deepgramModels: [...DEEPGRAM_MODEL_SUGGESTIONS],
	geminiBaseUrl: DEFAULT_GEMINI_BASE_URL,
	geminiApiKey: '',
	geminiModel: DEFAULT_GEMINI_MODEL,
	geminiModels: [...GEMINI_MODEL_SUGGESTIONS],
	localWhisperBinaryPath: '',
	localWhisperModelPath: '',
	localWhisperExtraArgs: '',
	transcriptDestination: 'note',
	transcriptFileFormat: 'json',
	transcriptIncludeTimestamps: true,
	transcriptTimestampLinks: true,
	transcriptIncludeSpeakers: true,
	transcriptMergeConsecutiveSpeaker: true,
	transcriptTimestampFormat: '{time}',
	transcriptSpeakerFormat: '**{speaker}**',
	transcriptLineFormat: '{timestamp} {speaker} {text}',
	transcriptHeading: '## Transcript',
	llmPostProcessEnabled: false,
	llmPostProcessTask: 'cleanup',
	llmCleanupPrompt: DEFAULT_LLM_CLEANUP_PROMPT,
	llmSummaryPrompt: DEFAULT_LLM_SUMMARY_PROMPT,
	llmCustomInstruction: DEFAULT_LLM_CUSTOM_INSTRUCTION,
	llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
	llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
	anthropicApiKey: '',
	llmOpenAiModel: DEFAULT_LLM_OPENAI_MODEL,
	llmOpenAiModels: [...LLM_OPENAI_MODEL_SUGGESTIONS],
	llmAnthropicModel: DEFAULT_LLM_ANTHROPIC_MODEL,
	llmAnthropicModels: [...LLM_ANTHROPIC_MODEL_SUGGESTIONS],
	llmGeminiModel: DEFAULT_LLM_GEMINI_MODEL,
	llmGeminiModels: [...LLM_GEMINI_MODEL_SUGGESTIONS],
	llmMaxTokens: DEFAULT_LLM_MAX_TOKENS,
	inputNoiseSuppression: true,
	inputEchoCancellation: true,
	inputAutoGainControl: true,
	showInputLevelMeter: true,
	showRecordingStats: true,
	mobileRecordingBanner: true,
	cleanupHighPassEnabled: true,
	cleanupHighPassHz: DEFAULT_CLEANUP_HIGHPASS_HZ,
	cleanupNoiseGateEnabled: false,
	cleanupNoiseGateThresholdDb: DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
	cleanupLevelingEnabled: false,
	cleanupLevelingMakeupDb: DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
};

/**
 * Base URLs that ship as provider defaults. Auto-switching only replaces a
 * value still equal to one of these, so a custom endpoint the user typed is
 * never clobbered when the provider changes.
 */
const DEFAULT_LLM_BASE_URLS: ReadonlySet<string> = new Set([
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_GEMINI_BASE_URL,
]);

/**
 * Aligns the LLM base URL with the target provider's default when the current
 * value is still a provider default; a custom URL the user entered is
 * preserved. The model is not switched here - each provider keeps its own
 * selected model in a dedicated field. Mutates and returns `settings` so the
 * settings tab can switch the base URL in one step when the provider changes.
 * @param settings - Settings to adjust in place
 * @param provider - The provider being switched to
 * @returns The same settings object, adjusted
 */
export function applyLlmProviderDefaults(
	settings: AudioRecorderSettings,
	provider: LlmProviderId,
): AudioRecorderSettings {
	if (provider === LLM_PROVIDER_IDS.ANTHROPIC) {
		if (DEFAULT_LLM_BASE_URLS.has(settings.llmBaseUrl)) {
			settings.llmBaseUrl = DEFAULT_LLM_ANTHROPIC_BASE_URL;
		}
		return settings;
	}
	if (provider === LLM_PROVIDER_IDS.GEMINI) {
		if (DEFAULT_LLM_BASE_URLS.has(settings.llmBaseUrl)) {
			settings.llmBaseUrl = DEFAULT_LLM_GEMINI_BASE_URL;
		}
		return settings;
	}
	// OpenAI: only move off another provider's shipped default base URL
	// (Anthropic or Gemini), leaving any other OpenAI-compatible endpoint the
	// user entered intact.
	if (
		settings.llmBaseUrl === DEFAULT_LLM_ANTHROPIC_BASE_URL ||
		settings.llmBaseUrl === DEFAULT_LLM_GEMINI_BASE_URL
	) {
		settings.llmBaseUrl = DEFAULT_LLM_OPENAI_BASE_URL;
	}
	return settings;
}

export interface AudioRecorderSettingsInput extends Partial<
	Omit<AudioRecorderSettings, 'trackAudioSources'>
> {
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord;
}

export interface SerializedAudioRecorderSettings extends Omit<
	AudioRecorderSettings,
	'trackAudioSources'
> {
	trackAudioSources: Record<number, string>;
}

/**
 * Normalizes track audio sources into a Map.
 */
export function normalizeTrackAudioSources(
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord,
): TrackAudioSources {
	if (!trackAudioSources) {
		return new Map();
	}

	if (trackAudioSources instanceof Map) {
		return new Map(trackAudioSources);
	}

	const sources = new Map<number, AudioSource>();
	for (const [key, value] of Object.entries(trackAudioSources)) {
		const trackNumber = Number(key);
		if (Number.isNaN(trackNumber)) {
			continue;
		}
		if (typeof value === 'string') {
			sources.set(trackNumber, { deviceId: value });
			continue;
		}
		if (value && typeof value === 'object' && 'deviceId' in value) {
			const deviceId = (value as { deviceId?: unknown }).deviceId;
			sources.set(trackNumber, {
				deviceId: typeof deviceId === 'string' ? deviceId : '',
			});
		}
	}
	return sources;
}

/**
 * Serializes track audio sources into a plain object.
 */
export function serializeTrackAudioSources(
	trackAudioSources: TrackAudioSources,
): Record<number, string> {
	const serialized: Record<number, string> = {};
	for (const [trackNumber, source] of trackAudioSources.entries()) {
		serialized[trackNumber] = source.deviceId;
	}
	return serialized;
}

/**
 * Serializes settings for persistence.
 */
export function serializeSettings(
	settings: AudioRecorderSettings,
): SerializedAudioRecorderSettings {
	return {
		...settings,
		trackAudioSources: serializeTrackAudioSources(
			settings.trackAudioSources,
		),
	};
}

/**
 * Merges user settings with defaults.
 * @param userSettings - Partial user settings
 * @returns Complete settings object
 */
export function mergeSettings(
	userSettings: AudioRecorderSettingsInput = {},
): AudioRecorderSettings {
	const merged: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		...userSettings,
		trackAudioSources: normalizeTrackAudioSources(
			userSettings.trackAudioSources,
		),
	};
	migrateLegacyLlmSettings(merged, userSettings);
	return merged;
}

/**
 * Carries forward settings saved under the pre-rework LLM schema. The old
 * single `llmApiKey` maps onto the new per-vendor key (OpenAI reuses
 * `whisperApiKey`, Gemini reuses `geminiApiKey`, Anthropic uses its own
 * `anthropicApiKey`), and the old single `llmModel` maps onto the selected
 * model of the stored provider. The superseded flat fields are then dropped so
 * a later save does not persist them. A vendor key already set is never
 * overwritten, so the migration cannot clobber a freshly entered token.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateLegacyLlmSettings(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const legacy = raw as unknown as Record<string, unknown>;
	const legacyKey =
		typeof legacy.llmApiKey === 'string' ? legacy.llmApiKey : '';
	if (legacyKey) {
		if (
			merged.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC &&
			!merged.anthropicApiKey
		) {
			merged.anthropicApiKey = legacyKey;
		} else if (
			merged.llmProvider === LLM_PROVIDER_IDS.GEMINI &&
			!merged.geminiApiKey
		) {
			merged.geminiApiKey = legacyKey;
		} else if (
			merged.llmProvider === LLM_PROVIDER_IDS.OPENAI_COMPATIBLE &&
			!merged.whisperApiKey
		) {
			merged.whisperApiKey = legacyKey;
		}
	}
	const legacyModel =
		typeof legacy.llmModel === 'string' ? legacy.llmModel.trim() : '';
	if (legacyModel) {
		if (merged.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC) {
			merged.llmAnthropicModel = legacyModel;
		} else if (merged.llmProvider === LLM_PROVIDER_IDS.GEMINI) {
			merged.llmGeminiModel = legacyModel;
		} else {
			merged.llmOpenAiModel = legacyModel;
		}
	}
	// Drop the superseded flat fields so a later save does not persist them.
	const mergedRecord = merged as unknown as Record<string, unknown>;
	delete mergedRecord.llmApiKey;
	delete mergedRecord.llmModel;
}

/**
 * Async version of mergeSettings that detects and sets the default audio device
 * if no device is configured. This should be called during plugin initialization
 * to ensure a default device is selected for first-time users.
 * @param userSettings - Partial user settings from storage
 * @returns Complete settings object with default device if needed
 */
export async function mergeSettingsAsync(
	userSettings: AudioRecorderSettingsInput = {},
): Promise<AudioRecorderSettings> {
	const merged = mergeSettings(userSettings);

	// Auto-select default device if no device is configured
	if (!merged.audioDeviceId || merged.audioDeviceId.trim() === '') {
		const defaultDeviceId = await getDefaultDeviceId();
		if (defaultDeviceId) {
			merged.audioDeviceId = defaultDeviceId;
		}
	}

	return merged;
}

/**
 * Validates audio recorder settings before use.
 * @param settings - Settings to validate
 * @throws SettingsValidationError if any setting is invalid
 */
export function validateSettings(settings: AudioRecorderSettings): void {
	if (!settings.audioDeviceId || settings.audioDeviceId.trim() === '') {
		throw new SettingsValidationError(
			'audioDeviceId',
			'Audio device is not selected. Please select an audio input device in plugin settings.',
		);
	}

	if (!settings.sampleRate || settings.sampleRate <= 0) {
		throw new SettingsValidationError(
			'sampleRate',
			'Sample rate must be a positive number.',
		);
	}

	if (!settings.recordingFormat || settings.recordingFormat.trim() === '') {
		throw new SettingsValidationError(
			'recordingFormat',
			'Recording format is not selected.',
		);
	}

	if (!SPLIT_PART_SUFFIX_PATTERN.test(settings.splitPartSuffix)) {
		throw new SettingsValidationError(
			'splitPartSuffix',
			SPLIT_PART_SUFFIX_RULE_TEXT,
		);
	}

	// Validated regardless of autoSplitEnabled: the value is also the
	// default part duration for manual splitting. Runtime paths still
	// clamp/sanitize defensively (clampSplitMinutes, sanitizePartSuffix)
	// because validateSettings is not on the production load path.
	if (
		!Number.isInteger(settings.splitChunkMinutes) ||
		settings.splitChunkMinutes < MIN_SPLIT_CHUNK_MINUTES ||
		settings.splitChunkMinutes > MAX_SPLIT_CHUNK_MINUTES
	) {
		throw new SettingsValidationError(
			'splitChunkMinutes',
			`Part duration must be an integer between ${String(MIN_SPLIT_CHUNK_MINUTES)} and ${String(MAX_SPLIT_CHUNK_MINUTES)} minutes.`,
		);
	}

	if (settings.enableMultiTrack) {
		const trackCount = settings.trackAudioSources.size;
		if (trackCount === 0) {
			throw new SettingsValidationError(
				'trackAudioSources',
				'Multi-track recording is enabled but no audio sources are selected.',
			);
		}
		for (const [trackNum, source] of settings.trackAudioSources.entries()) {
			if (!source.deviceId || source.deviceId.trim() === '') {
				throw new SettingsValidationError(
					`trackAudioSources[${trackNum}]`,
					`Track ${trackNum} has no audio source selected.`,
				);
			}
		}
	}
}
