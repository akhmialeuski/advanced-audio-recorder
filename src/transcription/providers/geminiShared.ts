/**
 * Shared Gemini `generateContent` helpers used by both the transcription
 * provider and the LLM provider: request building (endpoint URL, thinking
 * config) and response parsing (candidate text, finish reason, and guards that
 * turn a truncated or blocked response into a clear error). Centralizing this
 * keeps a fix to the request or response shape applied to both consumers.
 * @module transcription/providers/geminiShared
 */

import { isRecord } from './responseUtils';
import { trimTrailingSlash } from '../httpClient';
import {
	GEMINI_PRO_MIN_THINKING_BUDGET,
	GEMINI_THINKING_BUDGET_OFF,
} from '../../constants';
import { TranscriptTruncatedError } from '../transcriptionErrors';
import type { TranscriptionUsage } from '../TranscriptTypes';

/** Finish reason set when the model stops because it hit the output token cap. */
export const GEMINI_FINISH_MAX_TOKENS = 'MAX_TOKENS';

/**
 * Substring that identifies a Gemini Pro model id. Pro cannot disable thinking
 * (it rejects a 0 budget), so it is given the minimum budget instead.
 */
const GEMINI_PRO_MODEL_MARKER = 'pro';

/**
 * Substring that identifies a model accepting the `thinkingBudget` parameter.
 * Thinking budgets are a Gemini 2.5-series feature: 2.0 and earlier reject a
 * `thinkingConfig` outright, and Gemini 3 controls reasoning with a different
 * parameter. Gating on this marker keeps the config off requests to models that
 * would 400 on it.
 */
const GEMINI_THINKING_BUDGET_MODEL_MARKER = '2.5';

/**
 * Terminal finish reasons that mean the model produced no usable output (a
 * safety/recitation/policy stop rather than a normal completion). MAX_TOKENS is
 * handled separately by {@link assertGeminiNotTruncated}.
 */
export const GEMINI_BLOCKING_FINISH_REASONS: ReadonlySet<string> = new Set([
	'SAFETY',
	'RECITATION',
	'BLOCKLIST',
	'PROHIBITED_CONTENT',
	'SPII',
]);

/**
 * Builds the `generateContent` endpoint URL for a model. The base URL carries
 * no version segment, so the `/v1beta/models/{model}:generateContent` path is
 * appended here.
 * @param baseUrl - Gemini base URL (no version segment)
 * @param model - Gemini model id
 * @returns The full generateContent URL
 */
export function geminiGenerateContentUrl(
	baseUrl: string,
	model: string,
): string {
	return `${trimTrailingSlash(baseUrl)}/v1beta/models/${model}:generateContent`;
}

/**
 * Builds the `thinkingConfig` for a deterministic Gemini request (transcription
 * or post-processing), neither of which benefits from chain-of-thought. Returns
 * undefined for a model that does not accept a thinking budget (2.0 and
 * earlier), so the caller omits the field rather than sending one the API
 * rejects. For a 2.5 model it turns thinking off; Gemini 2.5 Pro cannot disable
 * it and rejects a 0 budget, so it gets the minimum supported budget instead.
 * @param model - Gemini model id
 * @returns A thinkingConfig object, or undefined when the model has no thinking budget
 */
export function geminiThinkingConfig(
	model: string,
): { thinkingBudget: number } | undefined {
	const lower = model.toLowerCase();
	if (!lower.includes(GEMINI_THINKING_BUDGET_MODEL_MARKER)) {
		return undefined;
	}
	return {
		thinkingBudget: lower.includes(GEMINI_PRO_MODEL_MARKER)
			? GEMINI_PRO_MIN_THINKING_BUDGET
			: GEMINI_THINKING_BUDGET_OFF,
	};
}

/**
 * Concatenates the `text` parts of the first candidate's content, or returns
 * '' when the response has no usable candidate. Does not trim - callers that
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
 * Token counts Gemini reports in `usageMetadata`. Every field is optional: a
 * response may omit usage data, and only a thinking model reports
 * `thoughtsTokenCount`, so callers treat a missing count as "unknown" rather
 * than zero.
 */
