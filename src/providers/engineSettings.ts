/**
 * How an engine's configuration is read and written.
 *
 * Every engine holds the same kinds of thing - an endpoint, a key, a catalogue
 * and the id picked out of it, an answer ceiling, an upload chunk size - and
 * {@link module:providers/providers} already says which settings fields each
 * one keeps them in. What was missing was the act of writing them: the settings
 * tab reached into the settings object by string key, the transcribe and
 * chapters dialogs each moved a model of their own, and the load path restored
 * the catalogue invariant a fourth time. Four writers, four chances to write
 * half of a change.
 *
 * There is one writer now. {@link applyEngineSettings} is the whole of it, and
 * every engine is written through it by naming itself, so no engine carries a
 * branch and none of them can drift: adding an engine to the registry is what
 * gives it its own configuration, its own catalogue edits, and its own save.
 * {@link engineSettingsStore} binds that function to one engine and one way of
 * persisting, which is what a caller holding an engine actually wants.
 * @module providers/engineSettings
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	addModelToList,
	ensureSelectedInList,
	normalizeModelId,
	removeModelFromList,
} from '../settings/modelList';
import {
	ENGINES,
	ENGINE_ORDER,
	accountOf,
	type EngineDescriptor,
	type EngineId,
} from './providers';

/**
 * A change to one engine's configuration. Every field is optional: a patch says
 * what moves, and what it does not name keeps the value it had.
 */
export interface EngineSettingsPatch {
	/** Endpoint of the account this engine is reached through. */
	readonly baseUrl?: string;
	/** Key of that account. */
	readonly apiKey?: string;
	/** The id put to work, which the catalogue is made to contain. */
	readonly model?: string;
	/** The catalogue itself, as the list of ids it offers. */
	readonly models?: readonly string[];
	/** Longest answer this engine may write. */
	readonly maxTokens?: number;
	/** Megabytes per chunk where this engine splits an upload. */
	readonly uploadChunkMb?: number;
}

/** One field of one engine's configuration. */
export type EngineSettingsFieldName = keyof EngineSettingsPatch;

/**
 * One engine's configuration as it currently stands.
 *
 * An engine that holds none of a thing answers with a value rather than by
 * leaving the field out, the way its descriptor does: no account is an empty
 * endpoint and an empty key, no catalogue is an empty list, and no ceiling is
 * zero. A reader can then ask any engine anything.
 */
export interface EngineSettingsView {
	readonly engine: EngineDescriptor;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
	readonly models: readonly string[];
	readonly maxTokens: number;
	readonly uploadChunkMb: number;
}

/** One engine's configuration, as it stands in the given settings. */
export function readEngineSettings(
	settings: AudioRecorderSettings,
	id: EngineId,
): EngineSettingsView {
	const engine = ENGINES[id];
	const account = accountOf(engine);
	const models = engine.models;
	return {
		engine,
		baseUrl: account ? account.baseUrl(settings) : '',
		apiKey: account ? account.apiKey(settings) : '',
		model: models ? models.model(settings) : '',
		models: models ? models.models(settings) : [],
		maxTokens: engine.maxTokens ? engine.maxTokens.get(settings) : 0,
		uploadChunkMb: engine.uploadChunk
			? engine.uploadChunk.get(settings)
			: 0,
	};
}

/**
 * Applies a change to one engine's configuration, in memory.
 *
 * The one place an engine's settings are written. Two rules hold whatever the
 * patch says, which is why they are here rather than at each caller. A field
 * the engine does not hold is not written: the local engine has no endpoint to
 * move and a speech engine no answer ceiling, and a patch naming one is a
 * caller asking a question this engine has no field for. And the catalogue and
 * its selection come out consistent - the id in use is always one the list
 * offers, and an emptied list leaves no id in use - because a selection outside
 * its list is one the user can neither see nor change.
 * @param settings - The settings to write into
 * @param id - The engine being configured
 * @param patch - What moves; anything unnamed keeps its value
 */
export function applyEngineSettings(
	settings: AudioRecorderSettings,
	id: EngineId,
	patch: EngineSettingsPatch,
): void {
	const engine = ENGINES[id];
	const account = accountOf(engine);
	if (account) {
		if (patch.baseUrl !== undefined) {
			account.setBaseUrl(settings, patch.baseUrl);
		}
		if (patch.apiKey !== undefined) {
			account.setApiKey(settings, patch.apiKey);
		}
	}
	if (engine.maxTokens && patch.maxTokens !== undefined) {
		engine.maxTokens.set(settings, patch.maxTokens);
	}
	if (engine.uploadChunk && patch.uploadChunkMb !== undefined) {
		engine.uploadChunk.set(settings, patch.uploadChunkMb);
	}
	const models = engine.models;
	if (!models) {
		return;
	}
	if (patch.models !== undefined) {
		models.setModels(settings, [...patch.models]);
	}
	if (patch.model !== undefined) {
		models.setModel(settings, patch.model);
	}
	// Always, not only when the patch touched the catalogue: the invariant is
	// what the catalogue means, and it is restored on a config loaded from disk
	// the same way it is after an edit.
	const selected = normalizeModelId(models.model(settings));
	const saved = models.models(settings);
	if (selected === '') {
		// Nothing picked: a run needs an id, and the catalogue's first entry is
		// the one the list itself offers first.
		models.setModel(settings, saved[0] ?? '');
		return;
	}
	models.setModels(settings, ensureSelectedInList(saved, selected));
	models.setModel(settings, selected);
}

