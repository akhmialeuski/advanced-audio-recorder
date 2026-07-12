/**
 * Settings persistence: serialization to disk shape, merging stored values
 * with defaults, and migration of superseded schema versions.
 * @module settings/settingsSerialization
 */

import { LLM_PROVIDER_IDS } from '../constants';
import { normalizeChannelMode } from '../audio/downmix';
import { isRecord } from '../utils/objects';
import { getDefaultDeviceId } from '../utils/DeviceUtils';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
	type AudioRecorderSettingsInput,
	type AudioSource,
	type SerializedAudioRecorderSettings,
	type SerializedAudioSource,
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
	// A hand-edited or future-version data.json may hold an unknown
	// channel mode; capture paths branch on it, so coerce it here once
	merged.recordingChannels = normalizeChannelMode(merged.recordingChannels);
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
