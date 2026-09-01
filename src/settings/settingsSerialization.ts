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
	ENGINES,
	ENGINE_IDS,
	accountOf,
	engineOfVendor,
	transcribingAccount,
	type EngineDescriptor,
} from '../providers/providers';
import { reconcileEngineSettings } from '../providers/engineSettings';
import {
	MIN_TRACK_GAIN_DB,
	MAX_TRACK_GAIN_DB,
	DEEPGRAM_MODEL_SUGGESTIONS,
	GEMINI_MODEL_SUGGESTIONS,
	LLM_ANTHROPIC_MODEL_SUGGESTIONS,
	LLM_OPENAI_MODEL_SUGGESTIONS,
	MODEL_SEED_GENERATION,
	PLUGIN_LOG_PREFIX,
	WHISPER_API_MODEL_SUGGESTIONS,
} from '../constants';
import {
	DEFAULT_SETTINGS,
	createPlatformScopedDefaults,
	type AudioRecorderSettings,
	type PrimitiveSettingKey,
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
import {
	createProfile,
	noSelectedProfiles,
	profilesOfKind,
	setSelectedProfileId,
	PROFILE_KIND_IDS,
	type Profile,
	type ProfileKindId,
} from './profiles';
import {
	formatParticipantBody,
	normalizeParticipantNames,
} from '../speakers/participantRoster';

/**
 * Coerces an untrusted number into a range, with the neutral 0 for anything
 * that is not a number at all. Both mix placements are absent in every
 * settings file written before they existed, and hand-editable in the rest.
 * @param value - Candidate value from storage
 * @param min - Lowest value accepted
 * @param max - Highest value accepted
 * @returns The value inside the range, or 0
 */
function clampNumber(value: unknown, min: number, max: number): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: 0;
}

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
				gainDb: 0,
				pan: 0,
			});
			continue;
		}
		if (value && typeof value === 'object' && 'deviceId' in value) {
			const { deviceId, channelMode } = value;
			const placement = value as { gainDb?: unknown; pan?: unknown };
			sources.set(trackNumber, {
				deviceId: typeof deviceId === 'string' ? deviceId : '',
				channelMode: normalizeChannelMode(channelMode),
				gainDb: clampNumber(
					placement.gainDb,
					MIN_TRACK_GAIN_DB,
					MAX_TRACK_GAIN_DB,
				),
				pan: clampNumber(placement.pan, -1, 1),
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
			gainDb: source.gainDb ?? 0,
			pan: source.pan ?? 0,
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
		// Spread over the defaults rather than replacing them: a config saved
		// before a kind existed names no selection for it, and the kind then
		// starts on the profile this version seeds for it rather than on none.
		selectedProfileIds: {
			...DEFAULT_SETTINGS.selectedProfileIds,
			...userSettings.selectedProfileIds,
		},
		audioDeviceId: active.audioDeviceId,
		recordingChannels: active.recordingChannels,
		// The active branch shares its Map with the flat field, so
		// in-place edits (settings tab track rows) land in the branch.
		trackAudioSources: active.trackAudioSources,
		perPlatform,
	};
	// Before the migrations, not after: the endpoint rule below asks which
	// account transcription is reached through, and an id no engine claims
	// answers "none", which reads as "nothing transcribes anywhere" and lets a
	// stored chat URL onto the very field the reconciliation is about to point
	// transcription back at. A field a migration resolves through a registry has
	// to name something by the time the migration asks.
	reconcileTranscriptionEngine(merged);
	migrateLegacyLlmSettings(merged, userSettings);
	migrateModelCatalogues(merged, userSettings);
	// The same rule that holds after an edit on an engine's page, applied to a
	// config that has just been read: every catalogue offers the id in use.
	reconcileEngineSettings(merged);
	// After the migration rather than before it: an unclaimed vendor id is what
	// tells the migration it does not know which engine the legacy key and model
	// belonged to, and answering it first would turn that into a guess that
	// writes one vendor's token into another vendor's field.
	reconcileLlmJobEngines(merged);
	// The profiles first, so everything downstream asks the unified list: the
	// flat dictionary migration below asks whether the config already has
	// glossaries, and the advanced gate asks the same question again.
	normalizeProfiles(merged);
	migrateLegacyProfileLists(merged, userSettings);
	migrateLegacyPrompts(merged, userSettings);
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
 * Points a field that names a registry entry at one that exists.
 *
 * Every such field is read from disk, which is not type-checked, and every
 * reader of one resolves it against a registry that has no entry for a value
 * nothing claims: the factory that builds a client, the ceiling that bounds an
 * answer, the cost model that prices a call. A hand-edited or downgraded
 * `data.json` would therefore fail deep inside a run rather than at the field
 * holding the bad value, so an unclaimed id is answered here, once, with the
 * value this version ships. Which registry the field names is the only thing
 * that differs between the jobs and transcription, so it is the only thing
 * passed in.
 * @param merged - The merged settings to reconcile in place
 * @param key - The field naming an entry
 * @param registry - The entries that field may name
 */
function reconcileRegistryId(
	merged: AudioRecorderSettings,
	key: PrimitiveSettingKey,
	registry: Readonly<Record<string, unknown>>,
): void {
	if (!((merged[key] as string) in registry)) {
		(merged as unknown as Record<string, unknown>)[key] =
			DEFAULT_SETTINGS[key];
	}
}

/**
 * Points every LLM-driven job at an engine that exists.
 * @param merged - The merged settings to reconcile in place
 */
function reconcileLlmJobEngines(merged: AudioRecorderSettings): void {
	for (const job of Object.values(LLM_JOBS)) {
		reconcileRegistryId(merged, job.key, LLM_VENDORS);
	}
}

/**
 * Points transcription at an engine that exists.
 * @param merged - The merged settings to reconcile in place
 */
function reconcileTranscriptionEngine(merged: AudioRecorderSettings): void {
	reconcileRegistryId(merged, 'transcriptionProvider', TRANSCRIPTION_ENGINES);
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
 * default. Runs after the profile migrations so a legacy-seeded profile
 * already shows up in `merged`.
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
	if (profilesOfKind(merged.profiles, 'dictionary').length > 0) {
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

/** One pre-unification profile list, and what it becomes. */
interface LegacyProfileList {
	/** Stored field the list lived in. */
	readonly key: string;
	/** Stored field its selection lived in. */
	readonly selectionKey: string;
	/** Kind the migrated profiles carry. */
	readonly kind: ProfileKindId;
	/** The entry's body, read from whatever field that kind used to name it. */
	readonly body: (entry: Record<string, unknown>) => string;
}

/**
 * Every profile list the schema used to keep apart, in the order their kinds
 * are declared. The list is what makes the migration one pass rather than one
 * function per kind, and a kind that was never stored separately (the
 * post-processing prompts) simply is not here.
 */
const LEGACY_PROFILE_LISTS: readonly LegacyProfileList[] = [
	{
		key: 'transcriptionSpeakerProfiles',
		selectionKey: 'transcriptionSpeakerProfileId',
		kind: 'participants',
		// The roster was stored parsed; a unified profile keeps the text the
		// editor shows, so it is written back one name per line.
		body: (entry) =>
			formatParticipantBody(
				normalizeParticipantNames(
					Array.isArray(entry.participants) ? entry.participants : [],
				),
			),
	},
	{
		key: 'transcriptionDictionaryProfiles',
		selectionKey: 'transcriptionDictionaryProfileId',
		kind: 'dictionary',
		body: (entry) => legacyString(entry.terms),
	},
	{
		key: 'transcriptionChapterPromptProfiles',
		selectionKey: 'transcriptionChapterPromptProfileId',
		kind: 'chapterPrompt',
		body: (entry) => legacyString(entry.prompt),
	},
];

/**
 * Every pre-profile post-processing prompt, and the kind that now holds it.
 */
const LEGACY_PROMPT_FIELDS: readonly {
	readonly key: string;
	readonly kind: ProfileKindId;
}[] = [
	{ key: 'llmCleanupPrompt', kind: 'llmCleanup' },
	{ key: 'llmSummaryPrompt', kind: 'llmSummary' },
	{ key: 'llmCustomInstruction', kind: 'llmCustom' },
];

/**
 * Reads one stored profile list into unified profiles, dropping entries a
 * hand-edited data.json left unusable (anything that is not a record with a
 * string id and name), since a profile with no id is one no selection can name
 * and no page can address.
 * @param stored - The raw value of the stored list
 * @param list - The list being read
 * @returns The profiles it converts to
 */
function convertLegacyProfiles(
	stored: unknown,
	list: LegacyProfileList,
): Profile[] {
	if (!Array.isArray(stored)) {
		return [];
	}
	const profiles: Profile[] = [];
	for (const entry of stored) {
		if (!isRecord(entry)) {
			continue;
		}
		const id = legacyString(entry.id);
		const name = legacyString(entry.name);
		if (id === '' || name === '') {
			continue;
		}
		profiles.push({ id, kind: list.kind, name, body: list.body(entry) });
	}
	return profiles;
}

/**
 * Carries the pre-unification profile lists into the single `profiles` list.
 *
 * Each kind used to be its own stored list of its own shape, so an upgrade
 * finds a config whose glossaries, rosters, and chapter prompts are in three
 * fields this version no longer reads. They move over keeping their ids - a
 * recording's sidecar names the participant profile it ran with, and every
 * selection is by id - and the profiles this version seeds for that kind step
 * aside, since the stored list is the user's own and already carries whatever
 * it kept of the old default.
 *
 * A config already holding a unified list is left alone: it was written by
 * this version or a later one, and its list is the authority.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateLegacyProfileLists(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
	const alreadyUnified = Array.isArray(stored.profiles);
	for (const list of LEGACY_PROFILE_LISTS) {
		if (!alreadyUnified && stored[list.key] !== undefined) {
			const converted = convertLegacyProfiles(stored[list.key], list);
			merged.profiles = [
				...merged.profiles.filter(
					(profile) => profile.kind !== list.kind,
				),
				...converted,
			];
			setSelectedProfileId(
				merged,
				list.kind,
				legacyString(stored[list.selectionKey]),
			);
		}
		// Dropped whether or not anything was carried over, so a later save
		// never writes the superseded field again.
		deleteLegacyField(merged, list.key);
		deleteLegacyField(merged, list.selectionKey);
	}
}

/**
 * Carries the pre-profile post-processing prompts into profiles of their own.
 *
 * Each task used to hold one editable prompt, and that text is what the user
 * tuned, so it becomes the body of the "Default" profile this version seeds
 * for the task rather than a second profile beside it: the same prompt keeps
 * running after the upgrade, and it is now one entry of a catalogue the user
 * can add to. A config that already carries profiles of the kind is left
 * alone.
 *
 * A stored prompt is carried over whatever it says, an empty one included:
 * emptying the field was how a user asked for the built-in behaviour of the
 * task (the neutral instruction, for the custom task), and a blank body still
 * asks for exactly that. Reading blank as "nothing stored" would hand them the
 * seeded prompt they had deliberately cleared.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateLegacyPrompts(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
	const alreadyUnified = Array.isArray(stored.profiles);
	for (const field of LEGACY_PROMPT_FIELDS) {
		const prompt: unknown = stored[field.key];
		if (!alreadyUnified && typeof prompt === 'string') {
			// The seeded default of the task is where the prompt belongs, and
			// a config from before the catalogues existed holds exactly that
			// one profile per task - the one the merged selection already
			// names, since it named nothing of its own.
			merged.profiles = merged.profiles.map((profile) =>
				profile.kind === field.kind
					? { ...profile, body: prompt }
					: profile,
			);
		}
		deleteLegacyField(merged, field.key);
	}
}

/**
 * Drops a superseded field from the merged settings, which spread the stored
 * data and so still carries it. Without this a save would write the field back
 * and the next load would migrate it again, over whatever the user has changed
 * since.
 * @param merged - The merged settings to strip
 * @param key - The superseded field
 */
function deleteLegacyField(merged: AudioRecorderSettings, key: string): void {
	delete (merged as unknown as Record<string, unknown>)[key];
}

/**
 * Carries a pre-profiles single dictionary string forward into one seeded
 * 'General' profile and selects it, then drops the flat field so a later save
 * does not re-persist it. The only-when-empty guard mirrors the LLM migration:
 * a config that already has dictionary profiles is left untouched. The delete
 * runs unconditionally, since even an empty legacy string must be stripped from
 * the merged object (which spread `...userSettings`) so serializeSettings never
 * writes it again. Runs after {@link migrateLegacyProfileLists}, so "already
 * has profiles" is asked of the unified list.
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
		profilesOfKind(merged.profiles, 'dictionary').length === 0
	) {
		// Keep the raw multi-line text; parsing happens at run time.
		const profile = createProfile('dictionary', 'General', legacyTerms);
		merged.profiles = [...merged.profiles, profile];
		setSelectedProfileId(merged, 'dictionary', profile.id);
	}
	deleteLegacyField(merged, 'transcriptionDictionary');
}

/**
 * Reads the stored profiles and selections back into the shapes the plugin
 * addresses, dropping what a hand-edited data.json left unusable: an entry
 * that is not a record, one missing an id, a name, or a body, and one carrying
 * a kind this version does not know. A selection is kept as text whatever it
 * names, since an id naming no profile already reads as "none" everywhere.
 * @param merged - The merged settings to normalize in place
 */
function normalizeProfiles(merged: AudioRecorderSettings): void {
	const stored: unknown = merged.profiles;
	const kinds = new Set<string>(PROFILE_KIND_IDS);
	merged.profiles = (Array.isArray(stored) ? stored : []).flatMap(
		(entry: unknown) => {
			if (!isRecord(entry) || !kinds.has(legacyString(entry.kind))) {
				return [];
			}
			const id = legacyString(entry.id);
			const name = legacyString(entry.name);
			if (id === '' || name === '') {
				return [];
			}
			return [
				{
					id,
					kind: entry.kind as ProfileKindId,
					name,
					body: legacyString(entry.body),
				},
			];
		},
	);
	// Always an object, whatever data.json held: the merge builds it by
	// spreading the stored value over the defaults. Only its values still come
	// from disk unchecked, which is what the cast says and legacyString answers.
	const selections = merged.selectedProfileIds as unknown as Record<
		string,
		unknown
	>;
	const normalized = noSelectedProfiles();
	for (const kind of PROFILE_KIND_IDS) {
		normalized[kind] = legacyString(selections[kind]);
	}
	merged.selectedProfileIds = normalized;
}

/**
 * Whether an engine's endpoint answers for prompts alone, as configured.
 *
 * An endpoint belongs to the account, and an account is shared by every engine
 * behind it, so a stored chat URL must not be written onto one transcription
 * reads: it would send every transcription request to a host that serves no
 * audio endpoint at all.
 *
 * The question is whether transcription reads it, not whether it could. An
 * account whose speech engine nobody selected serves prompts and nothing else
 * in this configuration, and refusing the value there loses the only endpoint
 * it was ever the answer for. That is not hypothetical: a provider blocked in
 * the user's country is reached through a relay, entered in the one field the
 * old schema had, and dropping it silently took away the address that worked
 * and left the run pointed at a host that answers nobody there.
 * @param engine - The engine the legacy endpoint would be written to
 * @param settings - The merged settings, read for the engine transcription uses
 */
function endpointIsChatOnly(
	engine: EngineDescriptor,
	settings: AudioRecorderSettings,
): boolean {
	return (
		engine.account !== null &&
		engine.account !== transcribingAccount(settings)
	);
}

/**
 * Adds ids to an engine's catalogue, keeping the saved order and dropping
 * repeats. A model that was in use stays pickable whatever else the migration
 * decides about it.
 * @param merged - The merged settings to migrate in place
 * @param engine - The engine whose catalogue is being topped up
 * @param ids - The ids to offer
 */
function offerModels(
	merged: AudioRecorderSettings,
	engine: EngineDescriptor,
	ids: readonly string[],
): void {
	const models = engine.models;
	const fresh = ids.filter((id) => id !== '');
	if (!models || fresh.length === 0) {
		return;
	}
	models.setModels(merged, [
		...new Set([...models.models(merged), ...fresh]),
	]);
}

/**
 * Carries a superseded chat model onto the engine that serves it now.
 *
 * The id always joins the catalogue, so a model that was in use stays pickable.
 * Whether it also becomes the id in use turns on who else reads that catalogue.
 * A catalogue belongs to the engine rather than to the account, so two engines
 * over one account keep one each and the OpenAI chat ids are nothing to do with
 * the Whisper ones; but an engine that both transcribes and writes serves one
 * catalogue for both jobs, which is Gemini. There, a stored chat model is not
 * an answer for the field, and holding the shipped default is no sign it is
 * unused - a user transcribing on the default model has simply never changed
 * it. Writing the chat id would silently move what transcription runs on, and
 * what it costs.
 * @param merged - The merged settings to migrate in place
 * @param engine - The engine the legacy model belongs to now
 * @param legacyModel - The stored chat model, or '' when none was saved
 */
function adoptLegacyChatModel(
	merged: AudioRecorderSettings,
	engine: EngineDescriptor,
	legacyModel: string,
): void {
	offerModels(merged, engine, [legacyModel]);
	const models = engine.models;
	if (
		legacyModel === '' ||
		!models ||
		engine.transcriptionId !== null ||
		!isShippedDefault(merged, models.modelKey)
	) {
		return;
	}
	models.setModel(merged, legacyModel);
}

/**
 * Carries forward settings saved under the pre-rework LLM schema. The old
 * single `llmApiKey` maps onto the key of the account the stored vendor is
 * reached through, and the old single `llmModel` and `llmBaseUrl` onto that
 * engine's catalogue and endpoint. The superseded flat fields are then dropped
 * so a later save does not persist them. A vendor key already set is never
 * overwritten, so the migration cannot clobber a freshly entered token.
 * @param merged - The merged settings to migrate in place
 * @param raw - The raw user settings as loaded from disk
 */
function migrateLegacyLlmSettings(
	merged: AudioRecorderSettings,
	raw: AudioRecorderSettingsInput,
): void {
	// The stored vendor decides which engine the legacy values map onto. A
	// corrupted vendor id (disk data is not type-checked) names none, so skip
	// the mapping rather than dereference an absent descriptor; the superseded
	// flat fields are still dropped below.
	const engine = engineOfVendor(merged.llmProvider);
	if (engine) {
		const account = accountOf(engine);
		const legacyKey = legacyString(raw.llmApiKey);
		// A key already set is never overwritten, so the migration cannot
		// clobber a freshly entered token.
		if (account && legacyKey && !account.apiKey(merged)) {
			account.setApiKey(merged, legacyKey);
		}
		adoptLegacyChatModel(merged, engine, legacyString(raw.llmModel).trim());
		// The endpoint was one field rewritten on every vendor change; it now
		// belongs to the account the stored vendor is reached through. A chat
		// URL and a Whisper URL were independent fields, and plenty of
		// configurations used that - OpenAI transcription against the default
		// endpoint with post-processing pointed at a local OpenAI-compatible
		// chat server, say. Writing the chat URL onto the shared field would
		// move transcription to a host that serves no audio endpoint at all.
		const legacyBaseUrl = legacyString(raw.llmBaseUrl).trim();
		if (account && legacyBaseUrl) {
			if (
				endpointIsChatOnly(engine, merged) &&
				isShippedDefault(merged, account.baseUrlKey)
			) {
				account.setBaseUrl(merged, legacyBaseUrl);
			} else {
				// Not applied, but not disappeared without a word either: the
				// value is the only record of an endpoint the user entered, and
				// the field it would land on is now shared, so where it cannot
				// be carried it is at least recoverable from the log.
				console.warn(
					`${PLUGIN_LOG_PREFIX} The stored LLM endpoint "${legacyBaseUrl}" was not carried over: ${account.baseUrlKey} is the endpoint transcription reads. Enter it under Engines if post-processing needs it.`,
				);
			}
		}
	}
	// Gemini kept a chat catalogue beside its transcription one, over the same
	// account and the same family of ids. They merge into the engine's own
	// catalogue, whichever vendor was selected, because the ids were saved
	// whether or not Gemini was the one answering prompts.
	const gemini = ENGINES[ENGINE_IDS.GEMINI];
	offerModels(
		merged,
		gemini,
		Array.isArray(raw.llmGeminiModels)
			? raw.llmGeminiModels.filter(
					(id): id is string => typeof id === 'string',
				)
			: [],
	);
	adoptLegacyChatModel(
		merged,
		gemini,
		legacyString(raw.llmGeminiModel).trim(),
	);
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
