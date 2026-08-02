/**
 * Tests for the pure model-list helpers backing the engine model picker:
 * trimming, de-duplicated add, remove, and ensuring the selected id is always
 * present so the dropdown can show the current value. Also pins that the
 * settings defaults seed the lists and that user-saved lists survive a merge.
 * @module tests/unit/modelList.test
 */

import {
	addModelToList,
	ensureSelectedInList,
	normalizeModelId,
	removeModelFromList,
} from 'src/settings/modelList';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { MODEL_SEED_GENERATION } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	DEEPGRAM_MODEL_SUGGESTIONS,
	GEMINI_MODEL_SUGGESTIONS,
	LLM_ANTHROPIC_MODEL_SUGGESTIONS,
	LLM_GEMINI_MODEL_SUGGESTIONS,
	LLM_OPENAI_MODEL_SUGGESTIONS,
	WHISPER_API_MODEL_SUGGESTIONS,
} from 'src/constants';

describe('normalizeModelId', () => {
	it('trims surrounding whitespace', () => {
		expect(normalizeModelId('  nova-3  ')).toBe('nova-3');
		expect(normalizeModelId('')).toBe('');
	});
});

describe('addModelToList', () => {
	it('appends a trimmed, new model id', () => {
		expect(addModelToList(['a'], '  b ')).toEqual(['a', 'b']);
	});

	it('ignores an empty id', () => {
		expect(addModelToList(['a'], '   ')).toEqual(['a']);
	});

	it('does not duplicate an existing id', () => {
		expect(addModelToList(['a', 'b'], 'b')).toEqual(['a', 'b']);
	});

	it('returns a new array (no in-place mutation)', () => {
		const original = ['a'];
		const result = addModelToList(original, 'b');
		expect(result).not.toBe(original);
		expect(original).toEqual(['a']);
	});
});

describe('removeModelFromList', () => {
	it('removes the matching id', () => {
		expect(removeModelFromList(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
	});

	it('leaves the list unchanged when the id is absent', () => {
		expect(removeModelFromList(['a', 'b'], 'z')).toEqual(['a', 'b']);
	});
});

describe('ensureSelectedInList', () => {
	it('prepends a selected id missing from the list', () => {
		expect(ensureSelectedInList(['a', 'b'], 'custom')).toEqual([
			'custom',
			'a',
			'b',
		]);
	});

	it('leaves the list unchanged when the selection is present', () => {
		expect(ensureSelectedInList(['a', 'b'], 'b')).toEqual(['a', 'b']);
	});

	it('ignores an empty selection', () => {
		expect(ensureSelectedInList(['a'], '   ')).toEqual(['a']);
	});
});

describe('model list settings defaults', () => {
	it('seeds the picker lists from the built-in suggestions', () => {
		expect(DEFAULT_SETTINGS.whisperApiModels).toEqual(
			WHISPER_API_MODEL_SUGGESTIONS,
		);
		expect(DEFAULT_SETTINGS.deepgramModels).toEqual(
			DEEPGRAM_MODEL_SUGGESTIONS,
		);
		expect(DEFAULT_SETTINGS.geminiModels).toEqual(GEMINI_MODEL_SUGGESTIONS);
		expect(DEFAULT_SETTINGS.llmOpenAiModels).toEqual(
			LLM_OPENAI_MODEL_SUGGESTIONS,
		);
		expect(DEFAULT_SETTINGS.llmAnthropicModels).toEqual(
			LLM_ANTHROPIC_MODEL_SUGGESTIONS,
		);
		// Gemini serves one family of ids for both jobs, so its engine keeps
		// one catalogue: the transcription seed list, which is the wider one.
		expect(DEFAULT_SETTINGS.geminiModels).toEqual(
			expect.arrayContaining([...LLM_GEMINI_MODEL_SUGGESTIONS]),
		);
	});

	it('selects a default model that is present in its own seed list', () => {
		// A default outside its list would surface only through the
		// ensureSelectedInList fallback; the seeds should stay consistent.
		expect(WHISPER_API_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.whisperApiModel,
		);
		expect(DEEPGRAM_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.deepgramModel,
		);
		expect(GEMINI_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.geminiModel,
		);
		expect(LLM_OPENAI_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.llmOpenAiModel,
		);
		expect(LLM_ANTHROPIC_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.llmAnthropicModel,
		);
		expect(LLM_GEMINI_MODEL_SUGGESTIONS).toContain(
			DEFAULT_SETTINGS.geminiModel,
		);
	});

	it('keeps a user-saved model list through a merge', () => {
		// The list is the user's: ids they added survive, and the shipped ones
		// are topped up once per seed generation rather than on every load.
		const merged = mergeSettings({
			deepgramModels: ['nova-3', 'my-model'],
			modelSeedGeneration: MODEL_SEED_GENERATION,
		});

		expect(merged.deepgramModels).toEqual(['nova-3', 'my-model']);
	});

	it('tops a saved list up with the ids this version ships', () => {
		const merged = mergeSettings({ deepgramModels: ['my-model'] });

		expect(merged.deepgramModels).toEqual(
			expect.arrayContaining(['my-model', 'nova-3']),
		);
		expect(merged.modelSeedGeneration).toBe(MODEL_SEED_GENERATION);
	});
});
