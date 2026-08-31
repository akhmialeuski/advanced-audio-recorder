/**
 * Pure prompt construction for LLM post-processing of a transcript.
 * Building the prompts is separated from the network call so the prompt
 * shape can be unit tested and reused across providers. The cleanup and
 * summary system prompts are editable in settings; the language clause is
 * appended here so the user-facing base text stays language-agnostic.
 * @module transcription/llmPostProcess
 */

import {
	DEFAULT_LLM_CLEANUP_PROMPT,
	DEFAULT_LLM_SUMMARY_PROMPT,
	DEFAULT_LLM_TRANSLATE_PROMPT,
} from '../constants';

/** What the LLM should do with the transcript text. */
export type LlmTask = 'cleanup' | 'summary' | 'custom' | 'translate';

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
	language?: string | undefined;
	/**
	 * Editable cleanup system prompt (base text, before the language clause).
	 * Falls back to {@link DEFAULT_LLM_CLEANUP_PROMPT} when empty.
	 */
	cleanupPrompt?: string;
	/**
	 * Editable summary system prompt (base text, before the language clause).
	 * Falls back to {@link DEFAULT_LLM_SUMMARY_PROMPT} when empty.
	 */
	summaryPrompt?: string;
	/** Custom instruction, sent verbatim, used when task is 'custom'. */
	customInstruction?: string;
	/**
	 * Editable translation system prompt (base text, before the target-language
	 * clause). Falls back to {@link DEFAULT_LLM_TRANSLATE_PROMPT} when empty.
	 */
	translatePrompt?: string;
	/** Language to translate into, used when task is 'translate'. */
	targetLanguage?: string | undefined;
	/**
	 * Canonical spellings of domain names, terms, and acronyms, from the run's
	 * Dictionary terms. Appended to the cleanup prompt so even a single-pass run
	 * corrects "кубернетис" to "Kubernetes"; other tasks ignore it (a summary
	 * rewords anyway, and custom is verbatim).
	 */
	glossary?: string[];
}

/**
 * Builds the language clause appended to the cleanup prompt: keep the answer in
 * the transcript's language.
 * @param language - Detected/declared language, when known
 */
function cleanupLanguageClause(language?: string): string {
	return language
		? ` The transcript language is ${language}; respond in that same language.`
		: ' Respond in the same language as the transcript.';
}

/**
 * Builds the glossary clause appended to the cleanup prompt: prefer the
 * canonical spellings where the transcript garbled them, without inserting
 * terms that were not spoken.
 * @param glossary - Canonical terms, when any are configured
 */
function cleanupGlossaryClause(glossary?: string[]): string {
	if (!glossary?.length) {
		return '';
	}
	return (
		' Where the transcript garbles one of these names, terms, or ' +
		`acronyms, prefer this canonical spelling: ${glossary.join(', ')}. ` +
		'Do not insert terms that were not spoken.'
	);
}

/**
 * Builds the language clause appended to the summary prompt.
 * @param language - Detected/declared language, when known
 */
function summaryLanguageClause(language?: string): string {
	return language
		? ` Write the summary in ${language}.`
		: ' Write the summary in the same language as the transcript.';
}

/**
 * Builds the target-language clause appended to the translation prompt.
 * @param language - Language to translate into, when one is configured
 */
function translateLanguageClause(language?: string): string {
	return language
		? ` Translate into ${language}.`
		: ' Translate into English.';
}

/**
 * Builds a provider-neutral prompt for the requested post-processing task.
 * The cleanup and summary base prompts come from settings (falling back to the
 * shipped defaults) and get the language clause appended; the custom
 * instruction is sent verbatim so the user controls every directive.
 * @param text - The transcript text to process
 * @param options - Task, language, and editable prompt templates
 * @returns System + user prompt
 */
export function buildPostProcessPrompt(
	text: string,
	options: PostProcessOptions,
): LlmPrompt {
	switch (options.task) {
		case 'cleanup':
			return {
				system:
					(options.cleanupPrompt?.trim() ||
						DEFAULT_LLM_CLEANUP_PROMPT) +
					cleanupGlossaryClause(options.glossary) +
					cleanupLanguageClause(options.language),
				user: text,
			};
		case 'summary':
			return {
				system:
					(options.summaryPrompt?.trim() ||
						DEFAULT_LLM_SUMMARY_PROMPT) +
					summaryLanguageClause(options.language),
				user: text,
			};
		case 'custom':
			return {
				system:
					(options.customInstruction ?? '').trim() ||
					'Process the following transcript as instructed.',
				user: text,
			};
		case 'translate':
			return {
				system:
					(options.translatePrompt?.trim() ||
						DEFAULT_LLM_TRANSLATE_PROMPT) +
					translateLanguageClause(options.targetLanguage),
				user: text,
			};
	}
}
