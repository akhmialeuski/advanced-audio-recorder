/**
 * Cost model for the cloud transcription engines and every LLM step of a run:
 * built-in approximate rates per engine/provider and model, a pre-run estimate
 * that assembles one breakdown line per billable step actually enabled (the
 * transcription pass or passes, the advanced context agents, the LLM
 * post-processing, and the auto chapters), and conversion of provider-reported
 * usage (billed seconds or tokens) into dollars. Rates
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
import { autoChaptersAfterTranscribe } from '../settings/settingsSchema';
import {
	advancedBiasChannel,
	advancedTwoPassWillRun,
} from './advanced/advancedBias';
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
 * The advanced two-pass mode runs a fixed team of sequential LLM agents between
 * the passes. A prompt-biased engine runs six (names, jargon, acronyms, a
 * decider, the topic, and the sentence builder); a keyword-biased engine
 * (Deepgram) reads only the keyterm list, so the pipeline skips the topic and
 * sentence agents and runs four. Representative call counts for the estimate;
 * the actual count varies slightly because the decider only runs when there are
 * candidates to vet. Kept in step with the pipeline in
 * {@link generateContext}.
 */
export const CONTEXT_AGENT_CALL_ESTIMATE_PROMPT = 6;
export const CONTEXT_AGENT_CALL_ESTIMATE_KEYTERM = 4;

/**
 * Each context agent reads a condensed sample of the first draft, which the
 * pipeline caps well below a long transcript (about 12k characters, roughly
 * 3000 tokens), and emits a short list or sentence. Representative per-call
 * sizes for the estimate, so the agents' cost stays roughly flat per run
 * instead of scaling with the whole recording.
 */
export const CONTEXT_AGENT_INPUT_TOKENS = 3000;
export const CONTEXT_AGENT_OUTPUT_TOKENS = 200;

/**
 * Auto chapters read the transcript and emit a short list of titled
 * timestamps, so the output is a small fraction of the input.
 */
export const CHAPTERS_OUTPUT_TOKEN_RATIO = 0.1;

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
 * Approximate Gemini transcription rates. On the 2.5 Flash tier audio input
 * is billed higher than text input, so the two are kept apart; the 2.5 Pro
 * tier and the whole 3.x generation bill every input modality at one rate.
 */
