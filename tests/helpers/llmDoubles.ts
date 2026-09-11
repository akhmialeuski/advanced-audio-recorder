/**
 * Helpers for the LLM provider doubles the transcription tests build. A
 * provider answers with text and, where the vendor reported them, the token
 * counts it billed; these two wrap that shape so a test that only cares about
 * the text says so, and a test about the accounting says what was billed.
 * @module tests/helpers/llmDoubles
 */

import { LLM_PROVIDER_IDS } from 'src/constants';
import type {
	LlmCompletion,
	LlmVendorIdentity,
} from 'src/transcription/llm/LlmProvider';
import type { LlmUsage } from 'src/transcription/llm/llmResponse';

/**
 * The identity a test gives the OpenAI-compatible client when it builds one
 * directly.
 *
 * Two vendors share that client, so it is told which one it answers as, and a
 * test about the wire format rather than about the vendor says OpenAI here
 * instead of repeating the pair.
 */
export const OPENAI_IDENTITY: LlmVendorIdentity = {
	id: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
	label: 'OpenAI',
};

/**
 * A completion carrying text alone, as a vendor that reports no usage sends
 * it. What most tests want: the accounting then falls back to the estimate.
 * @param text - The assistant's text
 * @returns The completion a provider double answers with
 */
export function completed(text: string): LlmCompletion {
	return { text };
}

/**
 * A completion carrying the token counts a vendor reported, so a test can
 * drive the accounting off real usage rather than the estimate.
 * @param text - The assistant's text
 * @param usage - Token counts the vendor reported
 * @returns The completion a provider double answers with
 */
export function billed(text: string, usage: LlmUsage): LlmCompletion {
	return { text, usage };
}
