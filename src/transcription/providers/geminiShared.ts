/**
 * Shared parsing of a Gemini `generateContent` response, used by both the
 * transcription mapper and the LLM text extractor. Centralizes the candidate
 * narrowing so a fix to the response shape applies to both consumers, and
 * exposes the finish reason so callers can detect a truncated response.
 * @module transcription/providers/geminiShared
 */

import { isRecord } from './responseUtils';

/** Finish reason set when the model stops because it hit the output token cap. */
export const GEMINI_FINISH_MAX_TOKENS = 'MAX_TOKENS';

/**
 * Concatenates the `text` parts of the first candidate's content, or returns
 * '' when the response has no usable candidate. Does not trim — callers that
 * need a trimmed string apply it themselves.
 * @param body - Parsed JSON `generateContent` response
 * @returns The combined candidate text, or '' when absent
 */
export function geminiCandidateText(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.candidates)) {
		return '';
	}
	const first: unknown = body.candidates[0];
	if (
		!isRecord(first) ||
		!isRecord(first.content) ||
		!Array.isArray(first.content.parts)
	) {
		return '';
	}
	const parts: string[] = [];
	for (const part of first.content.parts) {
		if (isRecord(part) && typeof part.text === 'string') {
			parts.push(part.text);
		}
	}
	return parts.join('');
}

/**
 * Reads the first candidate's `finishReason`, or undefined when absent.
 * @param body - Parsed JSON `generateContent` response
 * @returns The finish reason string, or undefined
 */
export function geminiFinishReason(body: unknown): string | undefined {
	if (!isRecord(body) || !Array.isArray(body.candidates)) {
		return undefined;
	}
	const first: unknown = body.candidates[0];
	if (!isRecord(first) || typeof first.finishReason !== 'string') {
		return undefined;
	}
	return first.finishReason;
}

/**
 * Throws a clear, actionable error when a Gemini response was cut off because
 * it reached the output token limit. Gemini 2.5 models also spend part of the
 * output budget on internal "thinking", so a low limit can truncate or empty
 * the usable text; surfacing this beats silently returning a partial transcript
 * or an empty post-processing result.
 * @param body - Parsed JSON `generateContent` response
 */
export function assertGeminiNotTruncated(body: unknown): void {
	if (geminiFinishReason(body) === GEMINI_FINISH_MAX_TOKENS) {
		throw new Error(
			'Gemini stopped because it reached its output token limit, so the ' +
				'response is incomplete. Use a shorter input, raise the max ' +
				'output tokens, or pick a model with a larger output limit.',
		);
	}
}
