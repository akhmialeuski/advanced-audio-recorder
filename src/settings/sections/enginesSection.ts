/**
 * The Engines page: one sub-page per engine, its account, and its model
 * catalogue.
 *
 * An engine's credentials are a password field and its local paths are file
 * pickers, neither of which the control set has a type for, so those rows come
 * through the context as render callbacks.
 * @module settings/sections/enginesSection
 */

import {
	LLM_MAX_TOKENS_STEP,
	MAX_LLM_MAX_TOKENS,
	MAX_TRANSCRIBE_CHUNK_MB,
	MIN_LLM_MAX_TOKENS,
	MIN_TRANSCRIBE_CHUNK_MB,
} from '../../constants';
import {
	accountKeyMissing,
	accountOf,
	ACCOUNTS,
	ENGINE_ORDER,
	type EngineDescriptor,
	type EngineId,
	ENGINES,
	type ProviderModels,
} from '../../providers/providers';
import {
	enginesStatus,
	engineStatus,
	type PageStatus,
} from '../settingsAttention';
import type { AudioRecorderSettings } from '../settingsSchema';
import {
	SETTINGS_SECTION_CLASS,
	type SettingsDefinitionContext,
	type TranscriptionBlocks,
} from './context';
import {
	addItemRow,
	imperativeBlockRow,
	nameFilter,
	sectionItems,
	transcriptionPageActive,
} from './rowHelpers';
import type { SettingGroupItem } from 'obsidian';

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
		// Both paths, in the order they are entered: the local engine is
		// refused without either, so a binary alone is not "Configured".
		if (!settings.localWhisperBinaryPath) {
			return 'No binary';
		}
		return settings.localWhisperModelPath ? 'Configured' : 'No model file';
	}
	if (accountKeyMissing(connection, settings)) {
		return 'No key';
	}
	if (!engine.models) {
		return 'Key set';
	}
	return engine.models.model(settings) || 'No model';
}

/**
 * How many accounts are ready to be called. An account is what a key belongs
 * to, so the accounts themselves are counted rather than the engines behind
 * them: two engines over one account are one answer, not two. An account
 * pointed at a local endpoint counts without a key, because that is what the
 * factories do with it.
 * @param settings - Live settings, read for each account's key and endpoint
 */
function configuredAccountCount(settings: AudioRecorderSettings): number {
	return Object.values(ACCOUNTS).filter(
		(account) => !accountKeyMissing(account, settings),
	).length;
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
 * The row that picks the model an engine runs on.
 *
 * A dropdown over the saved ids, which is what choosing one of a handful of
 * known values is: in place, one tap, the current value legible without opening
 * anything. It was briefly an entry opening the catalogue instead, so picking a
 * model meant walking into a list and tapping a row - two taps and a page for a
 * question that has an answer visible from here.
 *
 * The value is written by the engine that owns the field, because the key is
 * one the provider registry claims, so the catalogue invariant holds the same
 * way it does for an edit made anywhere else.
 * @param settings - Live settings, read for the saved ids
 * @param models - The catalogue's own settings fields and copy
 */
function modelPickerRow(
	settings: AudioRecorderSettings,
	models: ProviderModels,
): SettingGroupItem {
	const saved = models.models(settings);
	return {
		name: models.pickerName,
		aliases: ['engine model', 'model id'],
		desc: catalogueDesc(models),
		control: {
			type: 'dropdown',
			key: models.modelKey,
			options: Object.fromEntries(saved.map((id) => [id, id])),
			// An emptied catalogue offers nothing to pick, and the entry below
			// is where ids are added; a dropdown over no options would just be
			// a blank field with no way out of it.
			disabled: saved.length === 0,
		},
	};
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
		// The list, not the choice: a vendor's catalogue runs to thirty-odd ids,
		// which inline is thirty rows between the endpoint and everything
		// configured after it. What it holds is what its entry reports, so it
		// never restates the value the picker above it already shows.
		type: 'page',
		name: `${models.pickerName} catalogue`,
		desc: 'The model ids this provider is offered in the picker above. Add the ones your endpoint serves and remove the ones it does not.',
		displayValue: (): string => {
			const count = models.models(settings).length;
			return count === 1 ? '1 saved' : `${String(count)} saved`;
		},
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
			}),
		);
	}
	const models = engine.models;
	if (models) {
		// Two rows that say different things: the picker is the choice, and
		// the catalogue is the list it is chosen from. They were one entry
		// doing both, which buried picking a model two taps deep for a
		// question a dropdown answers in place.
		rows.push(
			modelPickerRow(settings, models),
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
			}),
		);
	}
	return {
		type: 'page',
		name: engine.label,
		desc: engineJobsDesc(engine),
		displayValue: (): string => engineSummary(settings, engine),
		status: (): PageStatus => engineStatus(settings, engine),
		items: sectionItems(rows),
	};
}

/**
 * Every engine, each on a page of its own. One place to set a service up,
 * whatever it is later used for, which is what the transcription block and the
 * post-processing block point at instead of holding their own copies.
 * @param ctx - Everything the tree reads from the tab
 */
export function enginesPage(ctx: SettingsDefinitionContext): SettingGroupItem {
	return {
		type: 'page',
		name: 'Engines',
		desc: 'The services this plugin calls: where each one is reached, and the models it serves.',
		// Counted by account rather than by engine: a key configures the account
		// it belongs to, and the two engines over the OpenAI account would
		// otherwise both report the one key that was entered.
		displayValue: (): string =>
			`${String(configuredAccountCount(ctx.settings))} configured`,
		// Counting the accounts that hold a key says nothing about whether the
		// ones actually called hold theirs, which is what this reports.
		status: (): PageStatus => enginesStatus(ctx.settings),
		visible: (): boolean => transcriptionPageActive(ctx.settings),
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
