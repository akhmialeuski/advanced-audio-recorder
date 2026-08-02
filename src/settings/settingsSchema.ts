/**
 * Settings type surface and default values for the Audio Recorder plugin.
 * @module settings/settingsSchema
 */

import type { ConversionLinkAction, OutputMode } from '../types';
import {
	FORMAT_WEBM,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_BITRATE,
	DEFAULT_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
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
	DEFAULT_LLM_ANTHROPIC_BASE_URL,
	DEFAULT_LLM_OPENAI_MODEL,
	DEFAULT_LLM_ANTHROPIC_MODEL,
	DEFAULT_LLM_MAX_TOKENS,
	LLM_OPENAI_MODEL_SUGGESTIONS,
	LLM_ANTHROPIC_MODEL_SUGGESTIONS,
	DEFAULT_LLM_CLEANUP_PROMPT,
	DEFAULT_LLM_SUMMARY_PROMPT,
	DEFAULT_LLM_CUSTOM_INSTRUCTION,
	DEFAULT_CHAPTER_PROMPT,
	DEFAULT_CHAPTER_PROMPT_PROFILE_ID,
	DEFAULT_CLEANUP_HIGHPASS_HZ,
	DEFAULT_CLEANUP_GATE_THRESHOLD_DB,
	DEFAULT_CLEANUP_LEVELING_MAKEUP_DB,
	DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO,
} from '../constants';
import type {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import type { LlmTask } from '../transcription/llmPostProcess';
import { CHANNEL_MODE_SOURCE } from '../audio/downmix';
import type { ChannelMode } from '../audio/downmix';
import type { PlatformKind } from '../platform/platformKind';

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
	/**
	 * Channel layout for this track's capture: keep the device layout
	 * or reduce to mono (mix or one picked channel). Bound to the
	 * track's device because it describes that device's own channels;
	 * the settings UI disables the selection for known-mono devices.
	 */
	channelMode: ChannelMode;
}

/**
 * Track audio sources mapping (track number -> audio source).
 */
export type TrackAudioSources = Map<number, AudioSource>;

/**
 * Track audio sources as accepted from storage: the current object
 * form, or the bare device-id string older versions persisted. The
 * channel mode may be missing or invalid in hand-edited data; the
 * deserializer normalizes it.
 */
export type TrackAudioSourcesRecord = Record<
	number,
	string | { deviceId?: unknown; channelMode?: unknown }
>;

/**
 * Settings bound to the hardware of one platform. Device ids are
 * randomized per install and never match across devices, and the channel
 * layout describes the selected device's own inputs - syncing them
 * between a desktop and a phone through data.json would break recording
 * on both. Each platform therefore keeps its own branch under
 * {@link AudioRecorderSettings.perPlatform}; the flat fields of the same
 * name on {@link AudioRecorderSettings} hold the *active* platform's
 * values at runtime and are written back to that platform's branch when
 * settings are persisted.
 */
export interface PlatformScopedSettings {
	/** Selected audio device ID */
	audioDeviceId: string;
	/** Channel layout for single-track recordings */
	recordingChannels: ChannelMode;
	/** Audio source mapping for each track */
	trackAudioSources: TrackAudioSources;
}

/** One platform-scoped settings branch per platform. */
export type PlatformScopedSettingsMap = Record<
	PlatformKind,
	PlatformScopedSettings
>;

/**
 * A platform-scoped branch as accepted from storage: every field
 * optional and possibly hand-edited; the deserializer normalizes it.
 */
export interface PlatformScopedSettingsInput {
	audioDeviceId?: unknown;
	recordingChannels?: unknown;
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord | undefined;
}

/** A platform-scoped branch as persisted to disk. */
export interface SerializedPlatformScopedSettings {
	audioDeviceId: string;
	recordingChannels: ChannelMode;
	trackAudioSources: Record<number, SerializedAudioSource>;
}

/**
 * Creates a fresh default platform-scoped branch. A factory (not a
 * constant) because each branch owns a mutable Map.
 * @returns Default platform-scoped settings
 */
export function createPlatformScopedDefaults(): PlatformScopedSettings {
	return {
		audioDeviceId: '',
		recordingChannels: CHANNEL_MODE_SOURCE,
		trackAudioSources: new Map(),
	};
}

/**
 * Creates a fresh default per-platform settings map.
 * @returns Default branches for every platform
 */
function createPerPlatformDefaults(): PlatformScopedSettingsMap {
	return {
		desktop: createPlatformScopedDefaults(),
		mobile: createPlatformScopedDefaults(),
	};
}

