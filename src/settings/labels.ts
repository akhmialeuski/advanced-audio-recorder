/**
 * UI copy for settings-driven dropdowns: display labels and value/label
 * option lists shared by the settings tab and the transcription modal.
 * @module settings/labels
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import { LLM_VENDOR_IDS, LLM_VENDORS } from '../transcription/llm/vendors';
import type {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import type { LlmTask } from '../transcription/llmPostProcess';
import type { LlmProviderId, TranscriptionProviderId } from './settingsSchema';

/** Display labels for each transcription engine (single source for UI). */
export const TRANSCRIPTION_PROVIDER_LABELS: Record<
	TranscriptionProviderId,
	string
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: 'Whisper API (OpenAI-compatible)',
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: 'Deepgram',
	[TRANSCRIPTION_PROVIDER_IDS.GEMINI]: 'Google Gemini',
	[TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER]: 'Local whisper.cpp (desktop)',
};

/** Display labels for each transcript destination (single source for UI). */
export const TRANSCRIPT_DESTINATION_LABELS: Record<
	TranscriptDestination,
	string
> = {
	note: 'Insert into note',
	file: 'Save to file',
	both: 'Note and file',
	link: 'Save to file and link it in the note',
};

/** Display labels for each transcript file format (single source for UI). */
export const TRANSCRIPT_FILE_FORMAT_LABELS: Record<
	TranscriptFileFormat,
	string
> = {
	json: 'JSON (full data + speakers)',
	srt: 'SubRip (.srt)',
	vtt: 'WebVTT (.vtt)',
	txt: 'Plain text (.txt)',
};

/** Display labels for each LLM post-processing task (single source for UI). */
export const LLM_TASK_LABELS: Record<LlmTask, string> = {
	cleanup: 'Clean up',
	summary: 'Summarize',
	custom: 'Custom',
};

/**
 * Display labels for each LLM provider, derived from the vendor registry so
 * the dropdown, the cost estimate, and the provider itself can never disagree
 * about a vendor's name.
 */
export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> =
	Object.fromEntries(
		LLM_VENDOR_IDS.map((id) => [id, LLM_VENDORS[id].label]),
	) as Record<LlmProviderId, string>;

/**
 * Public pricing pages per transcription engine, linked from the cost
 * estimate so the user can check the current rates against the plugin's
 * built-in approximations. Kept in one place (not inlined at the call
 * site) so a moved page is a single edit; the free local engine has no
 * entry. These are external URLs owned by the providers and can change.
 */
export const TRANSCRIPTION_PROVIDER_PRICING_URLS: Partial<
	Record<TranscriptionProviderId, string>
> = {
	[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API]: 'https://openai.com/api/pricing/',
	[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM]: 'https://deepgram.com/pricing',
	[TRANSCRIPTION_PROVIDER_IDS.GEMINI]:
		'https://ai.google.dev/gemini-api/docs/pricing',
};

/**
 * Public pricing pages per LLM post-processing provider, linked from the cost
 * estimate. Derived from the vendor registry, which owns the URL alongside the
 * rate table it should be checked against.
 */
export const LLM_PROVIDER_PRICING_URLS: Record<LlmProviderId, string> =
	Object.fromEntries(
		LLM_VENDOR_IDS.map((id) => [id, LLM_VENDORS[id].pricingUrl]),
	) as Record<LlmProviderId, string>;

/** A value/label pair for a dropdown control (single source for the UI). */
export interface LabeledOption {
	value: string;
	label: string;
	/** Render the option visible but unselectable (blocked on this device). */
	disabled?: boolean;
}

/**
 * Builds dropdown options from a label map, preserving key insertion order.
 * Lets the settings tab and the transcription modal share one source of
 * truth for both option values and their display labels.
 * @param labels - Map of value to display label
 * @returns Ordered value/label option pairs
 */
function optionsFromLabels<K extends string>(
	labels: Record<K, string>,
): LabeledOption[] {
	return (Object.keys(labels) as K[]).map((value) => ({
		value,
		label: labels[value],
	}));
}

/** Engine dropdown options, derived from the engine label map. */
export const TRANSCRIPTION_PROVIDER_OPTIONS = optionsFromLabels(
	TRANSCRIPTION_PROVIDER_LABELS,
);

/** Destination dropdown options, derived from the destination label map. */
export const TRANSCRIPT_DESTINATION_OPTIONS = optionsFromLabels(
	TRANSCRIPT_DESTINATION_LABELS,
);

/** File-format dropdown options, derived from the file-format label map. */
export const TRANSCRIPT_FILE_FORMAT_OPTIONS = optionsFromLabels(
	TRANSCRIPT_FILE_FORMAT_LABELS,
);

/** LLM-task dropdown options, derived from the task label map. */
export const LLM_TASK_OPTIONS = optionsFromLabels(LLM_TASK_LABELS);

/** LLM-provider dropdown options, derived from the provider label map. */
export const LLM_PROVIDER_OPTIONS = optionsFromLabels(LLM_PROVIDER_LABELS);
