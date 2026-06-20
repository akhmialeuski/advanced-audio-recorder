/**
 * Renders the transcription settings: engine selection and per-engine
 * configuration (Whisper API, Deepgram, local whisper.cpp), transcript
 * output/formatting, and optional LLM post-processing. Built from the
 * reusable controls in `settingControls` so the section stays declarative.
 * @module settings/sections/transcriptionSettingsSection
 */

import {
	MIN_TRANSCRIBE_CHUNK_MB,
	MAX_TRANSCRIBE_CHUNK_MB,
	MIN_LLM_MAX_TOKENS,
	MAX_LLM_MAX_TOKENS,
} from '../../constants';
import {
	TRANSCRIPTION_PROVIDER_LABELS,
	type TranscriptionProviderId,
} from '../Settings';
import {
	addDropdown,
	addHeading,
	addSlider,
	addText,
	addToggle,
	type DropdownOption,
	type SettingsSectionContext,
} from '../settingControls';

/** Engine options for the dropdown, derived from the label map. */
const PROVIDER_OPTIONS: DropdownOption[] = (
	Object.keys(TRANSCRIPTION_PROVIDER_LABELS) as TranscriptionProviderId[]
).map((value) => ({ value, label: TRANSCRIPTION_PROVIDER_LABELS[value] }));

/**
 * Renders the full transcription settings section.
 * @param ctx - Section context (container, settings, save hooks)
 */
export function renderTranscriptionSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Transcription');

	addToggle(ctx, {
		name: 'Enable transcription',
		desc: 'Transcribe recordings to text (speech-to-text), with optional speaker labels and LLM post-processing.',
		get: () => s.transcriptionEnabled,
		set: (v) => (s.transcriptionEnabled = v),
		rerender: true,
	});
	if (!s.transcriptionEnabled) {
		return;
	}

	addToggle(ctx, {
		name: 'Transcribe after recording',
		desc: 'Automatically transcribe each recording once it is saved.',
		get: () => s.transcribeOnSave,
		set: (v) => (s.transcribeOnSave = v),
	});

	addDropdown(ctx, {
		name: 'Engine',
		desc: 'Whisper API (cloud), Deepgram (cloud), or a local whisper.cpp binary (desktop).',
		options: PROVIDER_OPTIONS,
		get: () => s.transcriptionProvider,
		set: (v) => (s.transcriptionProvider = v as TranscriptionProviderId),
		rerender: true,
	});

	addText(ctx, {
		name: 'Language',
		desc: 'ISO code (e.g. en, ru, es) or "auto" to detect.',
		get: () => s.transcriptionLanguage,
		set: (v) => (s.transcriptionLanguage = v.trim() || 'auto'),
	});

	addToggle(ctx, {
		name: 'Speaker diarization',
		desc: 'Request speaker labels. Native on Deepgram; best-effort on compatible Whisper endpoints.',
		get: () => s.transcriptionDiarize,
		set: (v) => (s.transcriptionDiarize = v),
	});

	addToggle(ctx, {
		name: 'Word-level timestamps',
		desc: 'Request per-word timing when the provider supports it.',
		get: () => s.transcriptionWordTimestamps,
		set: (v) => (s.transcriptionWordTimestamps = v),
	});

	if (s.transcriptionProvider === 'whisper-api') {
		renderWhisperApiSettings(ctx);
	} else if (s.transcriptionProvider === 'deepgram') {
		renderDeepgramSettings(ctx);
	} else {
		renderLocalWhisperSettings(ctx);
	}

	renderTranscriptOutputSection(ctx);
	renderLlmSection(ctx);
}