/**
 * A named custom-dictionary glossary selectable per transcription run. Several
 * profiles let a user keep separate term lists for different meeting types
 * (standup, legal, medical) instead of one merged glossary that dilutes the bias.
 */
export interface DictionaryProfile {
	/** Stable id (crypto.randomUUID); selection persists by id, not by name. */
	id: string;
	/** Display name shown in the settings editor and the run dialog. */
	name: string;
	/** One term per line; parsed and biased exactly like the legacy field. */
	terms: string;
}

/**
 * A named chapter-splitting guidance prompt, selectable per case. Several
 * profiles let a user keep separate instructions for different recording types
 * (meeting by agenda, lecture by topic, interview by question) instead of one
 * prompt that fits none well. The guidance steers HOW the LLM divides the
 * recording; the strict JSON response contract lives in the fixed base prompt
 * and is never part of a profile, so a customized profile cannot break parsing.
 */
export interface ChapterPromptProfile {
	/** Stable id (crypto.randomUUID, or the seeded default's fixed id). */
	id: string;
	/** Display name shown in the settings editor and the profile picker. */
	name: string;
	/** Guidance text appended to the chapter system prompt. */
	prompt: string;
}

/**
 * A named roster of participant names, reused across recordings. A recurring
 * meeting with the same attendees is entered once and picked in the rename
 * dialog, whose speaker fields then suggest the profile's names. Managed from
 * the rename dialog, not the settings tab; stored here so it survives reloads.
 */
export interface SpeakerProfile {
	/** Stable id (crypto.randomUUID); selection persists by id, not by name. */
	id: string;
	/** Display name shown in the rename dialog's profile picker. */
	name: string;
	/** Participant names, one per entry, offered as rename suggestions. */
	participants: string[];
}

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
	/**
	 * Selected audio device ID of the *active* platform (see
	 * {@link PlatformScopedSettings}); persisted under `perPlatform`.
	 */
	audioDeviceId: string;
	/** Audio sample rate in Hz */
	sampleRate: number;
	/**
	 * Channel layout for single-track recordings: keep the device
	 * layout or reduce to mono by mixing or picking one input channel.
	 * The left/right picks target audio interfaces whose two mono
	 * inputs appear as one stereo device. Multi-track sessions ignore
	 * this - each track carries its own mode in trackAudioSources.
	 * Holds the *active* platform's value; persisted under `perPlatform`.
	 */
	recordingChannels: ChannelMode;
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
	/**
	 * Audio source mapping for each track of the *active* platform
	 * (shares its Map with the platform's `perPlatform` branch);
	 * persisted under `perPlatform`.
	 */
	trackAudioSources: TrackAudioSources;
	/**
	 * Platform-scoped settings branches. The active platform's branch is
	 * mirrored into the flat fields above; the other platform's branch is
	 * carried through load/save untouched, so a synced data.json never
	 * mixes device configuration between platforms.
	 */
	perPlatform: PlatformScopedSettingsMap;
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
	/**
	 * Show API cost estimates and the running session cost counter in the
	 * transcribe dialog (built-in approximate rates; cloud engines only).
	 */
	transcriptionShowCostEstimates: boolean;
	/** Transcription engine: Whisper API or local whisper.cpp */
	transcriptionProvider: TranscriptionProviderId;
	/** Language hint ('auto' to detect) */
	transcriptionLanguage: string;
	/** Request speaker diarization when the provider supports it */
	transcriptionDiarize: boolean;
	/** Request word-level timestamps when supported */
	transcriptionWordTimestamps: boolean;
	/**
	 * Master switch for the advanced transcription settings: the dictionary
	 * term biasing and the two-pass mode below it. Off by default, and while
	 * off a run transcribes in a single plain pass with no term biasing at all.
	 * Turning it on reveals the dictionary profiles and the two-pass toggle.
	 */
	transcriptionAdvancedSettingsEnabled: boolean;
	/** Named custom-dictionary profiles (add/edit/remove in the settings tab). */
	transcriptionDictionaryProfiles: DictionaryProfile[];
	/** Id of the profile applied to a run; '' means None (no biasing terms). */
	transcriptionDictionaryProfileId: string;
	/**
	 * Advanced two-pass transcription: the recording is transcribed twice,
	 * with LLM agents mining the first draft for the meeting's names, jargon,
	 * and English acronyms and biasing the second pass's decoding toward them,
	 * reusing the selected dictionary terms as candidates. Roughly doubles the
	 * engine cost and adds several LLM calls per file, so it is off by default
	 * and lives under the advanced settings master switch.
	 */
	transcriptionAdvancedEnabled: boolean;
	/**
	 * Length safeguard for the advanced mode: the biased second pass is kept
	 * only when its plain text is at least this fraction of the first
	 * pass's; shorter output means content was lost, so the run reverts to
	 * the baseline transcript.
	 */
	advancedSecondPassMinRatio: number;
	/** Whether the "Rename speakers" action and command are offered. */
	transcriptionSpeakerRenameEnabled: boolean;
	/**
	 * Whether the "Generate chapters from transcript" action and command
	 * are offered (LLM-derived chapters written to the player's markers).
	 */
	transcriptionAutoChaptersEnabled: boolean;
	/** Automatically generate chapters after each transcription run. */
	transcriptionAutoChaptersOnTranscribe: boolean;
	/**
	 * Named chapter-splitting guidance prompts (add/edit/remove in the settings
	 * tab). Seeded with one built-in default; the selected profile's guidance is
	 * appended to the fixed chapter base prompt at generation time.
	 */
	transcriptionChapterPromptProfiles: ChapterPromptProfile[];
	/**
	 * Id of the selected chapter guidance profile; '' means no extra guidance
	 * (the base prompt only). A stale id also resolves to no guidance.
	 */
	transcriptionChapterPromptProfileId: string;
	/**
	 * Participant-name profiles reused across recordings. Created and filled
	 * from the rename dialog rather than the settings tab.
	 */
	transcriptionSpeakerProfiles: SpeakerProfile[];
	/**
	 * Id of the participant profile a transcription run records into the
	 * recording's sidecar; '' means none. A stale id also resolves to none.
	 */
	transcriptionSpeakerProfileId: string;
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
	/**
	 * Anthropic endpoint and key. Every provider keeps its endpoint and its key
	 * in fields of its own, and a provider that both transcribes and answers
	 * prompts (OpenAI, Gemini) is reached through the one pair it already has;
	 * Anthropic only answers prompts, so this is where its pair lives.
	 */
	anthropicBaseUrl: string;
	anthropicApiKey: string;
	/** Selected OpenAI LLM model id */
	llmOpenAiModel: string;
	/** Known OpenAI LLM model ids offered in the picker (user-editable) */
	llmOpenAiModels: string[];
	/** Selected Anthropic LLM model id */
	llmAnthropicModel: string;
	/** Known Anthropic LLM model ids offered in the picker (user-editable) */
	llmAnthropicModels: string[];
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
	/**
	 * After saving a recording, check whether it is a stereo file with
	 * one silent channel (a single mic through a dual-input interface)
	 * and offer to convert it to mono.
	 */
	detectSilentChannelOnSave: boolean;
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

