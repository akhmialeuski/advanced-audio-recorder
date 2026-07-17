/**
 * Public API of the transcription domain for the UI layer. Modals and other
 * presentation code import from here instead of reaching into individual
 * transcription modules, so the domain's internal layout can change without
 * touching the UI.
 * @module transcription/api
 */

export { transcribeFile } from './runTranscription';
export {
	effectiveDiarize,
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
	providerSupportsDictionary,
} from './providers/capabilities';
export { effectiveTranscriptDestination } from './transcriptOutput';
export { TranscriptionCancelledError } from './TranscriptionService';
export type {
	CancellationToken,
	TranscriptionServiceDeps,
} from './TranscriptionService';
export type {
	TranscriptDestination,
	TranscriptFileFormat,
} from './TranscriptTypes';
export type { LlmTask } from './llmPostProcess';
