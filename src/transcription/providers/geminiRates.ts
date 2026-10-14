/**
 * Gemini's published rates, in the one table both registries derive from.
 *
 * The same model is billed on two paths: as a transcription engine, where the
 * audio the request carries is priced apart from its text, and as a
 * post-processing vendor, where every input token is text. That is two shapes
 * of the same fact, and while each registry held its own copy the two drifted
 * silently - a model added to one appeared in the other at no rate at all, and
 * the only symptom was a wrong number in the spending counter.
 *
 * The transcription shape is the wider of the two, so it is the one stored, and
 * the text shape is derived from it. Adding a model means adding a row here.
 * @module transcription/providers/geminiRates
 */

/**
 * A token-billed rate: USD per million audio-input, text-input, and output
 * tokens.
 */
export interface TokenRate {
	audioInput: number;
	textInput: number;
	output: number;
}

/** A text-billed rate: USD per million input and output tokens. */
export interface TextTokenRate {
	input: number;
	output: number;
}

/**
 * Approximate Gemini rates by model-id fragment. On the 2.5 Flash tier audio
 * input is billed higher than text input, so the two are kept apart; the 2.5
 * Pro tier and the whole 3.x and 4 generations bill every input modality at
 * one rate.
 *
 * The rates are the ones Google charges today, and three of them are
 * promotional: 3.6 and 3.8 Flash double to $1.50 / $7.50 on January 1, 2027,
 * and 4 Argon to $4 / $20 on December 1, 2026. The cost model has no clock, so
 * the rows are to be raised when those dates pass. A `gemini-3.5-flash` id is
 * served by 3.6 Flash since its deprecation and is priced as that model.
 */
export const GEMINI_TOKEN_RATES: readonly [string, TokenRate][] = [
	['gemini-4-argon', { audioInput: 2, textInput: 2, output: 10 }],
	['gemini-3.8-flash', { audioInput: 0.75, textInput: 0.75, output: 3.75 }],
	['gemini-3.6-flash', { audioInput: 0.75, textInput: 0.75, output: 3.75 }],
	['gemini-3.5-flash', { audioInput: 0.75, textInput: 0.75, output: 3.75 }],
	['gemini-3.5-flash-lite', { audioInput: 0.3, textInput: 0.3, output: 2.5 }],
	['gemini-2.5-flash-lite', { audioInput: 0.3, textInput: 0.1, output: 0.4 }],
	['gemini-2.5-flash', { audioInput: 1.0, textInput: 0.3, output: 2.5 }],
	['gemini-2.5-pro', { audioInput: 1.25, textInput: 1.25, output: 10 }],
];

/**
 * The same rates seen by the post-processing side, where the whole prompt is
 * text: the text-input rate applies to every input token, and the output rate
 * is unchanged.
 */
export const GEMINI_TEXT_TOKEN_RATES: readonly [string, TextTokenRate][] =
	GEMINI_TOKEN_RATES.map(([model, rate]): [string, TextTokenRate] => [
		model,
		{ input: rate.textInput, output: rate.output },
	]);