/** LLM post-processing provider identifier (derived from {@link LLM_PROVIDER_IDS}). */
export type LlmProviderId =
	(typeof LLM_PROVIDER_IDS)[keyof typeof LLM_PROVIDER_IDS];

/**
 * Fields the plugin no longer stores but still reads once when loading a
 * data.json written by an older version, so the value migrates onto its
 * replacement instead of being silently dropped. Declared here rather than
 * reached for through a `Record<string, unknown>` cast at each migration, so
 * the set of fields a load still understands is one list a reader can check
 * against - and removing one becomes a compile error at its migration.
 */
export interface LegacyAudioRecorderSettings {
	/**
	 * Pre-vendor-split single LLM key, moved onto the selected vendor's own key
	 * field (OpenAI reuses the Whisper key, Gemini its transcription key).
	 */
	llmApiKey?: string;
	/** Pre-vendor-split single LLM model, moved onto the vendor's model. */
	llmModel?: string;
	/** Pre-profile single dictionary text, moved into a "General" profile. */
	transcriptionDictionary?: string;
	/**
	 * Pre-registry single LLM endpoint, held for whichever vendor was selected
	 * and rewritten on every vendor change. Moved onto the endpoint of the
	 * provider that vendor belongs to, which is the one both its transcription
	 * and its post-processing now read.
	 */
	llmBaseUrl?: string;
	/**
	 * Pre-registry Gemini chat model and catalogue. Gemini serves one family of
	 * ids for transcription and for prompts alike, so the two lists were the
	 * same list twice; they merge into the engine's own catalogue.
	 */
	llmGeminiModel?: string;
	llmGeminiModels?: string[];
}

/**
 * Partial settings as accepted from storage or callers; track sources may
 * arrive as a Map or as the serialized record form, and the per-platform
 * branches may be missing entirely (legacy flat data.json) or partial.
 */
