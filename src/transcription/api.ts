/**
 * Public API of the transcription domain for the UI layer. Modals and other
 * presentation code import from here instead of reaching into individual
 * transcription modules, so the domain's internal layout can change without
 * touching the UI.
 * @module transcription/api
 */

export { transcribeFile } from './runTranscription';
export type { TranscriptOutputSidecar } from './runTranscription';
export {
	effectiveDiarize,
	effectiveWordTimestamps,
	isProviderAvailableOnPlatform,
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
	estimateStepCost,
	formatUsd,
} from './costs';
export type { CostEstimate, CostEstimateLine, RunCostStepId } from './costs';
export { advancedTwoPassWillRun } from './advanced/advancedBias';
export { SessionCostTracker } from './SessionCostTracker';
export type {
	TranscriptDestination,
	TranscriptFileFormat,
} from './TranscriptTypes';
export type { LlmTask } from './llmPostProcess';
export type { Transcript } from './TranscriptTypes';
/**
 * The LLM vendor registry, re-exported for the dialogs that let the user pick
 * the provider and model for one run. They read the descriptor rather than
 * addressing settings fields directly, which is what keeps their pickers in
 * step with the settings tab.
 */
export {
	LLM_JOBS,
	LLM_VENDOR_IDS,
	LLM_VENDORS,
	jobLlmVendor,
	jobVendorId,
} from './llm/vendors';
export type { LlmJobId, LlmVendorDescriptor } from './llm/vendors';
