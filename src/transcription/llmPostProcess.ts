/**
 * Pure prompt construction for LLM post-processing of a transcript.
 * Building the prompts is separated from the network call so the prompt
 * shape can be unit tested and reused across providers.
 * @module transcription/llmPostProcess
 */

/** What the LLM should do with the transcript text. */
export type LlmTask = 'cleanup' | 'summary' | 'custom';

/** A provider-neutral prompt: a system instruction and a user message. */
export interface LlmPrompt {
	system: string;
	user: string;
}

/** Options shaping the post-processing prompt. */
export interface PostProcessOptions {
	/** The task to perform. */
	task: LlmTask;
	/** Detected/declared language name or code, when known. */
	language?: string;
	/** Custom instruction, used when task is 'custom'. */
	customInstruction?: string;
}

/**
 * Builds the system instruction for a cleanup pass: fix punctuation,
 * capitalization, and obvious transcription slips, add paragraph breaks,
 * and keep the speaker's words and meaning intact — in the original
 * language.
 */
function cleanupSystemPrompt(language?: string): string {
	const langClause = language
		? ` The transcript language is ${language}; respond in that same language.`
		: ' Respond in the same language as the transcript.';
	return (
		'You are an expert transcription editor. You are given a raw, ' +
		'machine-generated transcript. Correct punctuation, capitalization, ' +
		'and obvious speech-to-text errors; insert sensible paragraph breaks; ' +
		'and remove filler artifacts only when they add no meaning. Do NOT ' +
		'summarize, translate, paraphrase, add, or omit content — preserve ' +
		'the speaker’s exact wording and meaning. Preserve any speaker labels ' +
		'and timestamps exactly as they appear, keeping each on its original ' +
		'line. Return only the corrected transcript with no preamble.' +
		langClause
	);
}

/**
 * Builds the system instruction for a summary pass.
 */
function summarySystemPrompt(language?: string): string {
	const langClause = language
		? ` Write the summary in ${language}.`
		: ' Write the summary in the same language as the transcript.';
	return (
		'You are an expert analyst. Summarize the following transcript into a ' +
		'concise set of key points and any action items, as Markdown bullet ' +
		'lists under short headings. Be faithful to the content and do not ' +
		'invent details. Return only the summary with no preamble.' +
		langClause
	);
}

/**
 * Builds a provider-neutral prompt for the requested post-processing task.
 * @param text - The transcript text to process
 * @param options - Task and language options
 * @returns System + user prompt
 */
export function buildPostProcessPrompt(
	text: string,
	options: PostProcessOptions,
): LlmPrompt {
	switch (options.task) {
		case 'cleanup':
			return {
				system: cleanupSystemPrompt(options.language),
				user: text,
			};
		case 'summary':
			return {
				system: summarySystemPrompt(options.language),
				user: text,
			};
		case 'custom':
			return {
				system:
					(options.customInstruction ?? '').trim() ||
					'Process the following transcript as instructed.',
				user: text,
			};
	}
}
