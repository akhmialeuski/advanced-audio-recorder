/**
 * Settings persistence: serialization to disk shape, merging stored values
 * with defaults, and migration of superseded schema versions (flat LLM
 * fields, flat platform-scoped device fields).
 * @module settings/settingsSerialization
 */

import { normalizeChannelMode } from '../audio/downmix';
import { isRecord } from '../utils/objects';
import { getDefaultDeviceId } from '../utils/DeviceUtils';
import { getPlatformKind, type PlatformKind } from '../platform/platformKind';
import { isDeviceSelectionSupported } from '../platform/capabilities';
import { LLM_JOBS, LLM_VENDORS } from '../transcription/llm/vendors';
import { TRANSCRIPTION_ENGINES } from '../transcription/providers/engines';
import {
	accountTranscribes,
	engineOfVendor,
	vendorConnection,
} from '../providers/providers';
import { reconcileEngineSettings } from '../providers/engineSettings';
import {
	DEEPGRAM_MODEL_SUGGESTIONS,
	GEMINI_MODEL_SUGGESTIONS,
	LLM_ANTHROPIC_MODEL_SUGGESTIONS,
	LLM_OPENAI_MODEL_SUGGESTIONS,
	MODEL_SEED_GENERATION,
	WHISPER_API_MODEL_SUGGESTIONS,
} from '../constants';
import {
	DEFAULT_SETTINGS,
	createPlatformScopedDefaults,
	type AudioRecorderSettings,
	type PrimitiveSettingKey,
	type AudioRecorderSettingsInput,
	type AudioSource,
	type DictionaryProfile,
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
function normalizeTrackAudioSources(
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
	migrateModelCatalogues(merged, userSettings);
	// The same rule that holds after an edit on an engine's page, applied to a
	// config that has just been read: every catalogue offers the id in use.
	reconcileEngineSettings(merged);
	reconcileLlmJobEngines(merged);
	reconcileTranscriptionEngine(merged);
	migrateLegacyTranscriptionDictionary(merged, userSettings);
	migrateAdvancedDictionaryGate(merged, userSettings);
	return merged;
}

/**
 * Whether a setting still holds the value this version ships for it.
 *
 * A superseded field is carried onto the field that replaced it only while that
 * field has not been set: overwriting a value the user chose would answer a
 * migration question with the old configuration's answer. The rule is one rule,
 * so it is written once here rather than restated at each field it guards.
 * @param settings - The merged settings being migrated
 * @param key - The field the legacy value would be written to
 * @returns Whether the field is untouched
 */
function isShippedDefault(
	settings: AudioRecorderSettings,
	key: PrimitiveSettingKey,
): boolean {
	return settings[key] === DEFAULT_SETTINGS[key];
}

/**
 * Points every LLM-driven job at an engine that exists.
 *
 * The three fields naming a job's engine are read from disk, which is not
 * type-checked, and every reader of one - the factory that builds the client,
 * the ceiling that bounds the answer, the cost model that prices the call -
 * looks the id up in a registry that has no entry for a value no vendor claims.
 * A hand-edited or downgraded `data.json` would therefore fail inside the
 * transcribe dialog rather than at the field that holds the bad value, so an
 * unclaimed id is answered here, once, with the value this version ships.
 * @param merged - The merged settings to reconcile in place
 */
function reconcileLlmJobEngines(merged: AudioRecorderSettings): void {
	for (const job of Object.values(LLM_JOBS)) {
		const key = job.key;
		if (!((merged[key] as string) in LLM_VENDORS)) {
			(merged as unknown as Record<string, unknown>)[key] =
				DEFAULT_SETTINGS[key];
		}
	}
}

/**
 * Points transcription at an engine that exists, for the reason
 * {@link reconcileLlmJobEngines} does: the id is read from disk and every
 * reader resolves it against a registry with no entry for an unclaimed one.
 * @param merged - The merged settings to reconcile in place
 */
function reconcileTranscriptionEngine(merged: AudioRecorderSettings): void {
	if (!(merged.transcriptionProvider in TRANSCRIPTION_ENGINES)) {
		merged.transcriptionProvider = DEFAULT_SETTINGS.transcriptionProvider;
	}
}

/**
 * Enables the advanced-settings master switch for configs that already had the
 * dictionary in use before the switch existed. The switch is new and gates the
 * dictionary term biasing, so on upgrade a stored config that selected a
 * profile (or held a legacy flat dictionary, now migrated into one) would
 * otherwise merge to the `false` default and silently stop biasing, its editor
 * hidden. When the flag is absent from the stored data and any dictionary
 * profile is present, turn it on to preserve the pre-upgrade behavior. A
 * pristine config (no profiles, flag absent) stays `false`, the fresh-install
 * default. Runs after {@link migrateLegacyTranscriptionDictionary} so a
 * legacy-seeded profile already shows up in `merged`.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateAdvancedDictionaryGate(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const legacy: Record<string, unknown> = isRecord(raw) ? raw : {};
	// Only a config saved before the switch existed lacks the flag; a config
	// that already stored it (on or off) reflects a deliberate choice.
	if (legacy.transcriptionAdvancedSettingsEnabled !== undefined) {
		return;
	}
	if (merged.transcriptionDictionaryProfiles.length > 0) {
		merged.transcriptionAdvancedSettingsEnabled = true;
	}
}

/**
 * Reads a legacy string field from the raw disk data, which is not
 * type-checked: a hand-edited or corrupted data.json can hold a non-string
 * where the old schema expected text, and reading it as a string would throw on
 * the next `.trim()` and, through the load-time fallback, reset every setting to
 * its default. A non-string legacy value is treated as absent.
 * @param value - The raw field value as loaded from disk
 * @returns The value when it is a string, otherwise ''
 */
function legacyString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * Carries a pre-profiles single dictionary string forward into one seeded
 * 'General' profile and selects it, then drops the flat field so a later save
 * does not re-persist it. The only-when-empty guard mirrors the LLM migration:
 * a config that already has profiles is left untouched. The delete runs
 * unconditionally, since even an empty legacy string must be stripped from the
 * merged object (which spread `...userSettings`) so serializeSettings never
 * writes it again.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateLegacyTranscriptionDictionary(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const legacyTerms = legacyString(raw.transcriptionDictionary);
	if (
		legacyTerms.trim() !== '' &&
		merged.transcriptionDictionaryProfiles.length === 0
	) {
		const profile: DictionaryProfile = {
			id: crypto.randomUUID(),
			name: 'General',
			// Keep the raw multi-line text; parsing happens at run time.
			terms: legacyTerms,
		};
		merged.transcriptionDictionaryProfiles = [profile];
		merged.transcriptionDictionaryProfileId = profile.id;
	}
	if (isRecord(merged)) {
		delete merged.transcriptionDictionary;
	}
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
	const legacyKey = legacyString(raw.llmApiKey);
	const legacyModel = legacyString(raw.llmModel).trim();
	// The stored provider decides which fields the legacy key and model map
	// onto. A corrupted provider id (disk data is not type-checked) names no
	// vendor, so skip the mapping rather than dereference an absent descriptor;
	// the superseded flat fields are still dropped below.
	if (merged.llmProvider in LLM_VENDORS) {
		// Which fields hold the stored provider's key and model is a fact of
		// the provider, so both halves are asked of the registry rather than
		// re-derived here.
		const account = vendorConnection(merged.llmProvider);
		// A key already set is never overwritten, so the migration cannot
		// clobber a freshly entered token.
		if (legacyKey && !account.apiKey(merged)) {
			account.setApiKey(merged, legacyKey);
		}
		// The catalogue this vendor picks from is, for a provider that also
		// transcribes, the catalogue transcription picks from as well. Adopting
		// the legacy chat model unconditionally would therefore replace the id
		// a user chose to transcribe with, so it applies on the same terms as
		// every other superseded value: only while nothing was chosen.
		const models = engineOfVendor(merged.llmProvider)?.models;
		if (
			legacyModel &&
			models &&
			isShippedDefault(merged, models.modelKey)
		) {
			models.setModel(merged, legacyModel);
		}
	}
	// The endpoint was one field rewritten on every vendor change; it now
	// belongs to the provider the stored vendor is a capability of. Two things
	// have to hold before it is carried over, and holding the shipped default
	// is only the first: a field the user set is not overwritten.
	//
	// The second is that the endpoint must not also be a transcription one.
	// A chat URL and a Whisper URL were independent fields, and plenty of
	// configurations used that - OpenAI transcription against the default
	// endpoint with post-processing pointed at a local OpenAI-compatible chat
	// server, say. Writing the chat URL onto the shared field would move
	// transcription to a host that serves no audio endpoint at all, and the
	// address it used to run against would be gone from the config. So where
	// the account also transcribes, the legacy value is dropped rather than
	// applied to a field it was never the answer for.
	const legacyBaseUrl = legacyString(raw.llmBaseUrl).trim();
	if (legacyBaseUrl && merged.llmProvider in LLM_VENDORS) {
		const account = engineOfVendor(merged.llmProvider)?.account;
		const connection = vendorConnection(merged.llmProvider);
		if (
			account &&
			!accountTranscribes(account) &&
			isShippedDefault(merged, connection.baseUrlKey)
		) {
			connection.setBaseUrl(merged, legacyBaseUrl);
		}
	}
	// Gemini kept a chat catalogue beside its transcription one, over the same
	// account and the same family of ids. They merge into the engine's own
	// catalogue: the saved ids join it, and a chat model that was picked wins
	// only where the engine still holds its shipped default.
	const legacyGeminiModels = Array.isArray(raw.llmGeminiModels)
		? raw.llmGeminiModels.filter(
				(id): id is string => typeof id === 'string',
			)
		: [];
	if (legacyGeminiModels.length > 0) {
		merged.geminiModels = [
			...new Set([...merged.geminiModels, ...legacyGeminiModels]),
		];
	}
	const legacyGeminiModel = legacyString(raw.llmGeminiModel).trim();
	if (legacyGeminiModel && isShippedDefault(merged, 'geminiModel')) {
		merged.geminiModel = legacyGeminiModel;
	}
	// Chapters and the two-pass agents used to call whichever engine
	// post-processing named. They pick their own now, and a stored config keeps
	// the behaviour it had by starting all three on the engine it named.
	if (raw.chaptersLlmProvider === undefined) {
		merged.chaptersLlmProvider = merged.llmProvider;
	}
	if (raw.advancedLlmProvider === undefined) {
		merged.advancedLlmProvider = merged.llmProvider;
	}
	// The answer ceiling was one field for whichever engine was selected; every
	// engine that writes now holds its own, and each starts at that bound.
	const legacyMaxTokens = raw.llmMaxTokens;
	if (typeof legacyMaxTokens === 'number' && legacyMaxTokens > 0) {
		merged.llmOpenAiMaxTokens = legacyMaxTokens;
		merged.llmAnthropicMaxTokens = legacyMaxTokens;
		merged.geminiMaxTokens = legacyMaxTokens;
	}
	// Drop the superseded flat fields so a later save does not persist them.
	if (isRecord(merged)) {
		delete merged.llmApiKey;
		delete merged.llmModel;
		delete merged.llmBaseUrl;
		delete merged.llmGeminiModel;
		delete merged.llmGeminiModels;
		delete merged.llmMaxTokens;
	}
}

/**
 * Tops a saved model catalogue up with the ids this version ships, once per
 * seed generation. A catalogue is the user's to edit, so this runs only while
 * the stored generation is behind: an id deleted after the top-up stays
 * deleted, and one added by hand is never dropped.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateModelCatalogues(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const stored =
		typeof raw.modelSeedGeneration === 'number'
			? raw.modelSeedGeneration
			: 0;
	if (stored >= MODEL_SEED_GENERATION) {
		return;
	}
	const seeds: ReadonlyArray<[keyof AudioRecorderSettings, string[]]> = [
		['whisperApiModels', [...WHISPER_API_MODEL_SUGGESTIONS]],
		['deepgramModels', [...DEEPGRAM_MODEL_SUGGESTIONS]],
		['geminiModels', [...GEMINI_MODEL_SUGGESTIONS]],
		['llmOpenAiModels', [...LLM_OPENAI_MODEL_SUGGESTIONS]],
		['llmAnthropicModels', [...LLM_ANTHROPIC_MODEL_SUGGESTIONS]],
	];
	for (const [key, shipped] of seeds) {
		const saved = merged[key];
		if (!Array.isArray(saved)) {
			continue;
		}
		(merged as unknown as Record<string, string[]>)[key] = [
			...new Set([...(saved as string[]), ...shipped]),
		];
	}
	merged.modelSeedGeneration = MODEL_SEED_GENERATION;
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