export interface GeminiUsage {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
	thoughtsTokenCount?: number;
	/**
	 * Audio-modality portion of `promptTokenCount`, summed from
	 * `promptTokensDetails`. Audio input is billed at a higher rate than the
	 * text prompt, so keeping the split lets the cost model price each
	 * modality correctly. Undefined when the response omits the breakdown.
	 */
	promptAudioTokenCount?: number;
}

/** Modality string Gemini uses for audio input in `promptTokensDetails`. */
const GEMINI_AUDIO_MODALITY = 'AUDIO';

/**
 * Sums the audio-modality token count from Gemini's `promptTokensDetails`
 * array, when present. Returns undefined when the breakdown is absent so a
 * caller can tell "no split reported" from a real zero.
 * @param meta - The `usageMetadata` record
 */
function promptAudioTokens(meta: Record<string, unknown>): number | undefined {
	const details = meta.promptTokensDetails;
	if (!Array.isArray(details)) {
		return undefined;
	}
	let audio: number | undefined;
	for (const detail of details) {
		if (
			isRecord(detail) &&
			detail.modality === GEMINI_AUDIO_MODALITY &&
			typeof detail.tokenCount === 'number' &&
			Number.isFinite(detail.tokenCount)
		) {
			audio = (audio ?? 0) + detail.tokenCount;
		}
	}
	return audio;
}

/**
 * Reads the `usageMetadata` token counts from a `generateContent` response,
 * keeping only finite numbers. Returns an empty object when usage is absent so
 * a caller can distinguish "not reported" from a real zero.
 * @param body - Parsed JSON `generateContent` response
 * @returns The reported token counts (absent fields stay undefined)
 */
export function geminiUsage(body: unknown): GeminiUsage {
	if (!isRecord(body) || !isRecord(body.usageMetadata)) {
		return {};
	}
	const meta = body.usageMetadata;
	const finite = (value: unknown): number | undefined =>
		typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	return {
		promptTokenCount: finite(meta.promptTokenCount),
		candidatesTokenCount: finite(meta.candidatesTokenCount),
		totalTokenCount: finite(meta.totalTokenCount),
		thoughtsTokenCount: finite(meta.thoughtsTokenCount),
		promptAudioTokenCount: promptAudioTokens(meta),
	};
}

/**
 * Maps Gemini's `usageMetadata` token counts to billing usage: prompt
 * tokens (which include the audio) as input with the audio portion split
 * out for modality pricing, and candidate plus thinking tokens as output
 * (both billed at the output rate). Returns undefined when the response
 * reported no counts at all, so a caller can fall back to an estimate.
 *
 * This mapper only ever runs for a transcription request, whose prompt is
 * the recording plus a short instruction and so is audio-dominated. When
 * Gemini omits the modality breakdown, the whole prompt is attributed to
 * audio rather than left unsplit: an unsplit prompt is billed by the cost
 * model at the cheaper text rate, which for a transcription under-counts
 * the audio (billed higher, and the bulk of the prompt) far more than
 * assuming all-audio over-counts the tiny instruction.
 * @param body - Parsed JSON `generateContent` response
 */
export function usageFromGemini(body: unknown): TranscriptionUsage | undefined {
	const counts = geminiUsage(body);
	if (
		counts.promptTokenCount === undefined &&
		counts.candidatesTokenCount === undefined &&
		counts.thoughtsTokenCount === undefined
	) {
		return undefined;
	}
	const output =
		(counts.candidatesTokenCount ?? 0) + (counts.thoughtsTokenCount ?? 0);
	const audioInput = counts.promptAudioTokenCount ?? counts.promptTokenCount;
	return {
		...(counts.promptTokenCount !== undefined
			? { inputTokens: counts.promptTokenCount }
			: {}),
		...(audioInput !== undefined ? { audioInputTokens: audioInput } : {}),
		outputTokens: output,
	};
}