export interface AudioRecorderSettingsInput
	extends
		Partial<
			Omit<AudioRecorderSettings, 'trackAudioSources' | 'perPlatform'>
		>,
		LegacyAudioRecorderSettings {
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord;
	perPlatform?: Partial<Record<PlatformKind, PlatformScopedSettingsInput>>;
}

/**
 * One track source as persisted to disk. Older versions stored a bare
 * device-id string; the deserializer accepts both shapes.
 */
export interface SerializedAudioSource {
	deviceId: string;
	channelMode: ChannelMode;
}

/**
 * Settings shape as persisted to disk. Platform-scoped values live only
 * under `perPlatform` (their flat legacy counterparts are dropped so the
 * platforms can never clobber each other through a synced data.json);
 * track sources are flattened to records.
 */
export interface SerializedAudioRecorderSettings extends Omit<
	AudioRecorderSettings,
	'trackAudioSources' | 'audioDeviceId' | 'recordingChannels' | 'perPlatform'
> {
	perPlatform: Record<PlatformKind, SerializedPlatformScopedSettings>;
}

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
	recordingChannels: CHANNEL_MODE_SOURCE,
	bitrate: DEFAULT_BITRATE,
	enableMultiTrack: false,
	maxTracks: 2,
	outputMode: 'single',
	useSourceNamesForTracks: true,
	trackAudioSources: new Map(),
	perPlatform: createPerPlatformDefaults(),
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
	transcriptionShowCostEstimates: true,
	transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	transcriptionLanguage: 'auto',
	transcriptionDiarize: false,
	transcriptionWordTimestamps: false,
	transcriptionAdvancedSettingsEnabled: false,
	transcriptionDictionaryProfiles: [],
	transcriptionDictionaryProfileId: '',
	transcriptionAdvancedEnabled: false,
	advancedSecondPassMinRatio: DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO,
	transcriptionSpeakerRenameEnabled: false,
	transcriptionAutoChaptersEnabled: false,
	transcriptionAutoChaptersOnTranscribe: false,
	transcriptionChapterPromptProfiles: [
		{
			id: DEFAULT_CHAPTER_PROMPT_PROFILE_ID,
			name: 'Default',
			prompt: DEFAULT_CHAPTER_PROMPT,
		},
	],
	transcriptionChapterPromptProfileId: DEFAULT_CHAPTER_PROMPT_PROFILE_ID,
	transcriptionSpeakerProfiles: [],
	transcriptionSpeakerProfileId: '',
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
	anthropicBaseUrl: DEFAULT_LLM_ANTHROPIC_BASE_URL,
	anthropicApiKey: '',
	llmOpenAiModel: DEFAULT_LLM_OPENAI_MODEL,
	llmOpenAiModels: [...LLM_OPENAI_MODEL_SUGGESTIONS],
	llmAnthropicModel: DEFAULT_LLM_ANTHROPIC_MODEL,
	llmAnthropicModels: [...LLM_ANTHROPIC_MODEL_SUGGESTIONS],
	llmMaxTokens: DEFAULT_LLM_MAX_TOKENS,
	inputNoiseSuppression: true,
	inputEchoCancellation: true,
	inputAutoGainControl: true,
	showInputLevelMeter: true,
	detectSilentChannelOnSave: true,
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
 * Whether a run performs the advanced two-pass transcription: both the advanced
 * settings master switch and the two-pass toggle beneath it are on. The single
 * predicate every surface reads - the run itself, the settings-tab field
 * gating, and the cost estimate - so the "master gates the toggle" rule lives
 * in one place instead of being re-derived at each call site.
 * @param settings - The active settings
 * @returns True when the biased second pass runs
 */
export function advancedTwoPassEnabled(
	settings: Pick<
		AudioRecorderSettings,
		'transcriptionAdvancedSettingsEnabled' | 'transcriptionAdvancedEnabled'
	>,
): boolean {
	return (
		settings.transcriptionAdvancedSettingsEnabled &&
		settings.transcriptionAdvancedEnabled
	);
}

/**
 * Whether a run generates auto chapters right after transcribing: the feature
 * is enabled and its run-after toggle is on. The single predicate the run and
 * the cost estimate share, so the extra LLM call is priced wherever it fires.
 * @param settings - The active settings
 * @returns True when chapters are generated after the transcription
 */
export function autoChaptersAfterTranscribe(
	settings: Pick<
		AudioRecorderSettings,
		| 'transcriptionAutoChaptersEnabled'
		| 'transcriptionAutoChaptersOnTranscribe'
	>,
): boolean {
	return (
		settings.transcriptionAutoChaptersEnabled &&
		settings.transcriptionAutoChaptersOnTranscribe
	);
}
