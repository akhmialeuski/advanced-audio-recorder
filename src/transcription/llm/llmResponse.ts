/**
 * Pure extractors that pull the assistant text out of an OpenAI-style
 * chat completion or an Anthropic Messages response. Kept separate from
 * the network code so the response handling is unit tested.
 * @module transcription/llm/llmResponse
 */

import { isRecord } from '../providers/responseUtils';
import { geminiCandidateText } from '../providers/geminiShared';

/**
 * Extracts the assistant message text from an OpenAI-compatible
 * `chat/completions` response (also used by Groq and Ollama).
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