/**
 * Formats the reported token usage as a parenthetical for the truncation error,
 * e.g. ` (generated 65536 output tokens, 78000 total)`. Returns '' when the
 * response carried no usable counts, so the message degrades cleanly when the
 * provider omits usage data.
 * @param body - Parsed JSON `generateContent` response
 * @returns A leading-space parenthetical, or '' when no counts are present
 */
function geminiUsageDetail(body: unknown): string {
	const usage = geminiUsage(body);
	const parts: string[] = [];
	if (usage.candidatesTokenCount !== undefined) {
		// Gemini reports thinking tokens separately from candidatesTokenCount
		// (billing is the sum of the two), so they are added to, not contained
		// within, the output-token count - hence "plus", not "including".
		const thinking =
			usage.thoughtsTokenCount && usage.thoughtsTokenCount > 0
				? ` plus ${String(usage.thoughtsTokenCount)} on thinking`
				: '';
		parts.push(
			`generated ${String(usage.candidatesTokenCount)} output tokens${thinking}`,
		);
	}
	if (usage.totalTokenCount !== undefined) {
		parts.push(`${String(usage.totalTokenCount)} total`);
	}
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Throws a clear, actionable error when a Gemini response was cut off because
 * it reached the output token limit. Gemini 2.5 models also spend part of the
 * output budget on internal "thinking", so a low limit can truncate or empty
 * the usable text; surfacing this beats silently returning a partial transcript
 * or an empty post-processing result. The message embeds the reported token
 * usage (output and total counts) so the user sees how far the response ran
 * before hitting the cap. The caller supplies the `remedy` because the
 * actionable advice differs by task: the LLM path can raise the max-tokens
 * setting, whereas transcription has no such control and must shorten the input
 * or change model.
 * @param body - Parsed JSON `generateContent` response
 * @param remedy - Task-specific sentence appended to the error
 */
export function assertGeminiNotTruncated(body: unknown, remedy: string): void {
	if (geminiFinishReason(body) === GEMINI_FINISH_MAX_TOKENS) {
		// The truncated response was still billed for its prompt (audio) and
		// the output tokens it produced, so carry that usage on the error:
		// the run subdivides and retries, and the discarded parent request
		// must still count toward the run's cost.
		throw new TranscriptTruncatedError(
			'Gemini stopped because it reached its output token limit' +
				`${geminiUsageDetail(body)}, so the response is incomplete. ` +
				remedy,
			usageFromGemini(body),
		);
	}
}

/**
 * Reads `promptFeedback.blockReason`, set when Gemini rejects the request
 * before generating (e.g. a safety filter on the prompt or audio).
 * @param body - Parsed JSON `generateContent` response
 * @returns The block reason string, or undefined when not blocked
 */
function geminiPromptBlockReason(body: unknown): string | undefined {
	if (!isRecord(body) || !isRecord(body.promptFeedback)) {
		return undefined;
	}
	const reason = body.promptFeedback.blockReason;
	return typeof reason === 'string' ? reason : undefined;
}

/**
 * Throws a clear error when Gemini returned no usable content for a terminal
 * reason other than truncation - a prompt-level block or a safety/recitation/
 * policy stop. Without this such a response maps to an empty transcript or an
 * empty post-processing result with no explanation. Pair with
 * {@link assertGeminiNotTruncated}, which covers the MAX_TOKENS case.
 * @param body - Parsed JSON `generateContent` response
 */
export function assertGeminiNotBlocked(body: unknown): void {
	const blockReason = geminiPromptBlockReason(body);
	if (blockReason) {
		throw new Error(
			`Gemini blocked the request (${blockReason}) and returned no ` +
				'output. Adjust the input or check the provider content policy.',
		);
	}
	const reason = geminiFinishReason(body);
	if (reason && GEMINI_BLOCKING_FINISH_REASONS.has(reason)) {
		throw new Error(
			`Gemini stopped without usable output (${reason}). Adjust the ` +
				'input or check the provider content policy.',
		);
	}
}
