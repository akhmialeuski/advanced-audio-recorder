/**
 * Settings persistence: serialization to disk shape, merging stored values
 * with defaults, and migration of superseded schema versions (flat LLM
 * fields, flat platform-scoped device fields).
 * @module settings/settingsSerialization
 */

import { LLM_PROVIDER_IDS } from '../constants';
import { normalizeChannelMode } from '../audio/downmix';
import { isRecord } from '../utils/objects';
import { getDefaultDeviceId } from '../utils/DeviceUtils';
import { getPlatformKind, type PlatformKind } from '../platform/platformKind';
import { isDeviceSelectionSupported } from '../platform/capabilities';
import {
	DEFAULT_SETTINGS,
	createPlatformScopedDefaults,
	type AudioRecorderSettings,
	type AudioRecorderSettingsInput,
	type AudioSource,
	type PlatformScopedSettings,
	type PlatformScopedSettingsInput,
	type PlatformScopedSettingsMap,
	type SerializedAudioRecorderSettings,
	type SerializedAudioSource,
	type SerializedPlatformScopedSettings,
	type TrackAudioSources,
	type TrackAudioSourcesRecord,
} from './settingsSchema';

/**
 * Normalizes track audio sources into a Map. Accepts the current
 * object form, the bare device-id string older versions persisted,
 * and Map values that predate the channel mode field; every entry
 * comes out with a valid channel mode.
 */
