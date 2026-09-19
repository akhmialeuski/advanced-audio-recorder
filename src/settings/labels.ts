/**
 * UI copy for settings-driven dropdowns: display labels and value/label
 * option lists shared by the settings tab and the transcription modal.
 * @module settings/labels
 */

import { ChannelMode } from '../audio/downmix';
import { PcmSampleFormat } from '../audio/pcm';
import { LLM_VENDOR_IDS, LLM_VENDORS } from '../transcription/llm/vendors';
import {
	TRANSCRIPTION_ENGINE_IDS,
	TRANSCRIPTION_ENGINES,
} from '../transcription/providers/engines';
import {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import { LlmTask } from '../transcription/llmPostProcess';
import type { LlmProviderId, TranscriptionProviderId } from './settingsSchema';
import {
	ConversionLinkAction,
	TrackProcessingMode,
	TrackSourceKind,
} from './settingsSchema';

/**
 * Display labels for each transcription engine, derived from the engine
 * registry so the dropdown, the cost estimate, and the provider itself can
 * never disagree about an engine's name.
 */
export const TRANSCRIPTION_PROVIDER_LABELS: Record<
	TranscriptionProviderId,
	string
> = Object.fromEntries(
	TRANSCRIPTION_ENGINE_IDS.map((id) => [id, TRANSCRIPTION_ENGINES[id].label]),
) as Record<TranscriptionProviderId, string>;

/** Display labels for each transcript destination (single source for UI). */
export const TRANSCRIPT_DESTINATION_LABELS: Record<
	TranscriptDestination,
	string
> = {
	[TranscriptDestination.Note]: 'Insert into note',
	[TranscriptDestination.File]: 'Save to file',
	[TranscriptDestination.Both]: 'Note and file',
	[TranscriptDestination.Link]: 'Save to file and link it in the note',
};

/** Display labels for each transcript file format (single source for UI). */
export const TRANSCRIPT_FILE_FORMAT_LABELS: Record<
	TranscriptFileFormat,
	string
> = {
	[TranscriptFileFormat.Json]: 'JSON (full data + speakers)',
	[TranscriptFileFormat.Srt]: 'SubRip (.srt)',
	[TranscriptFileFormat.Vtt]: 'WebVTT (.vtt)',
	[TranscriptFileFormat.Txt]: 'Plain text (.txt)',
};

/**
 * Display labels for what a conversion or split does to the source file's
 * links in notes. Shared by the settings tab and the two dialogs, which each
 * used to hard-code the same three value/label pairs.
 */
export const CONVERSION_LINK_ACTION_LABELS: Record<
	ConversionLinkAction,
	string
> = {
	[ConversionLinkAction.None]: 'Do nothing',
	[ConversionLinkAction.Replace]: 'Replace source link',
	[ConversionLinkAction.After]: 'Insert after source link',
};

/** Display labels for each LLM post-processing task (single source for UI). */
export const LLM_TASK_LABELS: Record<LlmTask, string> = {
	[LlmTask.Cleanup]: 'Clean up',
	[LlmTask.Summary]: 'Summarize',
	[LlmTask.Custom]: 'Custom',
	[LlmTask.Translate]: 'Translate',
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
 * Public pricing pages per transcription engine, linked from the cost estimate
 * so the user can check the current rates against the plugin's built-in
 * approximations. Derived from the engine registry, which owns the URL
 * alongside the rate table it should be checked against; the free local engine
 * has no entry.
 */
export const TRANSCRIPTION_PROVIDER_PRICING_URLS: Partial<
	Record<TranscriptionProviderId, string>
> = Object.fromEntries(
	TRANSCRIPTION_ENGINE_IDS.flatMap((id) => {
		const url = TRANSCRIPTION_ENGINES[id].pricingUrl;
		return url ? [[id, url] as const] : [];
	}),
);

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

/** Link-action dropdown options, derived from the link-action label map. */
export const CONVERSION_LINK_ACTION_OPTIONS = optionsFromLabels(
	CONVERSION_LINK_ACTION_LABELS,
);

/**
 * Channel-layout labels, keyed by mode. The left/right options suit audio
 * interfaces whose two mono inputs show up as one stereo device: a single
 * microphone stays at full level instead of being mixed with a silent channel.
 */
export const CHANNEL_MODE_LABELS: Record<ChannelMode, string> = {
	[ChannelMode.Source]: 'Same as input device',
	[ChannelMode.MonoMix]: 'Mono (mix all channels)',
	[ChannelMode.MonoLeft]: 'Mono (left channel)',
	[ChannelMode.MonoRight]: 'Mono (right channel)',
};

/**
 * Sample-representation labels, keyed by format. Named the way audio tools
 * name them, because the choice is one a user arrives with from elsewhere:
 * the two numbers are the width, and "float" is the part that says a sample
 * past full scale survives.
 */
export const PCM_SAMPLE_FORMAT_LABELS: Record<PcmSampleFormat, string> = {
	[PcmSampleFormat.Int16]: '16-bit integer',
	[PcmSampleFormat.Int24]: '24-bit integer',
	[PcmSampleFormat.Float32]: '32-bit float',
};

/**
 * Input-processing labels, keyed by mode. Named for the source each profile
 * suits rather than for the three filters it sets, because the choice a user
 * makes is about what the track is plugged into.
 */
export const TRACK_PROCESSING_LABELS: Record<TrackProcessingMode, string> = {
	[TrackProcessingMode.Global]: 'Same as global settings',
	[TrackProcessingMode.Voice]: 'Voice (microphone in a room)',
	[TrackProcessingMode.Raw]: 'Raw (system audio or line input)',
};

/**
 * Source labels, keyed by kind. Named for what the track records rather than
 * for the mechanism, because the mechanism differs per platform and the user
 * is choosing what goes into the file.
 */
export const TRACK_SOURCE_KIND_LABELS: Record<TrackSourceKind, string> = {
	[TrackSourceKind.InputDevice]: 'Input device',
	[TrackSourceKind.SystemAudio]: 'System audio (this computer)',
};
