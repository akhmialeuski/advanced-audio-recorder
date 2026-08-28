/**
 * The Gemini rate table, and the guarantee that adding a model is one edit.
 *
 * The two registries that price Gemini used to hold a table each, and a model
 * added to one appeared in the other at no rate at all. That failure is silent:
 * it shows up as a wrong number in the spending counter, never as an error. The
 * catalogue check below is what turns it into a failed build instead.
 */

import { GEMINI_MODEL_SUGGESTIONS } from 'src/constants';
import {
	GEMINI_TEXT_TOKEN_RATES,
	GEMINI_TOKEN_RATES,
} from 'src/transcription/providers/geminiRates';
import { matchRate } from 'src/transcription/providers/engines';

describe('the Gemini rate table', () => {
	it.each(GEMINI_MODEL_SUGGESTIONS.map((model) => ({ model })))(
		'prices $model, the catalogue model',
		({ model }) => {
			expect(matchRate(GEMINI_TOKEN_RATES, model)).toBeDefined();
		},
	);

	it.each(GEMINI_MODEL_SUGGESTIONS.map((model) => ({ model })))(
		'prices $model on the post-processing side too',
		({ model }) => {
			expect(matchRate(GEMINI_TEXT_TOKEN_RATES, model)).toBeDefined();
		},
	);

	it('derives the text rates from the token rates it stores', () => {
		expect(GEMINI_TEXT_TOKEN_RATES).toEqual(
			GEMINI_TOKEN_RATES.map(([model, rate]) => [
				model,
				{ input: rate.textInput, output: rate.output },
			]),
		);
	});

	it('bills audio at or above text on every model it prices', () => {
		const cheaperAudio = GEMINI_TOKEN_RATES.filter(
			([, rate]) => rate.audioInput < rate.textInput,
		);

		expect(cheaperAudio).toEqual([]);
	});
});
