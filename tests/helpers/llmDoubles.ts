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
	LlmProvider,
	LlmVendorIdentity,
} from 'src/transcription/llm/LlmProvider';
import type { LlmUsage } from 'src/transcription/llm/llmResponse';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import { EngineLabel } from 'src/providers/providers';

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
	label: EngineLabel.OpenAi,
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

/**
 * What each context agent of the advanced two-pass mode answers, keyed by a
 * fragment of its system prompt. Mined from a Russian draft that transliterated
 * an English term ("кубернетис") and carries an inflected name, which is the
 * case the mode exists for.
 */
const CONTEXT_AGENT_REPLIES: readonly (readonly [string, string])[] = [
	['domain and topic', 'Митинг про инфраструктуру.'],
	['proper names', 'Иванов'],
	['domain terminology', 'деплой'],
	['English technical terms', 'Kubernetes'],
	['verify candidate terms', 'Kubernetes'],
	[
		'context prompt',
		'Обсуждение инфраструктуры: деплой, Иванов, Kubernetes.',
	],
];

/**
 * An LLM that answers the advanced mode's context agents, recording every
 * prompt it was sent. The agents' answers lead the second pass to the
 * canonical spelling `Kubernetes`, so a second pass that ran shows in the
 * transcript.
 * @returns The provider double and the prompts it received, in order
 */
export function contextAgentsLlm(): { llm: LlmProvider; calls: LlmPrompt[] } {
	const calls: LlmPrompt[] = [];
	const llm: LlmProvider = {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: EngineLabel.Gemini,
		complete: (prompt: LlmPrompt): Promise<LlmCompletion> => {
			calls.push(prompt);
			const match = CONTEXT_AGENT_REPLIES.find(([fragment]) =>
				prompt.system.includes(fragment),
			);
			return Promise.resolve(completed(match?.[1] ?? ''));
		},
	};
	return { llm, calls };
}
