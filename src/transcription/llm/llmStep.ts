/**
 * One accounted LLM call.
 *
 * Three places drive the LLM - transcript post-processing, the advanced
 * two-pass context agents, and auto chapters - and each used to call
 * `complete()` directly. That left the spend invisible: LLM providers report no
 * usage, so nothing outside the pre-run estimate knew a call had happened, and
 * the session counter tracked only the transcription engine. The dialog papered
 * over it with a note saying the LLM steps "are not added to the session
 * total".
 *
 * Running every call through here fixes that at the source: the step names
 * itself, the shared cost model prices it (the same {@link estimateStepCost}
 * the pre-run breakdown uses, so the estimate and the accounting cannot
 * disagree), and the result is reported to whatever sink the caller wired in.
 *
 * Error handling stays with the caller on purpose - the three steps want
 * different things from a failure (post-processing falls back to the raw
 * transcript, an agent degrades its own stage, chapters report and stop) - so
 * this wrapper never swallows or reshapes an error.
 * @module transcription/llm/llmStep
 */

import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import { estimateStepCost, type RunCostStepId } from '../costs';
import type { LlmPrompt } from '../llmPostProcess';
import type { LlmCompleteOptions, LlmProvider } from './LlmProvider';

/**
 * Receives the estimated cost of each LLM call a run makes. Implemented by the
 * session cost tracker; absent when a caller does not account spending.
 */
export interface LlmCostSink {
	/**
	 * Records one completed LLM call.
	 * @param providerId - The vendor billed for it
	 * @param step - Which billable step made the call
	 * @param usd - Estimated cost, or null when the model has no built-in rate
	 */
	recordLlmCall(
		providerId: string,
		step: RunCostStepId,
		usd: number | null,
	): void;
}

/** What one accounted LLM call needs. */
export interface LlmStepRequest {
	/** Which billable step this call belongs to. */
	step: RunCostStepId;
	/** The provider to call. */
	llm: LlmProvider;
	/** System + user prompt. */
	prompt: LlmPrompt;
	/** Maximum output tokens. */
	maxTokens: number;
	/** The run's settings, used to price the step. */
	settings: AudioRecorderSettings;
	/**
	 * Extent of the material the step reads, in seconds, which is what the
	 * cost model sizes the call from. Null when it is not known, in which case
	 * the call is recorded as unpriced rather than as free.
	 */
	durationSeconds: number | null;
	/** Optional generation options (temperature). */
	options?: LlmCompleteOptions;
	/** Where to report the call's estimated cost. */
	costSink?: LlmCostSink;
}

/**
 * Completes a prompt and accounts the call.
 *
 * The cost is an estimate by necessity: no LLM vendor returns usage through
 * the endpoints this plugin calls, so there is nothing to price from after the
 * fact. Using the same step model as the pre-run breakdown at least means the
 * figure the user was shown beforehand is the figure that lands in the session
 * total.
 * @param request - The call and how to account it
 * @returns The assistant's text
 */
export async function runLlmStep(request: LlmStepRequest): Promise<string> {
	const text = await request.llm.complete(
		request.prompt,
		request.maxTokens,
		request.options,
	);
	// Reported only after the call returns: a failed call was not billed, and
	// the caller's own error handling decides what happens next.
	request.costSink?.recordLlmCall(
		request.llm.id,
		request.step,
		estimateStepCost(
			request.step,
			request.settings,
			request.durationSeconds,
		).usd,
	);
	return text;
}