/**
 * Restores the catalogue invariant of every engine, which is what a config read
 * from disk needs before anything reads it.
 *
 * A hand-edited `data.json`, a config synced from a device whose list differs,
 * or a legacy field migrated onto a catalogue that never listed it all produce
 * a selection outside its list without any bug of their own. Expressed as the
 * empty change, so the rule that holds after an edit is literally the rule that
 * holds after a load.
 * @param settings - The settings to reconcile in place
 */
export function reconcileEngineSettings(settings: AudioRecorderSettings): void {
	for (const id of ENGINE_ORDER) {
		applyEngineSettings(settings, id, {});
	}
}

/** The engine field a settings key addresses. */
export interface EngineSettingsField {
	readonly engine: EngineId;
	readonly field: EngineSettingsFieldName;
}

/**
 * Every settings key an engine owns, mapped to the engine and the field it is.
 *
 * Built once from the registry, so a field added to an engine is routed through
 * the engine without being listed a second time here. Two engines over one
 * account name the same endpoint and key fields; either of them writes that
 * account, which is the same write, so the first claim stands.
 */
const ENGINE_FIELDS: ReadonlyMap<string, EngineSettingsField> =
	collectEngineFields();

/** Builds the settings-key index every engine's fields are looked up in. */
function collectEngineFields(): ReadonlyMap<string, EngineSettingsField> {
	const fields = new Map<string, EngineSettingsField>();
	const claim = (
		key: string | null | undefined,
		engine: EngineId,
		field: EngineSettingsFieldName,
	): void => {
		if (key && !fields.has(key)) {
			fields.set(key, { engine, field });
		}
	};
	for (const id of ENGINE_ORDER) {
		const engine = ENGINES[id];
		const account = accountOf(engine);
		claim(account?.baseUrlKey, id, 'baseUrl');
		claim(account?.apiKeyKey, id, 'apiKey');
		claim(engine.models?.modelKey, id, 'model');
		claim(engine.models?.modelsKey, id, 'models');
		claim(engine.maxTokens?.key, id, 'maxTokens');
		claim(engine.uploadChunk?.key, id, 'uploadChunkMb');
	}
	return fields;
}

/**
 * The engine field a settings key addresses, or undefined for a key no engine
 * owns. What lets a key-addressed control write through the engine that owns
 * the field rather than into the settings object behind its back.
 * @param key - A settings key
 */
export function engineFieldOf(key: string): EngineSettingsField | undefined {
	return ENGINE_FIELDS.get(key);
}

/**
 * Writes one engine field addressed by its settings key, through the engine
 * that owns it.
 * @param settings - The settings to write into
 * @param field - The engine and field the key resolved to
 * @param value - The value the control produced
 */
export function applyEngineSettingsField(
	settings: AudioRecorderSettings,
	field: EngineSettingsField,
	value: unknown,
): void {
	applyEngineSettings(settings, field.engine, { [field.field]: value });
}

/** Reads and persists one engine's configuration. */
export interface EngineSettingsStore {
	/** The engine this store configures. */
	readonly engine: EngineDescriptor;
	/** Its configuration as it currently stands. */
	read(): EngineSettingsView;
	/** Applies a change and persists it. */
	save(patch: EngineSettingsPatch): Promise<void>;
	/** Saves another id in the catalogue and puts it to work. */
	addModel(id: string): Promise<void>;
	/** Drops an id; the selection moves off it rather than at nothing. */
	removeModel(id: string): Promise<void>;
	/** Puts a saved id to work. */
	selectModel(id: string): Promise<void>;
}

/**
 * One engine's own settings store: everything above, bound to that engine and
 * to one way of persisting. Every engine gets one and they are all this
 * function, so the catalogue edits mean the same thing wherever they are
 * offered - the engine's page, the transcribe dialog, the chapters dialog.
 * @param id - The engine being configured
 * @param settings - Reads the live settings, which are replaced wholesale when
 * a config is reloaded from disk, so this is asked per call rather than held
 * @param persist - Writes the settings out; the caller decides what else that
 * entails, such as reading the settings tree again
 */
export function engineSettingsStore(
	id: EngineId,
	settings: () => AudioRecorderSettings,
	persist: () => Promise<void>,
): EngineSettingsStore {
	const save = async (patch: EngineSettingsPatch): Promise<void> => {
		applyEngineSettings(settings(), id, patch);
		await persist();
	};
	return {
		engine: ENGINES[id],
		read: () => readEngineSettings(settings(), id),
		save,
		addModel: (model) => {
			const current = readEngineSettings(settings(), id);
			return save({
				models: addModelToList([...current.models], model),
				model,
			});
		},
		removeModel: (model) => {
			const current = readEngineSettings(settings(), id);
			const remaining = removeModelFromList([...current.models], model);
			return save({
				models: remaining,
				// Dropping the id in use leaves the engine naming a model the
				// catalogue no longer offers, so the selection moves with it.
				...(current.model === model
					? { model: remaining[0] ?? '' }
					: {}),
			});
		},
		selectModel: (model) => save({ model }),
	};
}