export function normalizeTrackAudioSources(
	trackAudioSources?: TrackAudioSources | TrackAudioSourcesRecord,
): TrackAudioSources {
	if (!trackAudioSources) {
		return new Map();
	}

	const sources = new Map<number, AudioSource>();
	const entries =
		trackAudioSources instanceof Map
			? trackAudioSources.entries()
			: Object.entries(trackAudioSources);
	for (const [key, value] of entries) {
		const trackNumber = Number(key);
		if (Number.isNaN(trackNumber)) {
			continue;
		}
		if (typeof value === 'string') {
			// Pre-channel-mode persisted shape: a bare device id
			sources.set(trackNumber, {
				deviceId: value,
				channelMode: normalizeChannelMode(undefined),
			});
			continue;
		}
		if (value && typeof value === 'object' && 'deviceId' in value) {
			const { deviceId, channelMode } = value;
			sources.set(trackNumber, {
				deviceId: typeof deviceId === 'string' ? deviceId : '',
				channelMode: normalizeChannelMode(channelMode),
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
): Record<number, SerializedAudioSource> {
	const serialized: Record<number, SerializedAudioSource> = {};
	for (const [trackNumber, source] of trackAudioSources.entries()) {
		serialized[trackNumber] = {
			deviceId: source.deviceId,
			channelMode: source.channelMode,
		};
	}
	return serialized;
}

/**
 * Normalizes one platform-scoped branch as read from storage. Every
 * field is optional and possibly hand-edited; missing values fall back
 * to the scoped defaults.
 * @param input - Raw branch from storage, or undefined when absent
 * @returns A complete platform-scoped branch
 */
export function normalizePlatformScopedSettings(
	input?: PlatformScopedSettingsInput,
): PlatformScopedSettings {
	const defaults = createPlatformScopedDefaults();
	if (!isRecord(input)) {
		return defaults;
	}
	const branch = input as PlatformScopedSettingsInput;
	return {
		audioDeviceId:
			typeof branch.audioDeviceId === 'string'
				? branch.audioDeviceId
				: defaults.audioDeviceId,
		recordingChannels: normalizeChannelMode(branch.recordingChannels),
		trackAudioSources: normalizeTrackAudioSources(branch.trackAudioSources),
	};
}

/** Serializes one platform-scoped branch to its disk shape. */
function serializePlatformScopedSettings(
	branch: PlatformScopedSettings,
): SerializedPlatformScopedSettings {
	return {
		audioDeviceId: branch.audioDeviceId,
		recordingChannels: branch.recordingChannels,
		trackAudioSources: serializeTrackAudioSources(branch.trackAudioSources),
	};
}

/**
 * Builds the per-platform settings map from raw stored settings.
 *
 * Migration: settings saved before the per-platform split carried
 * `audioDeviceId`/`recordingChannels`/`trackAudioSources` as flat fields.
 * The plugin was desktop-only then, so those values describe desktop
 * hardware and become the desktop branch. They fill in whenever the
 * stored map has no desktop branch of its own - also on mobile, so a
 * legacy config synced to a phone migrates to the same place instead of
 * leaking desktop device ids into the mobile branch. A branch already
 * present in the stored map always wins over the legacy flat fields.
 * @param raw - Raw settings as loaded from disk
 * @returns Complete per-platform map
 */
export function normalizePerPlatformSettings(
	raw: AudioRecorderSettingsInput,
): PlatformScopedSettingsMap {
	const stored = isRecord(raw.perPlatform) ? raw.perPlatform : undefined;
	const legacyDesktop: PlatformScopedSettingsInput = {
		audioDeviceId: raw.audioDeviceId,
		recordingChannels: raw.recordingChannels,
		trackAudioSources: raw.trackAudioSources,
	};
	return {
		desktop: normalizePlatformScopedSettings(
			stored?.desktop ?? legacyDesktop,
		),
		mobile: normalizePlatformScopedSettings(stored?.mobile),
	};
}

/**
 * Serializes settings for persistence. The active platform's flat
 * device fields are written back into its `perPlatform` branch, and the
 * flat legacy fields are dropped from the output so platform-scoped
 * values live in exactly one place on disk.
 * @param settings - Live settings to serialize
 * @param platformKind - Platform whose branch receives the active flat
 *   fields (defaults to the current platform)
 * @returns Disk-shaped settings
 */
export function serializeSettings(
	settings: AudioRecorderSettings,
	platformKind: PlatformKind = getPlatformKind(),
): SerializedAudioRecorderSettings {
	const {
		audioDeviceId,
		recordingChannels,
		trackAudioSources,
		perPlatform: storedPerPlatform,
		...rest
	} = settings;
	const perPlatform: PlatformScopedSettingsMap = {
		...storedPerPlatform,
		[platformKind]: {
			audioDeviceId,
			recordingChannels,
			trackAudioSources,
		},
	};
	return {
		...rest,
		perPlatform: {
			desktop: serializePlatformScopedSettings(perPlatform.desktop),
			mobile: serializePlatformScopedSettings(perPlatform.mobile),
		},
	};
}

/**
 * Merges user settings with defaults and resolves the active platform's
 * scoped branch into the flat runtime fields.
 * @param userSettings - Partial user settings
 * @param platformKind - Platform whose branch becomes active (defaults
 *   to the current platform)
 * @returns Complete settings object
 */
export function mergeSettings(
	userSettings: AudioRecorderSettingsInput = {},
	platformKind: PlatformKind = getPlatformKind(),
): AudioRecorderSettings {
	const perPlatform = normalizePerPlatformSettings(userSettings);
	const active = perPlatform[platformKind];
	const merged: AudioRecorderSettings = {
		...DEFAULT_SETTINGS,
		...userSettings,
		audioDeviceId: active.audioDeviceId,
		recordingChannels: active.recordingChannels,
		// The active branch shares its Map with the flat field, so
		// in-place edits (settings tab track rows) land in the branch.
		trackAudioSources: active.trackAudioSources,
		perPlatform,
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
	const legacy: Record<string, unknown> = isRecord(raw) ? raw : {};
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
	if (isRecord(merged)) {
		delete merged.llmApiKey;
		delete merged.llmModel;
	}
}

/**
 * Async version of mergeSettings that detects and sets the default audio device
 * if no device is configured. This should be called during plugin initialization
 * to ensure a default device is selected for first-time users. Skipped
 * entirely where device selection is unavailable (mobile): capture uses
 * the system default microphone there, and probing would put up a
 * microphone permission prompt at app start for nothing.
 * @param userSettings - Partial user settings from storage
 * @returns Complete settings object with default device if needed
 */
export async function mergeSettingsAsync(
	userSettings: AudioRecorderSettingsInput = {},
	platformKind: PlatformKind = getPlatformKind(),
): Promise<AudioRecorderSettings> {
	const merged = mergeSettings(userSettings, platformKind);

	// Auto-select default device if no device is configured
	if (
		isDeviceSelectionSupported(platformKind) &&
		(!merged.audioDeviceId || merged.audioDeviceId.trim() === '')
	) {
		const defaultDeviceId = await getDefaultDeviceId();
		if (defaultDeviceId) {
			merged.audioDeviceId = defaultDeviceId;
			merged.perPlatform[platformKind].audioDeviceId = defaultDeviceId;
		}
	}

	return merged;
}
