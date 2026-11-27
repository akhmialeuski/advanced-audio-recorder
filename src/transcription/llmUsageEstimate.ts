/**
 * How much an LLM step over the transcript is expected to read and write, for
 * the estimate before a run and for a call whose vendor reported no usage.
 *
 * Every such step reads the whole transcript back, so its input is sized from
 * the recording's length; what differs is how much it writes and how many
 * calls it makes, which for a note template its parts decide.
 * @module transcription/llmUsageEstimate
 */

import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { ProfileKindId, selectedProfile } from '../settings/profiles';
import { vendorMaxTokens } from '../providers/providers';
import {
	type NoteTemplatePlan,
	planNoteTemplate,
} from '../templates/noteTemplateCheck';
import { LlmTask, type TextLlmTask } from './llmPostProcess';
import { jobVendorId, LlmJobId } from './llm/vendors';
import type { TranscriptionUsage } from './TranscriptTypes';

/**
 * Rough transcript tokens per second of speech (roughly 2.5 words/s plus
 * JSON structure overhead). Used both as the output size of a token-billed
 * transcription engine and as the input size of the LLM post-processing
 * pass, which reads that transcript back.
 */
const ESTIMATED_OUTPUT_TOKENS_PER_SECOND = 8;

/**
 * Fraction of the transcript an LLM task is expected to emit, used only for
 * the pre-run estimate: a cleanup or custom rewrite is about as long as its
 * input, whereas a summary is much shorter.
 */
export const LLM_OUTPUT_RATIO: Record<TextLlmTask, number> = {
	[LlmTask.Cleanup]: 1,
	[LlmTask.Summary]: 0.25,
	[LlmTask.Custom]: 1,
	// A translation is about as long as what it translates, so the pass is
	// sized like a cleanup rather than like a summary.
	[LlmTask.Translate]: 1,
};

/**
 * How many tokens a transcript of the given recording is expected to run to.
 * The input size of every LLM step that reads the whole transcript back, and
 * the output size of a token-billed transcription engine that writes it.
 * @param durationSeconds - Audio duration in seconds
 */
export function transcriptTokens(durationSeconds: number): number {
	return Math.ceil(durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND);
}

/**
 * Synthesizes the usage one LLM pass over the whole transcript is expected to
 * bill: the transcript is the (text) input, the answer is a fraction of it, and
 * that fraction is capped by the ceiling of the engine the job names. Auto
 * chapters and post-processing are the same pass twice over, differing only in
 * how much they write and which engine they write it on, so they are the same
 * function twice over rather than two that have to be kept in step.
 * @param settings - Plugin settings
 * @param durationSeconds - Audio duration in seconds
 * @param job - The job making the pass, which names the engine and its ceiling
 * @param outputRatio - Share of the transcript the answer is expected to run to
 */
export function estimatedTranscriptPassUsage(
	settings: AudioRecorderSettings,
	durationSeconds: number,
	job: LlmJobId,
	outputRatio: number,
): TranscriptionUsage {
	const inputTokens = transcriptTokens(durationSeconds);
	return {
		inputTokens,
		outputTokens: Math.min(
			Math.ceil(inputTokens * outputRatio),
			vendorMaxTokens(settings, jobVendorId(settings, job)),
		),
	};
}

/**
 * How many calls the post-processing step makes and how much they write: one
 * call sized by its task for a task over the text, and for a note template
 * what its parts ask for, read from the template selected.
 * @param settings - The run's settings snapshot
 */
function postProcessPlan(settings: AudioRecorderSettings): NoteTemplatePlan {
	const task = settings.llmPostProcessTask;
	if (task !== LlmTask.Template) {
		return { calls: 1, outputRatio: LLM_OUTPUT_RATIO[task] ?? 1 };
	}
	const template = selectedProfile(settings, ProfileKindId.LlmTemplate);
	return template
		? planNoteTemplate(template.body)
		: { calls: 0, outputRatio: 0 };
}

/**
 * Synthesizes the usage of the post-processing step: every call reads the
 * whole transcript, and each is bounded by the engine's output ceiling.
 * @param settings - The run's settings snapshot
 * @param durationSeconds - Transcript extent in seconds
 * @param perCall - Whether to answer one call's share rather than the step's
 */
export function estimatedPostProcessUsage(
	settings: AudioRecorderSettings,
	durationSeconds: number,
	perCall: boolean,
): TranscriptionUsage {
	const plan = postProcessPlan(settings);
	const calls = perCall ? Math.min(plan.calls, 1) : plan.calls;
	const share = perCall && plan.calls > 0 ? 1 / plan.calls : 1;
	const inputTokens = transcriptTokens(durationSeconds);
	const cap = vendorMaxTokens(
		settings,
		jobVendorId(settings, LlmJobId.PostProcess),
	);
	return {
		inputTokens: inputTokens * calls,
		outputTokens: Math.min(
			Math.ceil(inputTokens * plan.outputRatio * share),
			cap * calls,
		),
	};
}