/** Whisper API engine fields (chunk size, base URL, key, model). */
function renderWhisperApiSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addSlider(ctx, {
		name: 'Upload chunk size',
		desc: 'Megabytes per WAV chunk when a recording is too large to upload whole (the API limit is 25 MB). Files under the limit are sent untouched.',
		min: MIN_TRANSCRIBE_CHUNK_MB,
		max: MAX_TRANSCRIBE_CHUNK_MB,
		step: 1,
		get: () => s.transcriptionChunkMb,
		set: (v) => (s.transcriptionChunkMb = v),
	});
	addText(ctx, {
		name: 'Whisper API base URL',
		desc: 'OpenAI-compatible endpoint base (e.g. https://api.openai.com/v1 or a Groq URL).',
		get: () => s.whisperApiBaseUrl,
		set: (v) => (s.whisperApiBaseUrl = v),
	});
	addText(ctx, {
		name: 'Whisper API key',
		desc: 'Stored in plugin data on this device. Avoid syncing data.json to untrusted locations.',
		get: () => s.whisperApiKey,
		set: (v) => (s.whisperApiKey = v),
		secret: true,
	});
	addText(ctx, {
		name: 'Whisper model',
		desc: 'Transcription model id (e.g. whisper-1).',
		get: () => s.whisperApiModel,
		set: (v) => (s.whisperApiModel = v),
	});
}

/** Deepgram engine fields (base URL, key, model). */
function renderDeepgramSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addText(ctx, {
		name: 'Deepgram base URL',
		desc: 'Deepgram API base (default https://api.deepgram.com/v1).',
		get: () => s.deepgramBaseUrl,
		set: (v) => (s.deepgramBaseUrl = v),
	});
	addText(ctx, {
		name: 'Deepgram API key',
		desc: 'Stored in plugin data on this device. Avoid syncing data.json to untrusted locations.',
		get: () => s.deepgramApiKey,
		set: (v) => (s.deepgramApiKey = v),
		secret: true,
	});
	addText(ctx, {
		name: 'Deepgram model',
		desc: 'Model id (e.g. nova-3, nova-2). Files up to 2 GB are sent whole for consistent speaker labels.',
		get: () => s.deepgramModel,
		set: (v) => (s.deepgramModel = v),
	});
}

/** Local whisper.cpp engine fields (binary path, model path, extra args). */
function renderLocalWhisperSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addText(ctx, {
		name: 'whisper.cpp binary path',
		desc: 'Absolute path to the whisper.cpp executable.',
		get: () => s.localWhisperBinaryPath,
		set: (v) => (s.localWhisperBinaryPath = v),
	});
	addText(ctx, {
		name: 'Model path',
		desc: 'Absolute path to the whisper model file (.bin).',
		get: () => s.localWhisperModelPath,
		set: (v) => (s.localWhisperModelPath = v),
	});
	addText(ctx, {
		name: 'Extra arguments',
		desc: 'Optional extra CLI arguments, space-separated.',
		get: () => s.localWhisperExtraArgs,
		set: (v) => (s.localWhisperExtraArgs = v),
	});
}

/** Transcript output destination and in-note formatting. */
function renderTranscriptOutputSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Transcript output');

	addDropdown(ctx, {
		name: 'Destination',
		desc: 'Insert into the note, save as a sidecar file, or both.',
		options: [
			{ value: 'note', label: 'Insert into note' },
			{ value: 'file', label: 'Save to file' },
			{ value: 'both', label: 'Note and file' },
		],
		get: () => s.transcriptDestination,
		set: (v) =>
			(s.transcriptDestination = v as typeof s.transcriptDestination),
		rerender: true,
	});

	if (
		s.transcriptDestination === 'file' ||
		s.transcriptDestination === 'both'
	) {
		addDropdown(ctx, {
			name: 'File format',
			desc: 'Format for the transcript sidecar file.',
			options: [
				{ value: 'json', label: 'JSON (full data + speakers)' },
				{ value: 'srt', label: 'SubRip (.srt)' },
				{ value: 'vtt', label: 'WebVTT (.vtt)' },
				{ value: 'txt', label: 'Plain text (.txt)' },
			],
			get: () => s.transcriptFileFormat,
			set: (v) =>
				(s.transcriptFileFormat = v as typeof s.transcriptFileFormat),
		});
	}

	addText(ctx, {
		name: 'Note heading',
		desc: 'Heading inserted above the transcript (empty for none).',
		get: () => s.transcriptHeading,
		set: (v) => (s.transcriptHeading = v),
	});

	addToggle(ctx, {
		name: 'Include timestamps',
		get: () => s.transcriptIncludeTimestamps,
		set: (v) => (s.transcriptIncludeTimestamps = v),
	});

	addToggle(ctx, {
		name: 'Timestamps as player links',
		desc: 'Render each timestamp as a #t= link that jumps the enhanced player.',
		get: () => s.transcriptTimestampLinks,
		set: (v) => (s.transcriptTimestampLinks = v),
	});

	addToggle(ctx, {
		name: 'Include speakers',
		get: () => s.transcriptIncludeSpeakers,
		set: (v) => (s.transcriptIncludeSpeakers = v),
	});

	addToggle(ctx, {
		name: 'Merge speaker turns',
		desc: 'Combine consecutive segments from the same speaker into one line (diarized transcripts only).',
		get: () => s.transcriptMergeConsecutiveSpeaker,
		set: (v) => (s.transcriptMergeConsecutiveSpeaker = v),
	});

	addText(ctx, {
		name: 'Timestamp format',
		desc: 'Template for the timestamp; {time} is the timecode/link.',
		get: () => s.transcriptTimestampFormat,
		set: (v) => (s.transcriptTimestampFormat = v || '[{time}]'),
	});
	addText(ctx, {
		name: 'Speaker format',
		desc: 'Template for the speaker label; {speaker} is the name.',
		get: () => s.transcriptSpeakerFormat,
		set: (v) => (s.transcriptSpeakerFormat = v || '**{speaker}**'),
	});
	addText(ctx, {
		name: 'Line format',
		desc: 'Arrangement of {timestamp} {speaker} {text}.',
		get: () => s.transcriptLineFormat,
		set: (v) =>
			(s.transcriptLineFormat = v || '{timestamp} {speaker} {text}'),
	});
}

