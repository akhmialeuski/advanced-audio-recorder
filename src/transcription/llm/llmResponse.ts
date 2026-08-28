/**
 * Pure extractors that pull the assistant text, and the token counts the
 * vendor billed, out of an OpenAI-style chat completion, an Anthropic
 * Messages response, or a Gemini generateContent response. Kept separate from
 * the network code so the response handling is unit tested.
 * @module transcription/llm/llmResponse
 */

import { isRecord } from '../providers/responseUtils';
import { geminiCandidateText, geminiUsage } from '../providers/geminiShared';

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
	/** Completion tokens the vendor billed. */
	outputTokens?: number;
	/** Reasoning tokens, billed at the output rate where a vendor reports them. */
	reasoningTokens?: number;
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
	const details = isRecord(usage.completion_tokens_details)
		? usage.completion_tokens_details
		: {};
	return dropUndefined({
		inputTokens: tokenCount(usage.prompt_tokens),
		outputTokens: tokenCount(usage.completion_tokens),
		reasoningTokens: tokenCount(details.reasoning_tokens),
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
	reasoningTokens?: number | undefined;
}): LlmUsage {
	return {
		...(counts.inputTokens === undefined
			? {}
			: { inputTokens: counts.inputTokens }),
		...(counts.outputTokens === undefined
			? {}
			: { outputTokens: counts.outputTokens }),
		...(counts.reasoningTokens === undefined
			? {}
			: { reasoningTokens: counts.reasoningTokens }),
	};
}

/**
 * Maps Gemini's `usageMetadata` onto the billing counts. Thinking tokens are
 * reported separately by Gemini and billed at the output rate, so they are
 * carried through rather than folded in here.
 * @param body - Parsed JSON response
 * @returns What the vendor reported, empty when it reported nothing
 */
export function extractGeminiUsage(body: unknown): LlmUsage {
	const counts = geminiUsage(body);
	return dropUndefined({
		inputTokens: counts.promptTokenCount,
		outputTokens: counts.candidatesTokenCount,
		reasoningTokens: counts.thoughtsTokenCount,
	});
}
