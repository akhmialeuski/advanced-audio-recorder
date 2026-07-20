/**
 * Cost model for the cloud transcription engines and the LLM
 * post-processing pass: built-in approximate rates per engine/provider and
 * model, a pre-run estimate that combines the transcription and every
 * post-processing part into one breakdown, and conversion of
 * provider-reported usage (billed seconds or tokens) into dollars. Rates
 * are pay-as-you-go list prices at the time of writing and are inherently
 * approximate - providers change pricing, so every figure is presented as
 * an estimate, and an unknown model yields "no estimate" rather than a
 * wrong number. All functions are pure.
 * @module transcription/costs
 */

import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type {
	AudioRecorderSettings,
	LlmProviderId,
	TranscriptionProviderId,
} from '../settings/settingsSchema';
import {
	LLM_PROVIDER_LABELS,
	LLM_PROVIDER_PRICING_URLS,
	LLM_TASK_LABELS,
	TRANSCRIPTION_PROVIDER_LABELS,
	TRANSCRIPTION_PROVIDER_PRICING_URLS,
} from '../settings/labels';
import type { LlmTask } from './llmPostProcess';
import type { TranscriptionUsage } from './TranscriptTypes';

/**
 * How an engine bills a transcription (or post-processing) request. A
 * token-billed engine prices the audio and text portions of the prompt
 * separately, because providers such as Gemini charge audio input at a
 * higher rate than text input.
 */
export type EnginePricing =
	| { kind: 'free' }
	| { kind: 'perMinute'; usdPerMinute: number }
	| {
			kind: 'perToken';
			usdPerMillionAudioInput: number;
			usdPerMillionTextInput: number;
			usdPerMillionOutput: number;
	  };

/**
 * Audio tokens per second for Gemini models (Google's documented rate for
 * audio input tokenization).
 */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

/**
 * Rough transcript tokens per second of speech (roughly 2.5 words/s plus
 * JSON structure overhead). Used both as the output size of a token-billed
 * transcription engine and as the input size of the LLM post-processing
 * pass, which reads that transcript back.
 */
export const ESTIMATED_OUTPUT_TOKENS_PER_SECOND = 8;

/**
 * Fraction of the transcript an LLM task is expected to emit, used only for
 * the pre-run estimate: a cleanup or custom rewrite is about as long as its
 * input, whereas a summary is much shorter.
 */
const LLM_OUTPUT_RATIO: Record<LlmTask, number> = {
	cleanup: 1,
	summary: 0.25,
	custom: 1,
};

/**
 * Approximate per-minute rates by model-id fragment, matched longest
 * fragment first so `whisper-large-v3-turbo` never resolves through
 * `whisper-large-v3` and `distil-whisper-large-v3-en` (a distinct, cheaper
 * model) never resolves through the full `whisper-large-v3` rate. Values
 * are USD per audio minute.
 */
const WHISPER_API_RATES: readonly [string, number][] = [
	// Groq-hosted Whisper models (priced per hour: $0.02 / $0.04 / $0.111).
	['distil-whisper-large-v3-en', 0.02 / 60],
	['whisper-large-v3-turbo', 0.04 / 60],
	['whisper-large-v3', 0.111 / 60],
	// OpenAI whisper-1.
	['whisper-1', 0.006],
];

/** Approximate Deepgram pre-recorded pay-as-you-go rates, USD per minute. */
const DEEPGRAM_RATES: readonly [string, number][] = [
	['enhanced', 0.0145],
	['whisper', 0.0048],
	['nova-3', 0.0043],
	['nova-2', 0.0043],
	['nova', 0.0043],
	['base', 0.0125],
];

/** A token-billed rate: USD per million audio-input, text-input, and output tokens. */
interface TokenRate {
	audioInput: number;
	textInput: number;
	output: number;
}

/**
 * Approximate Gemini transcription rates. Audio input is billed higher than
 * text input on the Flash tier, so the two are kept apart; the Pro tier
 * bills both alike.
 */
