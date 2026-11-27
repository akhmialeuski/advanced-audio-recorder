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
import { errorMessage } from '../errors';
import { LlmAnswerTruncatedError } from './llm/llmResponse';

/**
 * What the LLM should do with the transcript text.
 *
 * Stored in data.json, so a value is renamed only with a migration. The
 * dropdown order is the one `LLM_TASK_LABELS` in settings/labels declares,
 * which the keys here repeat.
 */
export const LlmTask = {
	/** Rewrite the transcript into readable prose, keeping what was said. */
	Cleanup: 'cleanup',
	/** Reduce the transcript to its points. */
	Summary: 'summary',
	/** Follow an instruction the user wrote. */
	Custom: 'custom',
	/** Render the transcript in another language. */
	Translate: 'translate',
	/** Build the note from a template whose parts the model fills. */
	Template: 'template',
} as const;

/** One post-processing task (derived from {@link LlmTask}). */
export type LlmTask = (typeof LlmTask)[keyof typeof LlmTask];

/**
 * Where the note a template writes goes. The template says what the note
 * holds; where it goes depends on how the vault is kept, so it is a setting
 * beside the template rather than part of it.
 */
export const TemplateOutput = {
	/** Into the note the recording belongs to, under the transcript heading. */
	Note: 'note',
	/**
	 * Into a note of its own next to the recording, with a link to it where
	 * the transcript would go.
	 */
	Separate: 'separate',
} as const;

/**
 * Whether a run's note is written by a note template, as its settings stand.
 * @param settings - Whether post-processing runs, and its task
 */
export function writesTemplateNote(settings: {
	readonly llmPostProcessEnabled: boolean;
	readonly llmPostProcessTask: LlmTask;
}): boolean {
	return (
		settings.llmPostProcessEnabled &&
		settings.llmPostProcessTask === LlmTask.Template
	);
}

/** Where a template's note goes (derived from {@link TemplateOutput}). */
export type TemplateOutput =
	(typeof TemplateOutput)[keyof typeof TemplateOutput];

/**
 * A task answered by one prompt over the transcript text. A note template
 * builds its own prompts, one per call its parts need, and is run apart.
 */
export type TextLlmTask = Exclude<LlmTask, typeof LlmTask.Template>;

/** A provider-neutral prompt: a system instruction and a user message. */
export interface LlmPrompt {
	system: string;
	user: string;
}

/** Options shaping the post-processing prompt. */
export interface PostProcessOptions {
	/** The task to perform. */
	task: TextLlmTask;
	/** Detected/declared language name or code, when known. */
	language?: string | undefined;
	/**
	 * Every language the transcript's segments were spoken in, when the engine
	 * answered per segment. More than one means a recording that switches
	 * language, which the cleanup clause then names instead of the one above.
	 */
	segmentLanguages?: readonly string[] | undefined;
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
	/** Custom instruction, sent verbatim, used by {@link LlmTask.Custom}. */
	customInstruction?: string;
	/**
	 * Editable translation system prompt (base text, before the target-language
	 * clause). Falls back to {@link DEFAULT_LLM_TRANSLATE_PROMPT} when empty.
	 */
	translatePrompt?: string;
	/** Language to translate into, used by {@link LlmTask.Translate}. */
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
 * the transcript's language, or, for a transcript that switches language, keep
 * every line in its own. Naming one language there told the model to bring the
 * passages in the other one over into it.
 * @param language - Detected/declared language, when known
 * @param segmentLanguages - The languages the segments were spoken in
 */
function cleanupLanguageClause(
	language?: string,
	segmentLanguages: readonly string[] = [],
): string {
	if (segmentLanguages.length > 1) {
		return ` The transcript mixes ${segmentLanguages.join(', ')}. Keep every line in the language it is written in, and do not translate any of it.`;
	}
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
		case LlmTask.Cleanup:
			return {
				system:
					(options.cleanupPrompt?.trim() ||
						DEFAULT_LLM_CLEANUP_PROMPT) +
					cleanupGlossaryClause(options.glossary) +
					cleanupLanguageClause(
						options.language,
						options.segmentLanguages,
					),
				user: text,
			};
		case LlmTask.Summary:
			return {
				system:
					(options.summaryPrompt?.trim() ||
						DEFAULT_LLM_SUMMARY_PROMPT) +
					summaryLanguageClause(options.language),
				user: text,
			};
		case LlmTask.Custom:
			return {
				system:
					(options.customInstruction ?? '').trim() ||
					'Process the following transcript as instructed.',
				user: text,
			};
		case LlmTask.Translate:
			return {
				system:
					(options.translatePrompt?.trim() ||
						DEFAULT_LLM_TRANSLATE_PROMPT) +
					translateLanguageClause(options.targetLanguage),
				user: text,
			};
	}
}

/** What the user is told when the post-processing pass did not finish. */
const POST_PROCESS_FAILED =
	'LLM post-processing failed; saving the raw transcript.';

/**
 * The tasks whose answer is the transcript written again, so that it is about
 * as long as the transcript the prompt carried.
 */
const REWRITES_WHOLE_TRANSCRIPT: ReadonlySet<LlmTask> = new Set([
	LlmTask.Cleanup,
	LlmTask.Translate,
]);

/**
 * The notice for a post-processing pass that failed: that the raw transcript
 * is kept, and why the pass failed in the words of whoever refused it. A
 * limit above the model's maximum is refused by the service, which names the
 * maximum, so its sentence is the instruction. For an answer cut at the
 * output limit by a task that writes the whole transcript again, the notice
 * adds how large the limit has to be: the transcript's own tokens, which the
 * answer repeats, and what the model spent on reasoning on top of them.
 * @param error - What the pass failed with
 * @param task - The task the pass was running
 * @returns The notice text
 */
export function postProcessFailureNotice(
	error: unknown,
	task: LlmTask,
): string {
	const reason = `${POST_PROCESS_FAILED} ${errorMessage(error)}`;
	if (
		!(error instanceof LlmAnswerTruncatedError) ||
		error.inputTokens === undefined ||
		!REWRITES_WHOLE_TRANSCRIPT.has(task)
	) {
		return reason;
	}
	const needed = error.inputTokens + (error.reasoningTokens ?? 0);
	return (
		`${reason} This task writes the whole transcript again, about ` +
		`${String(error.inputTokens)} tokens here, so the limit has to be ` +
		`at least ${String(needed)}.`
	);
}
