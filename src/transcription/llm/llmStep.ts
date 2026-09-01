/**
 * One accounted LLM call.
 *
 * Three places drive the LLM - transcript post-processing, the advanced
 * two-pass context agents, and auto chapters - and each used to call
 * `complete()` directly. That left the spend invisible: nothing outside the
 * pre-run estimate knew a call had happened, and the session counter tracked
 * only the transcription engine. The dialog papered over it with a note saying
 * the LLM steps "are not added to the session total".
 *
 * Running every call through here fixes that at the source: the step names
 * itself, the call is priced, and the result is reported to whatever sink the
 * caller wired in.
 *
 * The price comes from what the vendor reported. OpenAI, Anthropic, and
 * Gemini all return token counts in the same body the text is read from, so a
 * completed call is billed at what it actually cost. The estimate
 * ({@link estimateLlmCallCost}, derived from the same step model the pre-run
 * breakdown uses) is the fallback for a vendor that reported nothing and for a
 * model with no built-in rate, and a call priced that way is marked so the
 * session total can say how much of it is estimated. Pricing is per call, so a
 * step that makes several calls (the context agents) charges each call one
 * member's share rather than the whole team's cost.
 *
 * Error handling stays with the caller on purpose - the three steps want
 * different things from a failure (post-processing falls back to the raw
 * transcript, an agent degrades its own stage, chapters report and stop) - so
 * this wrapper never swallows or reshapes an error.
 * @module transcription/llm/llmStep
 */

import type { AudioRecorderSettings } from '../../settings/settingsSchema';
import {
	estimateLlmCallCost,
	llmCallCostFromUsage,
	type RunCostStepId,
} from '../costs';
import type { LlmUsage } from './llmResponse';
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
	 * @param usd - Cost in USD, or null when it could not be priced
	 * @param estimated - True when the figure came from the step model rather
	 *   than from token counts the vendor reported
	 */
	recordLlmCall(
		providerId: string,
		step: RunCostStepId,
		usd: number | null,
		estimated: boolean,
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
	/**
	 * Aborts the call when the run it belongs to is cancelled.
	 *
	 * Carried on the request rather than inside {@link LlmStepRequest.options}
	 * so a caller cannot forget it: cancellation used to reach the
	 * transcription request alone, and every LLM step - post-processing, the
	 * context agents, chapter generation - ran to its own five-minute timeout
	 * after the user pressed Cancel, and was billed in full.
	 */
	signal?: AbortSignal | undefined;
	/** Where to report the call's estimated cost. */
	costSink?: LlmCostSink | undefined;
}

/**
 * Completes a prompt and accounts the call.
 * @param request - The call and how to account it
 * @returns The assistant's text
 */
export async function runLlmStep(request: LlmStepRequest): Promise<string> {
	// A run cancelled between two calls must not pay for the next one, so the
	// spend is refused before it starts rather than aborted mid-flight.
	request.signal?.throwIfAborted();
	const completion = await request.llm.complete(
		request.prompt,
		request.maxTokens,
		request.signal
			? { ...request.options, signal: request.signal }
			: request.options,
	);
	// Reported only after the call returns: a failed call was not billed, and
	// the caller's own error handling decides what happens next. Priced per
	// call, not per step: a step that makes several calls (the context agents)
	// must not charge each call the whole team's cost. Priced only when
	// something is accounting, which is what the optional chaining used to do
	// for free by never evaluating the argument.
	if (request.costSink) {
		const cost = billedCost(request, completion.usage);
		request.costSink.recordLlmCall(
			request.llm.id,
			request.step,
			cost.usd,
			cost.estimated,
		);
	}
	return completion.text;
}

/**
 * What to record for one completed call: the vendor's own token counts when
 * it reported any the pricing can use, and the step estimate otherwise.
 * @param request - The call being accounted
 * @param usage - Token counts the vendor reported, if any
 * @returns The cost to record and whether it is an estimate
 */
function billedCost(
	request: LlmStepRequest,
	usage: LlmUsage | undefined,
): { usd: number | null; estimated: boolean } {
	if (usage) {
		const reported = llmCallCostFromUsage(
			request.llm.id,
			request.settings,
			usage,
		);
		if (reported !== null) {
			return { usd: reported, estimated: false };
		}
	}
	return {
		usd: estimateLlmCallCost(
			request.step,
			request.settings,
			request.durationSeconds,
		),
		estimated: true,
	};
}
