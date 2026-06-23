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
import { DEFAULT_SETTINGS, mergeSettings } from 'src/settings/Settings';
import {
	DEEPGRAM_MODEL_SUGGESTIONS,
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
	});

	it('keeps a user-saved model list through a merge', () => {
		const merged = mergeSettings({
			deepgramModels: ['nova-3', 'my-model'],
		});
		expect(merged.deepgramModels).toEqual(['nova-3', 'my-model']);
		// An unspecified list still falls back to the seed.
		expect(merged.whisperApiModels).toEqual(WHISPER_API_MODEL_SUGGESTIONS);
	});
});