/** Optional LLM post-processing of the transcript. */
function renderLlmSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'LLM post-processing');

	addToggle(ctx, {
		name: 'Enable LLM post-processing',
		desc: 'Clean up punctuation/formatting or summarize the transcript with an LLM.',
		get: () => s.llmPostProcessEnabled,
		set: (v) => (s.llmPostProcessEnabled = v),
		rerender: true,
	});
	if (!s.llmPostProcessEnabled) {
		return;
	}

	addDropdown(ctx, {
		name: 'Task',
		options: [
			{ value: 'cleanup', label: 'Clean up (punctuation, formatting)' },
			{ value: 'summary', label: 'Summarize (key points + actions)' },
			{ value: 'custom', label: 'Custom instruction' },
		],
		get: () => s.llmPostProcessTask,
		set: (v) => (s.llmPostProcessTask = v as typeof s.llmPostProcessTask),
		rerender: true,
	});

	if (s.llmPostProcessTask === 'custom') {
		addText(ctx, {
			name: 'Custom instruction',
			desc: 'System instruction applied to the transcript text.',
			get: () => s.llmCustomInstruction,
			set: (v) => (s.llmCustomInstruction = v),
		});
	}

	addDropdown(ctx, {
		name: 'LLM provider',
		options: [
			{ value: 'openai-compatible', label: 'OpenAI / Groq / Ollama' },
			{ value: 'anthropic', label: 'Anthropic (Claude)' },
		],
		get: () => s.llmProvider,
		set: (v) => (s.llmProvider = v as typeof s.llmProvider),
	});
	addText(ctx, {
		name: 'LLM base URL',
		desc: 'API base URL (e.g. https://api.openai.com/v1, http://localhost:11434/v1, or https://api.anthropic.com/v1).',
		get: () => s.llmBaseUrl,
		set: (v) => (s.llmBaseUrl = v),
	});
	addText(ctx, {
		name: 'LLM API key',
		desc: 'Leave empty for a local Ollama server. Stored in plugin data on this device.',
		get: () => s.llmApiKey,
		set: (v) => (s.llmApiKey = v),
		secret: true,
	});
	addText(ctx, {
		name: 'LLM model',
		desc: 'Model id (e.g. gpt-4o-mini, llama3.1, claude-opus-4-8).',
		get: () => s.llmModel,
		set: (v) => (s.llmModel = v),
	});
	addSlider(ctx, {
		name: 'Max output tokens',
		desc: 'Upper bound on the LLM response length.',
		min: MIN_LLM_MAX_TOKENS,
		max: MAX_LLM_MAX_TOKENS,
		step: 512,
		get: () => s.llmMaxTokens,
		set: (v) => (s.llmMaxTokens = v),
	});
}
