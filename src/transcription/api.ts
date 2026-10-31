/**
 * Public API of the transcription domain for the UI layer. Modals and other
 * presentation code import from here instead of reaching into individual
 * transcription modules, so the domain's internal layout can change without
 * touching the UI.
 * @module transcription/api
 */

export { RecordingTranscriber, runOutcomeNotice } from './RecordingTranscriber';
export type {
	RecordingTranscriptionRequest,
	TranscriptionRunOutcome,
} from './RecordingTranscriber';
export {
	effectiveDiarize,
	effectiveWordTimestamps,
	isProviderAvailableOnPlatform,
	languageNote,
	providerSupportsDiarization,
	providerSupportsDictionary,
	wordTimestampsNote,
	wordTimestampsSelectable,
} from './providers/capabilities';
export { effectiveTranscriptDestination } from './transcriptOutput';
export { TranscriptionCancelledError } from './TranscriptionService';
export type {
	CancellationToken,
	TranscribeRunCost,
} from './TranscriptionService';
export {
	buildCostEstimate,
	costEstimateNeedsDuration,
	CostEstimateUnpricedReason,
	estimateStepCost,
	formatUsd,
} from './costs';
export type { CostEstimate, CostEstimateLine } from './costs';
export { SessionCostTracker } from './SessionCostTracker';
export { TranscriptDestination } from './TranscriptTypes';
export type { Transcript, TranscriptFileFormat } from './TranscriptTypes';
export type { LlmTask } from './llmPostProcess';
/**
 * The LLM vendor registry, re-exported for the dialogs that let the user pick
 * the provider and model for one run. They read the descriptor rather than
 * addressing settings fields directly, which is what keeps their pickers in
 * step with the settings tab.
 */
export { LLM_JOBS, LlmJobId, jobLlmVendor, jobVendorId } from './llm/vendors';
export type { LlmVendorDescriptor } from './llm/vendors';