const GEMINI_RATES: readonly [string, TokenRate][] = [
	['gemini-3.6-flash', { audioInput: 1.5, textInput: 1.5, output: 7.5 }],
	['gemini-3.5-flash', { audioInput: 1.5, textInput: 1.5, output: 9 }],
	['gemini-3.5-flash-lite', { audioInput: 0.3, textInput: 0.3, output: 2.5 }],
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

/**
 * Approximate OpenAI chat rates for post-processing, USD per million tokens.
 * The GPT-5.6 family is the current seeded generation; the 4.x and o-series
 * entries below it were dropped from the seed list but stay priced because
 * the API still serves them for user-saved model lists.
 */
const LLM_OPENAI_RATES: readonly [string, LlmRate][] = [
	['gpt-5.6-sol', { input: 5, output: 30 }],
	['gpt-5.6-terra', { input: 2.5, output: 15 }],
	['gpt-5.6-luna', { input: 1, output: 6 }],
	['gpt-4o-mini', { input: 0.15, output: 0.6 }],
	['gpt-4.1-mini', { input: 0.4, output: 1.6 }],
	['gpt-4.1', { input: 2.0, output: 8.0 }],
	['gpt-4o', { input: 2.5, output: 10 }],
	['o4-mini', { input: 1.1, output: 4.4 }],
];

/**
 * Approximate Anthropic rates for post-processing, USD per million tokens.
 * The bare `claude-opus-4` fragment prices the $5/$25 Opus 4.5-4.8 tier; the
 * longer `claude-opus-4-1`/`claude-opus-4-0` fragments win the longest-match
 * rule for the legacy $15/$75 models so they do not inherit the cheaper rate.
 */
const LLM_ANTHROPIC_RATES: readonly [string, LlmRate][] = [
	['claude-fable-5', { input: 10, output: 50 }],
	['claude-sonnet-5', { input: 3, output: 15 }],
	['claude-opus-4-1', { input: 15, output: 75 }],
	['claude-opus-4-0', { input: 15, output: 75 }],
	['claude-opus-4', { input: 5, output: 25 }],
	['claude-sonnet-4', { input: 3, output: 15 }],
	['claude-haiku-4', { input: 1, output: 5 }],
];

/**
 * Approximate Gemini text rates for post-processing, USD per million
 * tokens. Post-processing input is text (the transcript), so unlike the
 * transcription {@link GEMINI_RATES} the text-input rate applies.
 */
const LLM_GEMINI_RATES: readonly [string, LlmRate][] = [
	['gemini-3.6-flash', { input: 1.5, output: 7.5 }],
	['gemini-3.5-flash', { input: 1.5, output: 9 }],
	['gemini-3.5-flash-lite', { input: 0.3, output: 2.5 }],
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
 * Synthesizes the LLM usage the advanced two-pass context agents are expected
 * to bill: `callCount` calls, each reading a bounded sample of the draft and
 * emitting a short answer. The sample is capped by the pipeline, so a longer
 * recording does not proportionally raise this cost.
 * @param durationSeconds - Audio duration in seconds
 * @param callCount - Number of sequential agent calls the pipeline runs
 */
function estimatedContextAgentsUsage(
	durationSeconds: number,
	callCount: number,
): TranscriptionUsage {
	const transcriptTokens = Math.ceil(
		durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND,
	);
	const perCallInput = Math.min(transcriptTokens, CONTEXT_AGENT_INPUT_TOKENS);
	return {
		inputTokens: perCallInput * callCount,
		outputTokens: CONTEXT_AGENT_OUTPUT_TOKENS * callCount,
	};
}

/**
 * Synthesizes the LLM usage an auto-chapters pass over a transcript of the
 * given duration is expected to bill: the transcript is the input and the
 * titled-timestamp list is a small fraction of it, capped by the output-token
 * budget.
 * @param settings - Plugin settings
 * @param durationSeconds - Audio duration in seconds
 */
function estimatedChaptersUsage(
	settings: AudioRecorderSettings,
	durationSeconds: number,
): TranscriptionUsage {
	const transcriptTokens = Math.ceil(
		durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND,
	);
	const outputTokens = Math.min(
		Math.ceil(transcriptTokens * CHAPTERS_OUTPUT_TOKEN_RATIO),
		settings.llmMaxTokens,
	);
	return { inputTokens: transcriptTokens, outputTokens };
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

/** One line of the pre-run cost estimate (a transcription pass or an LLM step). */
export interface CostEstimateLine {
	/**
	 * What this line prices, e.g. "Transcription", "Advanced context agents",
	 * "Post-processing (Clean up)", or "Auto chapters".
	 */
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

/** The pre-run estimate: one line per billed step plus their combined total. */
export interface CostEstimate {
	/**
	 * The billed steps in execution order: the transcription pass(es) first,
	 * then whichever LLM steps are enabled (advanced context agents,
	 * post-processing, auto chapters).
	 */
	lines: CostEstimateLine[];
	/** Sum of the priced lines; null when no line could be priced. */
	totalUsd: number | null;
	/** True when at least one line has no built-in rate for its model. */
	hasUnpriced: boolean;
}

/**
 * A billable step of a transcription run. Every place that prices work -
 * the pre-run breakdown, a single-purpose dialog, the post-run accounting -
 * names the step it means and goes through {@link estimateStepCost}, so one
 * step can never be priced by two different formulas.
 */
export type RunCostStepId =
	| 'transcription'
	| 'contextAgents'
	| 'postProcess'
	| 'autoChapters';

/**
 * How many times the engine decodes the audio for a run. The advanced
 * two-pass mode transcribes twice; it is capability-gated rather than read
 * off the bare toggle, because an engine that cannot bias (e.g. a Deepgram
 * hosted Whisper model) degrades to one plain pass at run time and must not
 * be priced for a phantom second pass.
 * @param settings - The run's settings snapshot
 */
function transcriptionPasses(settings: AudioRecorderSettings): number {
	return advancedTwoPassWillRun(settings) ? 2 : 1;
}

/**
 * Builds the transcription line of the estimate, scaled by the passes the run
 * will actually make, so the number is pass-aware wherever it is read.
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Probed audio duration, or null when unknown
 */
function transcriptionEstimateLine(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimateLine {
	const engineId = settings.transcriptionProvider;
	const model = selectedEngineModel(settings, engineId);
	const providerName = TRANSCRIPTION_PROVIDER_LABELS[engineId];
	const pricingUrl = TRANSCRIPTION_PROVIDER_PRICING_URLS[engineId];
	const passes = transcriptionPasses(settings);
	const label =
		passes > 1
			? `Transcription (${String(passes)} passes)`
			: 'Transcription';
	const base = { label, providerName, model, pricingUrl };
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
	const perPass = costFromUsage(
		pricing,
		estimatedUsage(pricing, durationSeconds),
	);
	return { ...base, usd: perPass === null ? null : perPass * passes };
}

/** Builds an LLM estimate line (an LLM provider call) with a given label and usage. */
function llmLine(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
	label: string,
	usage: (durationSeconds: number) => TranscriptionUsage,
): CostEstimateLine {
	const providerId = settings.llmProvider;
	const model = selectedLlmModel(settings);
	const base = {
		label,
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
	return { ...base, usd: costFromUsage(pricing, usage(durationSeconds)) };
}

/**
 * How a run's LLM steps are priced: every one bills the configured LLM
 * provider, so pricing them needs the duration exactly when that provider's
 * model has a built-in rate at all.
 * @param settings - The run's settings snapshot
 */
function llmStepIsPriced(settings: AudioRecorderSettings): boolean {
	return (
		resolveLlmPricing(settings.llmProvider, selectedLlmModel(settings)) !==
		null
	);
}

/** How one billable step is labelled, priced, and gated. */
interface RunCostStep {
	/** Builds this step's line for the probed (or still unknown) duration. */
	line: (
		settings: AudioRecorderSettings,
		durationSeconds: number | null,
	) => CostEstimateLine;
	/** Whether this step runs at all for the given settings. */
	enabled: (settings: AudioRecorderSettings) => boolean;
	/** Whether pricing this step is duration-dependent (it is priced at all). */
	needsDuration: (settings: AudioRecorderSettings) => boolean;
}

/**
 * Every billable step of a run, in execution order. This table is the single
 * definition of what a run costs: the pre-run breakdown, the duration-probe
 * decision, and every dialog that prices one step in isolation all read it
 * through {@link estimateStepCost} or {@link buildCostEstimate}. Adding a
 * billable feature means adding one entry here, and it is then priced
 * identically everywhere - no consumer carries its own formula.
 */
const RUN_COST_STEPS: Record<RunCostStepId, RunCostStep> = {
	transcription: {
		line: transcriptionEstimateLine,
		// The audio is always transcribed; only the pass count varies.
		enabled: () => true,
		needsDuration: (settings) => {
			const pricing = resolveEnginePricing(
				settings.transcriptionProvider,
				selectedEngineModel(settings, settings.transcriptionProvider),
			);
			return pricing !== null && pricing.kind !== 'free';
		},
	},
	contextAgents: {
		line: (settings, durationSeconds) => {
			// A keyword-biased engine skips the topic and sentence agents, so it
			// runs fewer calls than a prompt-biased one; price what will run.
			const callCount =
				advancedBiasChannel(settings.transcriptionProvider) ===
				'keyterm'
					? CONTEXT_AGENT_CALL_ESTIMATE_KEYTERM
					: CONTEXT_AGENT_CALL_ESTIMATE_PROMPT;
			return llmLine(
				settings,
				durationSeconds,
				'Advanced context agents',
				(seconds) => estimatedContextAgentsUsage(seconds, callCount),
			);
		},
		enabled: advancedTwoPassWillRun,
		needsDuration: llmStepIsPriced,
	},
	postProcess: {
		line: (settings, durationSeconds) =>
			llmLine(
				settings,
				durationSeconds,
				`Post-processing (${LLM_TASK_LABELS[settings.llmPostProcessTask]})`,
				(seconds) => estimatedLlmUsage(settings, seconds),
			),
		enabled: (settings) => settings.llmPostProcessEnabled,
		needsDuration: llmStepIsPriced,
	},
	autoChapters: {
		line: (settings, durationSeconds) =>
			llmLine(settings, durationSeconds, 'Auto chapters', (seconds) =>
				estimatedChaptersUsage(settings, seconds),
			),
		enabled: autoChaptersAfterTranscribe,
		needsDuration: llmStepIsPriced,
	},
};

/** The steps in execution order, independent of which are enabled. */
const RUN_COST_STEP_ORDER: readonly RunCostStepId[] = [
	'transcription',
	'contextAgents',
	'postProcess',
	'autoChapters',
];

/**
 * Prices one billable step on its own. The single entry point for any caller
 * that shows the cost of a single step rather than of a whole run - the
 * on-demand chapter dialog, the post-run session accounting - so those numbers
 * are by construction the same ones the pre-run breakdown shows for that step.
 * The step is priced whether or not it is currently enabled, since a caller
 * asking for it is about to run it.
 * @param step - Which billable step to price
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Audio (or transcript) duration, null when unknown
 * @returns The step's estimate line, unpriced when there is no built-in rate
 */
export function estimateStepCost(
	step: RunCostStepId,
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimateLine {
	return RUN_COST_STEPS[step].line(settings, durationSeconds);
}

/**
 * The billable steps a run will actually perform, in execution order.
 * @param settings - The run's settings snapshot
 */
function enabledRunCostSteps(settings: AudioRecorderSettings): RunCostStepId[] {
	return RUN_COST_STEP_ORDER.filter((step) =>
		RUN_COST_STEPS[step].enabled(settings),
	);
}

/**
 * Builds the combined pre-run cost estimate: one line per enabled billable
 * step (see {@link RUN_COST_STEPS}), with the priced ones summed. Pure so the
 * numbers and wording are unit tested; the dialog only renders the result. The
 * breakdown follows the enabled features, so toggling the advanced two-pass
 * mode, post-processing, or auto chapters changes it.
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Probed audio duration, or null when unknown
 */
export function buildCostEstimate(
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): CostEstimate {
	const lines = enabledRunCostSteps(settings).map((step) =>
		estimateStepCost(step, settings, durationSeconds),
	);
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
 * priced: true when any billable step is priced and duration-dependent. False
 * when the only step is the free local engine and no LLM feature runs, letting
 * the dialog skip the audio probe entirely.
 * @param settings - The run's settings snapshot
 */
export function costEstimateNeedsDuration(
	settings: AudioRecorderSettings,
): boolean {
	return enabledRunCostSteps(settings).some((step) =>
		RUN_COST_STEPS[step].needsDuration(settings),
	);
}
