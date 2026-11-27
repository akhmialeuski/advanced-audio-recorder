/**
 * Pure extractors that pull the assistant text, and the token counts the
 * vendor billed, out of an OpenAI-style chat completion, an Anthropic
 * Messages response, or a Gemini generateContent response. Kept separate from
 * the network code so the response handling is unit tested.
 * @module transcription/llm/llmResponse
 */

import { isRecord } from '../providers/responseUtils';
import {
	GEMINI_FINISH_MAX_TOKENS,
	geminiCandidateText,
	geminiFinishReason,
	geminiUsage,
} from '../providers/geminiShared';

/** `finish_reason` of an OpenAI-style choice that stopped at its token limit. */
const OPENAI_FINISH_LENGTH = 'length';

/** `stop_reason` of an Anthropic message that stopped at its token limit. */
const ANTHROPIC_STOP_MAX_TOKENS = 'max_tokens';

/** Whose limit an answer stopped at, and how large it was. */
export interface OutputLimit {
	/** The engine's name, as the user knows it. */
	readonly label: string;
	/** The output token limit the request carried. */
	readonly maxTokens: number;
}

/**
 * An answer the vendor cut at its output token limit. Such an answer is the
 * start of the text and reads as the whole of it: a cleanup cut this way
 * replaced an hour-long transcript with its first nine minutes. Every LLM
 * client refuses the stop with this one error, so the notice that sizes the
 * limit reads the same counts whichever vendor answered.
 *
 * The message names the engine, the limit and where it is set, and the counts
 * the vendor reported ride along, so a caller that knows how long the answer
 * should have been can say how large the limit has to be. The vendor bills
 * the refused answer like a finished one, so its counts are also what the
 * session total records for it.
 */
export class LlmAnswerTruncatedError extends Error {
	/**
	 * What the vendor billed for the refused answer, absent when it reported
	 * nothing, as the usage of a finished completion is.
	 */
	readonly usage: LlmUsage | undefined;
	/** Tokens of the prompt, when the vendor reported them. */
	readonly inputTokens: number | undefined;

	constructor(
		limit: OutputLimit,
		usage: LlmUsage,
		/**
		 * Tokens of the limit the model spent on reasoning before it answered,
		 * when the vendor reported them. They count against the same limit:
		 * `deepseek-flash` spent 17 552 of 50 000 on one cleanup.
		 */
		readonly reasoningTokens: number | undefined,
	) {
		super(
			`${limit.label} stopped at its output token limit of ` +
				`${String(limit.maxTokens)}` +
				(reasoningTokens
					? `, ${String(reasoningTokens)} of them spent on reasoning`
					: '') +
				', so the answer is incomplete. Raise Max output tokens on ' +
				`the ${limit.label} page under Engines, or choose a model ` +
				'with a larger output limit.',
		);
		this.name = 'LlmAnswerTruncatedError';
		this.usage = Object.keys(usage).length > 0 ? usage : undefined;
		this.inputTokens = usage.inputTokens;
	}
}

/**
 * Refuses an OpenAI Chat Completions response whose first choice stopped at
 * the output token limit.
 * @param body - Parsed JSON response
 * @param limit - The limit the request carried, and whose it is
 * @throws {LlmAnswerTruncatedError} When the answer is incomplete
 */
export function assertOpenAiNotTruncated(
	body: unknown,
	limit: OutputLimit,
): void {
	const first: unknown =
		isRecord(body) && Array.isArray(body.choices)
			? body.choices[0]
			: undefined;
	if (!isRecord(first) || first.finish_reason !== OPENAI_FINISH_LENGTH) {
		return;
	}
	const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
	const details = isRecord(usage.completion_tokens_details)
		? usage.completion_tokens_details
		: {};
	throw new LlmAnswerTruncatedError(
		limit,
		extractOpenAiUsage(body),
		tokenCount(details.reasoning_tokens),
	);
}

/**
 * Refuses an Anthropic Messages response that stopped at the output token
 * limit.
 * @param body - Parsed JSON response
 * @param limit - The limit the request carried, and whose it is
 * @throws {LlmAnswerTruncatedError} When the answer is incomplete
 */
export function assertAnthropicNotTruncated(
	body: unknown,
	limit: OutputLimit,
): void {
	if (!isRecord(body) || body.stop_reason !== ANTHROPIC_STOP_MAX_TOKENS) {
		return;
	}
	throw new LlmAnswerTruncatedError(
		limit,
		extractAnthropicUsage(body),
		undefined,
	);
}

/**
 * Refuses a Gemini `generateContent` response that stopped at the output
 * token limit. Gemini counts its thinking against the same limit, as
 * `thoughtsTokenCount`.
 * @param body - Parsed JSON response
 * @param limit - The limit the request carried, and whose it is
 * @throws {LlmAnswerTruncatedError} When the answer is incomplete
 */
export function assertGeminiAnswerNotTruncated(
	body: unknown,
	limit: OutputLimit,
): void {
	if (geminiFinishReason(body) !== GEMINI_FINISH_MAX_TOKENS) {
		return;
	}
	throw new LlmAnswerTruncatedError(
		limit,
		extractGeminiUsage(body),
		geminiUsage(body).thoughtsTokenCount,
	);
}

