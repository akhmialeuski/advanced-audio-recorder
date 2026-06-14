/**
 * Pure extractors that pull the assistant text out of an OpenAI-style
 * chat completion or an Anthropic Messages response. Kept separate from
 * the network code so the response handling is unit tested.
 * @module transcription/llm/llmResponse
 */

/**
 * Extracts the assistant message text from an OpenAI-compatible
 * `chat/completions` response (also used by Groq and Ollama).
 * @param body - Parsed JSON response
 * @returns The message content, or empty string when absent
 */
export function extractOpenAiText(body: unknown): string {
	if (typeof body !== 'object' || body === null) {
		return '';
	}
	const choices = (body as Record<string, unknown>).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return '';
	}
	const first = choices[0] as Record<string, unknown> | null;
	const message = first?.message as Record<string, unknown> | undefined;
	const content = message?.content;
	return typeof content === 'string' ? content.trim() : '';
}

/**
 * Extracts the text from an Anthropic Messages response by concatenating
 * the `text` blocks in `content`.
 * @param body - Parsed JSON response
 * @returns The combined text, or empty string when absent
 */
export function extractAnthropicText(body: unknown): string {
	if (typeof body !== 'object' || body === null) {
		return '';
	}
	const content = (body as Record<string, unknown>).content;
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== 'object' || block === null) {
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type === 'text' && typeof record.text === 'string') {
			parts.push(record.text);
		}
	}
	return parts.join('').trim();
}
