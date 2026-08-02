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
import { LLM_TASK_LABELS } from '../settings/labels';
import { llmVendor, selectedLlmVendor } from './llm/vendors';
import { vendorMaxTokens } from '../providers/providers';
import {
	matchRate,
	selectedTranscriptionEngine,
	transcriptionEngine,
	type EnginePricing,
} from './providers/engines';

export type { EnginePricing } from './providers/engines';
import type { LlmTask } from './llmPostProcess';
import type { TranscriptionUsage } from './TranscriptTypes';

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
const ESTIMATED_OUTPUT_TOKENS_PER_SECOND = 8;

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
const CONTEXT_AGENT_CALL_ESTIMATE_PROMPT = 6;
const CONTEXT_AGENT_CALL_ESTIMATE_KEYTERM = 4;

/**
 * Each context agent reads a condensed sample of the first draft, which the
 * pipeline caps well below a long transcript (about 12k characters, roughly
 * 3000 tokens), and emits a short list or sentence. Representative per-call
 * sizes for the estimate, so the agents' cost stays roughly flat per run
 * instead of scaling with the whole recording.
 */
const CONTEXT_AGENT_INPUT_TOKENS = 3000;
const CONTEXT_AGENT_OUTPUT_TOKENS = 200;

/** Label shared by the context-agents breakdown line and its per-call price. */
const CONTEXT_AGENTS_ESTIMATE_LABEL = 'Advanced context agents';

/**
 * Auto chapters read the transcript and emit a short list of titled
 * timestamps, so the output is a small fraction of the input.
 */
const CHAPTERS_OUTPUT_TOKEN_RATIO = 0.1;

/**
 * Resolves the pricing for a transcription engine and model, from the engine's
 * own rate table. Model ids are free-form user-editable strings, so an id no
 * built-in rate matches yields null ("no estimate") instead of a wrong number.
 * @param engineId - Transcription engine id
 * @param model - Selected model id for that engine
 */
export function resolveEnginePricing(
	engineId: TranscriptionProviderId,
	model: string,
): EnginePricing | null {
	return transcriptionEngine(engineId).pricing(model);
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
	const rate = matchRate(llmVendor(providerId).rates, model);
	if (rate === undefined) {
		return null;
	}
	return {
		kind: 'perToken',
		usdPerMillionAudioInput: rate.input,
		usdPerMillionTextInput: rate.input,
		usdPerMillionOutput: rate.output,
	};
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
	return transcriptionEngine(engineId).model(settings);
}

/**
 * Returns the model id the settings select for the current LLM provider.
 * @param settings - Plugin settings
 */
export function selectedLlmModel(settings: AudioRecorderSettings): string {
	return selectedLlmVendor(settings).settings.model(settings);
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
		vendorMaxTokens(settings, settings.llmProvider),
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
		vendorMaxTokens(settings, settings.llmProvider),
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
	// The sub-cent form applies to small *positive* amounts. Testing `usd <
	// 0.005` alone also caught negatives, so a -$5.00 would have rendered as
	// "<$0.01" - unreachable today, but the kind of silent wrong number this
	// module exists to avoid.
	if (usd > 0 && usd < 0.005) {
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
	pricingUrl?: string | undefined;
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
	const engine = selectedTranscriptionEngine(settings);
	const model = engine.model(settings);
	const providerName = engine.label;
	const pricingUrl = engine.pricingUrl;
	const passes = transcriptionPasses(settings);
	const label =
		passes > 1
			? `Transcription (${String(passes)} passes)`
			: 'Transcription';
	const base = { label, providerName, model, pricingUrl };
	const pricing = engine.pricing(model);
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
	const vendor = selectedLlmVendor(settings);
	const model = vendor.settings.model(settings);
	const base = {
		label,
		providerName: vendor.label,
		model,
		pricingUrl: vendor.pricingUrl,
	};
	const pricing = resolveLlmPricing(vendor.id, model);
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
			const engine = selectedTranscriptionEngine(settings);
			const pricing = engine.pricing(engine.model(settings));
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
				CONTEXT_AGENTS_ESTIMATE_LABEL,
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
 * Prices one LLM call of a step, which is the unit {@link LlmCostSink} records:
 * `recordLlmCall` fires once per completed call, so it must be given the cost of
 * that one call, not of the whole step.
 *
 * For post-processing and auto chapters a run makes exactly one call, so a
 * call's cost is the step's cost - {@link estimateStepCost} answers directly.
 * The advanced context agents are the exception: the step is a team of
 * `callCount` sequential calls, so its {@link estimateStepCost} line prices the
 * whole team. Charging that per call would multiply the team cost by the number
 * of calls in the session total. This prices one member instead (callCount = 1),
 * so the per-call amounts summed across the run add back up to the team line the
 * pre-run breakdown shows.
 * @param step - Which billable step made the call
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Material extent in seconds, null when unknown
 * @returns The single call's cost in USD, or null when it cannot be priced
 */
export function estimateLlmCallCost(
	step: RunCostStepId,
	settings: AudioRecorderSettings,
	durationSeconds: number | null,
): number | null {
	if (step === 'contextAgents') {
		return llmLine(
			settings,
			durationSeconds,
			CONTEXT_AGENTS_ESTIMATE_LABEL,
			(seconds) => estimatedContextAgentsUsage(seconds, 1),
		).usd;
	}
	return estimateStepCost(step, settings, durationSeconds).usd;
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