/**
 * Extracts the assistant message text from an OpenAI Chat Completions
 * (`chat/completions`) response.
 * @param body - Parsed JSON response
 * @returns The message content, or empty string when absent
 */
export function extractOpenAiText(body: unknown): string {
	if (!isRecord(body)) {
		return '';
	}
	const choices = body.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return '';
	}
	// Array.isArray narrows the element to `any`; pin it back to `unknown`
	// so the record guards below stay type-safe.
	const first: unknown = choices[0];
	if (!isRecord(first) || !isRecord(first.message)) {
		return '';
	}
	const content = first.message.content;
	return typeof content === 'string' ? content.trim() : '';
}

/**
 * Extracts the text from an Anthropic Messages response by concatenating
 * the `text` blocks in `content`.
 * @param body - Parsed JSON response
 * @returns The combined text, or empty string when absent
 */
export function extractAnthropicText(body: unknown): string {
	if (!isRecord(body)) {
		return '';
	}
	const content = body.content;
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.join('').trim();
}

/**
 * Extracts the text from a Gemini `generateContent` response by concatenating
 * the `text` parts of the first candidate.
 * @param body - Parsed JSON response
 * @returns The combined text, or empty string when absent
 */
export function extractGeminiText(body: unknown): string {
	return geminiCandidateText(body).trim();
}

/**
 * Token counts a vendor reported for one completion. Every field is optional:
 * a vendor that reports nothing yields an empty object, which is what tells a
 * caller to fall back to an estimate rather than bill a false zero.
 */
export interface LlmUsage {
	/** Prompt tokens the vendor billed. */
	inputTokens?: number;
	/**
	 * Every token billed at the output rate, reasoning included.
	 *
	 * One total rather than a total and a reasoning breakdown, because the
	 * vendors disagree about which of the two their own reasoning count is:
	 * OpenAI reports it inside `completion_tokens`, Gemini reports it beside
	 * `candidatesTokenCount` and bills their sum. A caller holding both fields
	 * cannot combine them without knowing which vendor it is talking to, and
	 * the extractor that read the response already does. So each extractor
	 * normalises to this one number and nothing downstream adds anything to it.
	 */
	outputTokens?: number;
}

/** Reads a finite non-negative token count, or undefined. */
function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/**
 * Extracts the token counts from an OpenAI Chat Completions response. The
 * body was parsed for the text anyway; nothing extra is requested for this.
 * @param body - Parsed JSON response
 * @returns What the vendor reported, empty when it reported nothing
 */
export function extractOpenAiUsage(body: unknown): LlmUsage {
	if (!isRecord(body) || !isRecord(body.usage)) {
		return {};
	}
	const usage = body.usage;
	// `completion_tokens` is already the whole output charge: OpenAI documents
	// reasoning tokens as billed as output tokens and reports them as a
	// breakdown of that total under `completion_tokens_details`, not beside it.
	// Reading the breakdown out and adding it back would bill a reasoning
	// model's thinking twice, which on those models is most of the charge.
	return dropUndefined({
		inputTokens: tokenCount(usage.prompt_tokens),
		outputTokens: tokenCount(usage.completion_tokens),
	});
}

/**
 * Extracts the token counts from an Anthropic Messages response.
 * @param body - Parsed JSON response
 * @returns What the vendor reported, empty when it reported nothing
 */
export function extractAnthropicUsage(body: unknown): LlmUsage {
	if (!isRecord(body) || !isRecord(body.usage)) {
		return {};
	}
	return dropUndefined({
		inputTokens: tokenCount(body.usage.input_tokens),
		outputTokens: tokenCount(body.usage.output_tokens),
	});
}

/**
 * Drops the fields the vendor did not report, so an absent count stays
 * absent rather than becoming an explicit undefined the pricing would have
 * to tell apart from a real zero.
 * @param counts - Counts read from a response, with the gaps still in them
 * @returns The same counts with the missing ones removed
 */
function dropUndefined(counts: {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
}): LlmUsage {
	return {
		...(counts.inputTokens === undefined
			? {}
			: { inputTokens: counts.inputTokens }),
		...(counts.outputTokens === undefined
			? {}
			: { outputTokens: counts.outputTokens }),
	};
}

/**
 * Maps Gemini's `usageMetadata` onto the billing counts.
 *
 * Gemini bills thinking on top of the candidates rather than inside them, so
 * the two are added here, in the one place that knows it is reading a Gemini
 * response. The same addition on an OpenAI body would charge the reasoning
 * twice, which is why it lives in the extractor and not in the pricing.
 * @param body - Parsed JSON response
 * @returns What the vendor reported, empty when it reported nothing
 */
export function extractGeminiUsage(body: unknown): LlmUsage {
	const counts = geminiUsage(body);
	const output =
		counts.candidatesTokenCount === undefined &&
		counts.thoughtsTokenCount === undefined
			? undefined
			: (counts.candidatesTokenCount ?? 0) +
				(counts.thoughtsTokenCount ?? 0);
	return dropUndefined({
		inputTokens: counts.promptTokenCount,
		outputTokens: output,
	});
}