const GEMINI_RATES: readonly [string, TokenRate][] = [
	['gemini-2.5-flash-lite', { audioInput: 0.3, textInput: 0.1, output: 0.4 }],
	['gemini-2.5-flash', { audioInput: 1.0, textInput: 0.3, output: 2.5 }],
	['gemini-2.5-pro', { audioInput: 1.25, textInput: 1.25, output: 10 }],
	['gemini-2.0-flash', { audioInput: 0.7, textInput: 0.1, output: 0.4 }],
];

/** A text-billed LLM rate: USD per million input and output tokens. */
interface LlmRate {
	input: number;
	output: number;
}

/** Approximate OpenAI chat rates for post-processing, USD per million tokens. */
const LLM_OPENAI_RATES: readonly [string, LlmRate][] = [
	['gpt-4o-mini', { input: 0.15, output: 0.6 }],
	['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
	['gpt-4.1', { input: 2.0, output: 8.0 }],
	['gpt-4o', { input: 2.5, output: 10 }],
	['o4-mini', { input: 1.1, output: 4.4 }],
];

/** Approximate Anthropic rates for post-processing, USD per million tokens. */
const LLM_ANTHROPIC_RATES: readonly [string, LlmRate][] = [
	['claude-opus-4', { input: 15, output: 75 }],
	['claude-sonnet-4', { input: 3, output: 15 }],
	['claude-haiku-4', { input: 1, output: 5 }],
];

/**
 * Approximate Gemini text rates for post-processing, USD per million
 * tokens. Post-processing input is text (the transcript), so unlike the
 * transcription {@link GEMINI_RATES} the text-input rate applies.
 */
const LLM_GEMINI_RATES: readonly [string, LlmRate][] = [
	['gemini-2.5-flash-lite', { input: 0.1, output: 0.4 }],
	['gemini-2.5-flash', { input: 0.3, output: 2.5 }],
	['gemini-2.5-pro', { input: 1.25, output: 10 }],
	['gemini-2.0-flash', { input: 0.1, output: 0.4 }],
];

/**
 * Finds the rate whose model-id fragment appears in the (normalized)
 * model id, preferring the longest fragment so more specific entries win.
 */
function matchRate<T>(
	rates: readonly [string, T][],
	model: string,
): T | undefined {
	const normalized = model.trim().toLowerCase();
	let best: { length: number; value: T } | undefined;
	for (const [fragment, value] of rates) {
		if (
			normalized.includes(fragment) &&
			(!best || fragment.length > best.length)
		) {
			best = { length: fragment.length, value };
		}
	}
	return best?.value;
}

/** Wraps a matched {@link TokenRate} as per-token pricing, or null when unmatched. */
function perTokenPricing(rate: TokenRate | undefined): EnginePricing | null {
	return rate === undefined
		? null
		: {
				kind: 'perToken',
				usdPerMillionAudioInput: rate.audioInput,
				usdPerMillionTextInput: rate.textInput,
				usdPerMillionOutput: rate.output,
			};
}

/**
 * Resolves the pricing for a transcription engine and model. Model ids are
 * free-form user-editable strings, so an id no built-in rate matches
 * yields null ("no estimate") instead of a wrong number. The local engine
 * is always free.
 * @param engineId - Transcription engine id
 * @param model - Selected model id for that engine
 */
export function resolveEnginePricing(
	engineId: TranscriptionProviderId,
	model: string,
): EnginePricing | null {
	switch (engineId) {
		case TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER:
			return { kind: 'free' };
		case TRANSCRIPTION_PROVIDER_IDS.WHISPER_API: {
			const rate = matchRate(WHISPER_API_RATES, model);
			return rate === undefined
				? null
				: { kind: 'perMinute', usdPerMinute: rate };
		}
		case TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM: {
			const rate = matchRate(DEEPGRAM_RATES, model);
			return rate === undefined
				? null
				: { kind: 'perMinute', usdPerMinute: rate };
		}
		case TRANSCRIPTION_PROVIDER_IDS.GEMINI:
			return perTokenPricing(matchRate(GEMINI_RATES, model));
		default:
			return null;
	}
}

/**
 * Resolves the pricing for an LLM post-processing provider and model.
 * Post-processing is text-only, so both the audio and text input rates map
 * to the model's single input rate.
 * @param providerId - LLM provider id
 * @param model - Selected LLM model id
 */
export function resolveLlmPricing(
	providerId: LlmProviderId,
	model: string,
): EnginePricing | null {
	const table =
		providerId === LLM_PROVIDER_IDS.ANTHROPIC
			? LLM_ANTHROPIC_RATES
			: providerId === LLM_PROVIDER_IDS.GEMINI
				? LLM_GEMINI_RATES
				: LLM_OPENAI_RATES;
	const rate = matchRate(table, model);
	return perTokenPricing(
		rate && {
			audioInput: rate.input,
			textInput: rate.input,
			output: rate.output,
		},
	);
}

/**
 * Returns the model id the settings select for the given transcription
 * engine ('' for the local engine, which has no billed model).
 * @param settings - Plugin settings
 * @param engineId - Transcription engine id
 */
export function selectedEngineModel(
	settings: AudioRecorderSettings,
	engineId: TranscriptionProviderId,
): string {
	switch (engineId) {
		case TRANSCRIPTION_PROVIDER_IDS.WHISPER_API:
			return settings.whisperApiModel;
		case TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM:
			return settings.deepgramModel;
		case TRANSCRIPTION_PROVIDER_IDS.GEMINI:
			return settings.geminiModel;
		default:
			return '';
	}
}

/**
 * Returns the model id the settings select for the current LLM provider.
 * @param settings - Plugin settings
 */
export function selectedLlmModel(settings: AudioRecorderSettings): string {
	switch (settings.llmProvider) {
		case LLM_PROVIDER_IDS.ANTHROPIC:
			return settings.llmAnthropicModel;
		case LLM_PROVIDER_IDS.GEMINI:
			return settings.llmGeminiModel;
		default:
			return settings.llmOpenAiModel;
	}
}

/**
 * Converts provider-reported usage into dollars under the given pricing.
 * Returns null when the usage carries nothing the pricing can bill (e.g.
 * a per-minute engine that reported no billed seconds), so a caller can
 * fall back to an estimate instead of showing a false zero. Token usage is
 * priced by modality: the audio portion of the prompt at the audio rate
 * and the remainder at the text rate.
 * @param pricing - Engine pricing
 * @param usage - Provider-reported usage
 */
export function costFromUsage(
	pricing: EnginePricing,
	usage: TranscriptionUsage,
): number | null {
	switch (pricing.kind) {
		case 'free':
			return 0;
		case 'perMinute':
			return usage.audioSeconds === undefined
				? null
				: (usage.audioSeconds / 60) * pricing.usdPerMinute;
		case 'perToken': {
			if (
				usage.inputTokens === undefined &&
				usage.outputTokens === undefined
			) {
				return null;
			}
			const audioInput = usage.audioInputTokens ?? 0;
			const textInput = Math.max(
				0,
				(usage.inputTokens ?? 0) - audioInput,
			);
			return (
				(audioInput / 1_000_000) * pricing.usdPerMillionAudioInput +
				(textInput / 1_000_000) * pricing.usdPerMillionTextInput +
				((usage.outputTokens ?? 0) / 1_000_000) *
					pricing.usdPerMillionOutput
			);
		}
	}
}

/**
 * Synthesizes the usage a transcription run of the given duration is
 * expected to bill, so the pre-run estimate can go through the same
 * {@link costFromUsage} math as the post-run actuals. For a token-billed
 * engine the whole prompt is audio (the recording), so the estimate has no
 * text-input tokens.
 * @param pricing - Engine pricing
 * @param durationSeconds - Audio duration in seconds
 */
function estimatedUsage(
	pricing: EnginePricing,
	durationSeconds: number,
): TranscriptionUsage {
	if (pricing.kind === 'perToken') {
		const audioTokens = Math.ceil(
			durationSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND,
		);
		return {
			inputTokens: audioTokens,
			audioInputTokens: audioTokens,
			outputTokens: Math.ceil(
				durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND,
			),
		};
	}
	return { audioSeconds: durationSeconds };
}

/**
 * Synthesizes the usage an LLM post-processing pass over a transcript of
 * the given duration is expected to bill. The transcript is the (text)
 * input; the output is a fraction of it that depends on the task and is
 * capped by the configured output-token budget.
 * @param settings - Plugin settings
 * @param durationSeconds - Audio duration in seconds
 */
function estimatedLlmUsage(
	settings: AudioRecorderSettings,
	durationSeconds: number,
): TranscriptionUsage {
	const transcriptTokens = Math.ceil(
		durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND,
	);
	const ratio = LLM_OUTPUT_RATIO[settings.llmPostProcessTask] ?? 1;
	const outputTokens = Math.min(
		Math.ceil(transcriptTokens * ratio),
		settings.llmMaxTokens,
	);
	return { inputTokens: transcriptTokens, outputTokens };
}

/**
 * Estimates the cost of transcribing the given duration on an engine and
 * model. Returns null when no built-in rate matches the model.
 * @param engineId - Transcription engine id
 * @param model - Selected model id
 * @param durationSeconds - Audio duration in seconds
 */
export function estimateTranscriptionCost(
	engineId: TranscriptionProviderId,
	model: string,
	durationSeconds: number,
): number | null {
	const pricing = resolveEnginePricing(engineId, model);
	if (!pricing) {
		return null;
	}
	return costFromUsage(pricing, estimatedUsage(pricing, durationSeconds));
}

/**
 * Estimates the cost of the configured LLM post-processing pass over a
 * transcript of the given duration. Returns null when no built-in rate
 * matches the LLM model.
 * @param settings - Plugin settings
 * @param durationSeconds - Audio duration in seconds
 */
export function estimateLlmCost(
	settings: AudioRecorderSettings,
	durationSeconds: number,
): number | null {
	const pricing = resolveLlmPricing(
		settings.llmProvider,
		selectedLlmModel(settings),
	);
	if (!pricing) {
		return null;
	}
	return costFromUsage(pricing, estimatedLlmUsage(settings, durationSeconds));
}

/**
 * Sums the usage several parts reported into one total. A field appears
 * in the total only when at least one part reported it, preserving the
 * "missing means not reported" convention.
 * @param usages - Per-part usage reports (undefined entries are skipped)
 */
export function sumUsage(
	usages: readonly (TranscriptionUsage | undefined)[],
): TranscriptionUsage {
	const total: TranscriptionUsage = {};
	for (const usage of usages) {
		if (!usage) {
			continue;
		}
		if (usage.audioSeconds !== undefined) {
			total.audioSeconds = (total.audioSeconds ?? 0) + usage.audioSeconds;
		}
		if (usage.inputTokens !== undefined) {
			total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
		}
		if (usage.audioInputTokens !== undefined) {
			total.audioInputTokens =
				(total.audioInputTokens ?? 0) + usage.audioInputTokens;
		}
		if (usage.outputTokens !== undefined) {
			total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
		}
	}
	return total;
}

/**
 * Formats a dollar amount for display: two decimals for readable sums, a
 * "less than a cent" form for tiny ones so a short clip never shows a
 * misleading `$0.00`.
 * @param usd - Amount in dollars
 */
export function formatUsd(usd: number): string {
	if (usd === 0) {
		return '$0.00';
	}
	if (usd < 0.005) {
		return '<$0.01';
	}
	return `$${usd.toFixed(2)}`;
}

/** Why a cost-estimate line could not be priced. */
export type CostEstimateUnpricedReason = 'no-rate' | 'no-duration';

/** One line of the pre-run cost estimate (transcription or a post-processing pass). */
export interface CostEstimateLine {
	/** What this line prices, e.g. "Transcription" or "Post-processing (Clean up)". */
	label: string;
	/** Provider display name, shown as the pricing link. */
	providerName: string;
	/** Provider pricing page, absent for the free local engine. */
	pricingUrl?: string;
	/** Selected model id (empty for the free local engine). */
	model: string;
	/** Estimated cost in USD, or null when it cannot be priced. */
	usd: number | null;
	/** True for the free local engine, shown as "no API cost". */
	free?: boolean;
	/** When {@link usd} is null, why the line could not be priced. */
	reason?: CostEstimateUnpricedReason;
}

/** The pre-run estimate: one line per billed part plus their combined total. */
export interface CostEstimate {
	/** Transcription first, then the post-processing pass when enabled. */
	lines: CostEstimateLine[];
	/** Sum of the priced lines; null when no line could be priced. */
	totalUsd: number | null;
	/** True when at least one line has no built-in rate for its model. */
	hasUnpriced: boolean;
}

/** Builds the transcription line of the estimate. */
function transcriptionEstimateLine(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimateLine {
	const engineId = settings.transcriptionProvider;
	const model = selectedEngineModel(settings, engineId);
	const providerName = TRANSCRIPTION_PROVIDER_LABELS[engineId];
	const pricingUrl = TRANSCRIPTION_PROVIDER_PRICING_URLS[engineId];
	const base = { label: 'Transcription', providerName, model, pricingUrl };
	const pricing = resolveEnginePricing(engineId, model);
	if (pricing?.kind === 'free') {
		return { ...base, pricingUrl: undefined, usd: 0, free: true };
	}
	if (!pricing) {
		return { ...base, usd: null, reason: 'no-rate' };
	}
	if (durationSeconds === null) {
		return { ...base, usd: null, reason: 'no-duration' };
	}
	return {
		...base,
		usd: costFromUsage(pricing, estimatedUsage(pricing, durationSeconds)),
	};
}

/** Builds the LLM post-processing line of the estimate. */
function llmEstimateLine(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimateLine {
	const providerId = settings.llmProvider;
	const model = selectedLlmModel(settings);
	const base = {
		label: `Post-processing (${LLM_TASK_LABELS[settings.llmPostProcessTask]})`,
		providerName: LLM_PROVIDER_LABELS[providerId],
		model,
		pricingUrl: LLM_PROVIDER_PRICING_URLS[providerId],
	};
	const pricing = resolveLlmPricing(providerId, model);
	if (!pricing) {
		return { ...base, usd: null, reason: 'no-rate' };
	}
	if (durationSeconds === null) {
		return { ...base, usd: null, reason: 'no-duration' };
	}
	return {
		...base,
		usd: costFromUsage(
			pricing,
			estimatedLlmUsage(settings, durationSeconds),
		),
	};
}

/**
 * Builds the combined pre-run cost estimate: the transcription plus, when
 * enabled, the LLM post-processing pass, each priced as its own line, with
 * the priced lines summed into a total. Pure so the numbers and wording
 * are unit tested; the dialog only decides how to render the result.
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Probed audio duration, or null when unknown
 */
export function buildCostEstimate(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimate {
	const lines: CostEstimateLine[] = [
		transcriptionEstimateLine(settings, durationSeconds),
	];
	if (settings.llmPostProcessEnabled) {
		lines.push(llmEstimateLine(settings, durationSeconds));
	}
	let total = 0;
	let anyPriced = false;
	let hasUnpriced = false;
	for (const line of lines) {
		if (line.usd === null) {
			hasUnpriced = true;
		} else {
			total += line.usd;
			anyPriced = true;
		}
	}
	return { lines, totalUsd: anyPriced ? total : null, hasUnpriced };
}

/**
 * Whether the estimate for these settings needs the audio duration to be
 * priced. False when the only billed part is the free local engine and no
 * post-processing runs, letting the dialog skip the audio probe entirely.
 * @param settings - The run's settings snapshot
 */
export function costEstimateNeedsDuration(
	settings: AudioRecorderSettings,
): boolean {
	const engine = resolveEnginePricing(
		settings.transcriptionProvider,
		selectedEngineModel(settings, settings.transcriptionProvider),
	);
	const engineNeeds = engine !== null && engine.kind !== 'free';
	const llmNeeds =
		settings.llmPostProcessEnabled &&
		resolveLlmPricing(settings.llmProvider, selectedLlmModel(settings)) !==
			null;
	return engineNeeds || llmNeeds;
}
