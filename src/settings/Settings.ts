/**
 * Settings interface and default values for the Audio Recorder plugin.
 * @module settings/Settings
 */

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
	DEFAULT_DEEPGRAM_BASE_URL,
	DEFAULT_DEEPGRAM_MODEL,
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_OPENAI_MODEL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_MODEL,
	DEFAULT_LLM_OLLAMA_BASE_URL,
	DEFAULT_LLM_MAX_TOKENS,
} from '../constants';
import { getDefaultDeviceId } from '../utils/DeviceUtils';
import type {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import type { LlmTask } from '../transcription/llmPostProcess';

/**
 * Output mode for multi-track recordings.
 */
export type OutputMode = 'single' | 'multiple';

/**
 * What to do with the converted file link in notes.
 * - 'none': just save the file, don't touch notes
 * - 'replace': replace source file link with the new file link
 * - 'after': insert new file link after the source file link
 */
export type ConversionLinkAction = 'none' | 'replace' | 'after';

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
	/** Whisper API base URL (OpenAI-compatible) */
	whisperApiBaseUrl: string;
	/** Whisper API key */
	whisperApiKey: string;
	/** Whisper API model id */
	whisperApiModel: string;
	/** Deepgram API base URL */
	deepgramBaseUrl: string;
	/** Deepgram API key */
	deepgramApiKey: string;
	/** Deepgram model id */
	deepgramModel: string;
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
	/** Custom instruction for the 'custom' task */
	llmCustomInstruction: string;
	/** LLM provider: OpenAI-compatible or Anthropic */
	llmProvider: LlmProviderId;
	/** LLM base URL */
	llmBaseUrl: string;
	/** LLM API key */
	llmApiKey: string;
	/** LLM model id */
	llmModel: string;
	/** Maximum output tokens for LLM post-processing */
	llmMaxTokens: number;
}

/** Transcription engine identifier. */
export type TranscriptionProviderId =
	| 'whisper-api'
	| 'local-whisper'
	| 'deepgram';

/** Display labels for each transcription engine (single source for UI). */
export const TRANSCRIPTION_PROVIDER_LABELS: Record<
	TranscriptionProviderId,
	string
> = {
	'whisper-api': 'Whisper API (OpenAI-compatible)',
	deepgram: 'Deepgram',
	'local-whisper': 'Local whisper.cpp (desktop)',
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

/** LLM post-processing provider identifier. */
export type LlmProviderId = 'openai-compatible' | 'anthropic';

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
	transcriptionProvider: 'whisper-api',
	transcriptionLanguage: 'auto',
	transcriptionDiarize: false,
	transcriptionWordTimestamps: false,
	transcriptionChunkMb: DEFAULT_TRANSCRIBE_CHUNK_MB,
	whisperApiBaseUrl: DEFAULT_WHISPER_API_BASE_URL,
	whisperApiKey: '',
	whisperApiModel: DEFAULT_WHISPER_API_MODEL,
	deepgramBaseUrl: DEFAULT_DEEPGRAM_BASE_URL,
	deepgramApiKey: '',
	deepgramModel: DEFAULT_DEEPGRAM_MODEL,
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
	llmCustomInstruction: '',
	llmProvider: 'openai-compatible',
	llmBaseUrl: DEFAULT_LLM_OPENAI_BASE_URL,
	llmApiKey: '',
	llmModel: DEFAULT_LLM_OPENAI_MODEL,
	llmMaxTokens: DEFAULT_LLM_MAX_TOKENS,
};

/**
 * Base URLs that ship as provider defaults. Auto-switching only replaces a
 * value still equal to one of these, so a custom endpoint the user typed is
 * never clobbered when the provider changes.
 */
const DEFAULT_LLM_BASE_URLS: ReadonlySet<string> = new Set([
	DEFAULT_LLM_OPENAI_BASE_URL,
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_OLLAMA_BASE_URL,
]);

/** Model ids that ship as provider defaults (same auto-switch guard). */
const DEFAULT_LLM_MODELS: ReadonlySet<string> = new Set([
	DEFAULT_LLM_OPENAI_MODEL,
	DEFAULT_LLM_ANTHROPIC_MODEL,
]);

/**
 * Aligns the LLM base URL and model with the target provider's defaults when
 * the current values are still provider defaults; a custom URL or model the
 * user entered is preserved. Mutates and returns `settings` so the settings
 * tab can switch the dependent fields in one step when the provider changes.
 * @param settings - Settings to adjust in place
 * @param provider - The provider being switched to
 * @returns The same settings object, adjusted
 */
export function applyLlmProviderDefaults(
	settings: AudioRecorderSettings,
	provider: LlmProviderId,
): AudioRecorderSettings {
	if (provider === 'anthropic') {
		if (DEFAULT_LLM_BASE_URLS.has(settings.llmBaseUrl)) {
			settings.llmBaseUrl = DEFAULT_LLM_ANTHROPIC_BASE_URL;
		}
		if (DEFAULT_LLM_MODELS.has(settings.llmModel)) {
			settings.llmModel = DEFAULT_LLM_ANTHROPIC_MODEL;
		}
		return settings;
	}
	// OpenAI-compatible (OpenAI / Groq / Ollama): only move off the Anthropic
	// defaults, leaving any other OpenAI-compatible endpoint or model intact.
	if (settings.llmBaseUrl === DEFAULT_LLM_ANTHROPIC_BASE_URL) {
		settings.llmBaseUrl = DEFAULT_LLM_OPENAI_BASE_URL;
	}
	if (settings.llmModel === DEFAULT_LLM_ANTHROPIC_MODEL) {
		settings.llmModel = DEFAULT_LLM_OPENAI_MODEL;
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
	return {
		...DEFAULT_SETTINGS,
		...userSettings,
		trackAudioSources: normalizeTrackAudioSources(
			userSettings.trackAudioSources,
		),
	};
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

/**
 * Render-ready view of the enhanced player's two user-toggleable windows.
 * Every other player element (speed, skip, volume, mute, loop, time display,
 * timecode links, marker list, chapter navigation) is fixed and rendered
 * unconditionally from constants, so this only carries the two toggles that
 * actually vary. Player settings are deliberately kept off validateSettings:
 * they are unrelated to recording and must never throw on the recording path.
 */
export interface ResolvedPlayerSettings {
	/** Draw the waveform behind the seek bar; false renders the plain bar. */
	showWaveform: boolean;
	/** Show the markers and chapters window (list, ticks, edit controls). */
	enableMarkers: boolean;
}

/**
 * Builds the render-ready player layout from the two window toggles.
 * @param settings - Current plugin settings
 * @returns Render-ready player settings
 */
export function resolvePlayerSettings(
	settings: AudioRecorderSettings,
): ResolvedPlayerSettings {
	return {
		showWaveform: settings.playerShowWaveform,
		enableMarkers: settings.playerEnableMarkers,
	};
}

/**
 * Whether two resolved player layouts are identical. A settings save that
 * does not change either window toggle re-applies nothing to live players,
 * so an unrelated setting change never rebuilds an open player.
 * @param a - One resolved layout
 * @param b - Another resolved layout
 * @returns True when both toggles match
 */
export function playerSettingsEqual(
	a: ResolvedPlayerSettings,
	b: ResolvedPlayerSettings,
): boolean {
	return (
		a.showWaveform === b.showWaveform && a.enableMarkers === b.enableMarkers
	);
}
