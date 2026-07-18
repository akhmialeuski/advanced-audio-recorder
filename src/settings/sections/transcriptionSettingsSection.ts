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
	MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
	MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
	MIN_LLM_MAX_TOKENS,
	MAX_LLM_MAX_TOKENS,
	TRANSCRIPTION_PROVIDER_IDS,
	LLM_PROVIDER_IDS,
	WHISPER_API_MODELS_DOC_URL,
	DEEPGRAM_MODELS_DOC_URL,
	GEMINI_MODELS_DOC_URL,
	OPENAI_MODELS_DOC_URL,
	ANTHROPIC_MODELS_DOC_URL,
	LOCAL_WHISPER_MODEL_NAMES,
	LOCAL_WHISPER_MODELS_DOC_URL,
} from '../../constants';
import {
	applyLlmProviderDefaults,
	type TranscriptionProviderId,
} from '../settingsSchema';
import {
	LLM_PROVIDER_OPTIONS,
	LLM_TASK_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
} from '../labels';
import {
	addDropdown,
	addHeading,
	addModelPicker,
	addNumberInput,
	addText,
	addTextArea,
	addToggle,
	type SettingsSectionContext,
} from '../settingControls';
import {
	effectiveDiarize,
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
} from '../../transcription/providers/capabilities';
import {
	createDictionaryProfile,
	findProfile,
	removeProfile,
} from '../dictionaryProfiles';
import { Setting } from 'obsidian';

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
		desc: 'Whisper API, Deepgram, or Google Gemini (cloud), or a local whisper.cpp binary (desktop). Engines this device cannot run are shown blocked.',
		// Engines the platform cannot run stay listed but blocked, so the
		// dropdown reads the same on every device.
		options: TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => ({
			...option,
			disabled: !isProviderAvailableOnPlatform(
				option.value as TranscriptionProviderId,
			),
		})),
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

	const canDiarize = providerSupportsDiarization(s.transcriptionProvider);
	addToggle(ctx, {
		name: 'Speaker diarization',
		desc: canDiarize
			? 'Request speaker labels. Speaker count is detected automatically.'
			: 'Not supported by the selected engine. Use Deepgram for speaker labels.',
		// Reflect the effective state: a stored "on" reads as off for an engine
		// that cannot diarize, so the control never claims a result it cannot give.
		get: () =>
			effectiveDiarize(s.transcriptionProvider, s.transcriptionDiarize),
		set: (v) => (s.transcriptionDiarize = v),
		disabled: !canDiarize,
		// Re-render so the speaker-related output controls below enable or
		// disable in step with diarization the moment this toggle changes.
		rerender: true,
	});

	addToggle(ctx, {
		name: 'Word-level timestamps',
		desc: 'Request per-word timing when the provider supports it. Recorded in JSON file output only.',
		get: () => s.transcriptionWordTimestamps,
		set: (v) => (s.transcriptionWordTimestamps = v),
	});

	renderDictionaryProfiles(ctx);

	// Cloud engines only: a hung network request is bounded by this limit. Local
	// whisper.cpp runs no HTTP request, so the timeout does not apply to it.
	if (s.transcriptionProvider !== TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER) {
		addNumberInput(ctx, {
			name: 'Request timeout',
			desc: 'Minutes before a single transcription request (one part of a long recording) is aborted and reported as failed, so a stalled request cannot hang the run indefinitely.',
			min: MIN_TRANSCRIPTION_TIMEOUT_MINUTES,
			max: MAX_TRANSCRIPTION_TIMEOUT_MINUTES,
			step: 1,
			get: () => s.transcriptionTimeoutMinutes,
			set: (v) => (s.transcriptionTimeoutMinutes = v),
		});
	}

	if (s.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.WHISPER_API) {
		renderWhisperApiSettings(ctx);
	} else if (
		s.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM
	) {
		renderDeepgramSettings(ctx);
	} else if (s.transcriptionProvider === TRANSCRIPTION_PROVIDER_IDS.GEMINI) {
		renderGeminiSettings(ctx);
	} else {
		renderLocalWhisperSettings(ctx);
	}

	renderTranscriptOutputSection(ctx);
	renderLlmSection(ctx);
}

/**
 * Renders the dictionary-profile manager: a selector plus a single editor for
 * the chosen profile's name and terms, with add and remove. The editor is
 * engine-independent (a profile is just stored text); whether and how the terms
 * bias recognition is decided at transcription time by planDictionaryBias. The
 * per-run profile (or None) is chosen in the Transcribe dialog and remembered.
 * @param ctx - The section context (container plus save/rerender hooks)
 */
function renderDictionaryProfiles(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	const profiles = s.transcriptionDictionaryProfiles;
	addHeading(ctx, 'Dictionary profiles');

	// The profile edited here is the persisted run selection when that is a real
	// profile, otherwise the first profile (shown for editing without changing a
	// stored None default until the user actually picks from the selector).
	const editingId = findProfile(profiles, s.transcriptionDictionaryProfileId)
		? s.transcriptionDictionaryProfileId
		: (profiles[0]?.id ?? '');

	const selector = new Setting(ctx.containerEl)
		.setName('Profile')
		.setDesc(
			'Named glossaries of names, abbreviations, and domain terms. Pick one, ' +
				'or None, per run in the Transcribe dialog; the last pick is remembered. ' +
				'Whether the terms bias recognition depends on the selected engine, and ' +
				'for Deepgram on the model; a run reports any terms it could not apply.',
		);
	if (profiles.length > 0) {
		selector.addDropdown((dropdown) => {
			for (const profile of profiles) {
				dropdown.addOption(profile.id, profile.name);
			}
			dropdown.setValue(editingId).onChange(async (id) => {
				// Selecting a profile to edit also makes it the run default.
				s.transcriptionDictionaryProfileId = id;
				await ctx.save();
				ctx.rerender();
			});
		});
	}
	selector.addExtraButton((button) =>
		button
			.setIcon('plus')
			.setTooltip('Add profile')
			.onClick(async () => {
				const created = createDictionaryProfile('New profile');
				s.transcriptionDictionaryProfiles = [...profiles, created];
				// Select the new profile so its fields open for editing.
				s.transcriptionDictionaryProfileId = created.id;
				await ctx.save();
				ctx.rerender();
			}),
	);
	if (profiles.length > 0) {
		selector.addExtraButton((button) =>
			button
				.setIcon('trash')
				.setTooltip('Remove profile')
				.onClick(async () => {
					const next = removeProfile(profiles, editingId);
					s.transcriptionDictionaryProfiles = next;
					// Fall back to the first remaining profile, or None.
					s.transcriptionDictionaryProfileId = next[0]?.id ?? '';
					await ctx.save();
					ctx.rerender();
				}),
		);
	}

	const selected = findProfile(profiles, editingId);
	if (!selected) {
		// Empty list: the Add button above creates the first profile.
		return;
	}
	addText(ctx, {
		name: 'Profile name',
		// Name and terms edits mutate the live profile and save debounced, so the
		// caret is kept; the selector label refreshes on the next re-render.
		get: () => selected.name,
		set: (v) => (selected.name = v),
	});
	addTextArea(ctx, {
		name: 'Terms',
		desc: 'One term per line. A term may contain spaces; blank lines and case-insensitive duplicates are ignored.',
		get: () => selected.terms,
		set: (v) => (selected.terms = v),
		rows: 6,
	});
}

/** Whisper API engine fields (chunk size, base URL, key, model). */
function renderWhisperApiSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addNumberInput(ctx, {
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
	addModelPicker(ctx, {
		name: 'Whisper model',
		desc: 'OpenAI: whisper-1. Groq and other hosts: whisper-large-v3, whisper-large-v3-turbo. The model must support verbose_json with timestamps.',
		helpLink: {
			label: 'Whisper API models',
			url: WHISPER_API_MODELS_DOC_URL,
		},
		getModels: () => s.whisperApiModels,
		setModels: (models) => (s.whisperApiModels = models),
		getSelected: () => s.whisperApiModel,
		setSelected: (id) => (s.whisperApiModel = id),
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
	addModelPicker(ctx, {
		name: 'Deepgram model',
		desc: 'Pick a Deepgram model (e.g. nova-3, nova-2-meeting, enhanced-phonecall). Files up to 2 GB are sent whole for consistent speaker labels.',
		helpLink: {
			label: 'Deepgram model list',
			url: DEEPGRAM_MODELS_DOC_URL,
		},
		getModels: () => s.deepgramModels,
		setModels: (models) => (s.deepgramModels = models),
		getSelected: () => s.deepgramModel,
		setSelected: (id) => (s.deepgramModel = id),
	});
}

/** Google Gemini engine fields (base URL, key, model). */
function renderGeminiSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addText(ctx, {
		name: 'Gemini base URL',
		desc: 'Gemini API base (default https://generativelanguage.googleapis.com).',
		get: () => s.geminiBaseUrl,
		set: (v) => (s.geminiBaseUrl = v),
	});
	addText(ctx, {
		name: 'Gemini API key',
		desc: 'Stored in plugin data on this device. Avoid syncing data.json to untrusted locations.',
		get: () => s.geminiApiKey,
		set: (v) => (s.geminiApiKey = v),
		secret: true,
	});
	addModelPicker(ctx, {
		name: 'Gemini model',
		desc: 'Pick a Gemini model (e.g. gemini-2.5-flash, gemini-2.5-pro). The whole recording is uploaded via the File API for consistent speaker labels.',
		helpLink: {
			label: 'Gemini model list',
			url: GEMINI_MODELS_DOC_URL,
		},
		getModels: () => s.geminiModels,
		setModels: (models) => (s.geminiModels = models),
		getSelected: () => s.geminiModel,
		setSelected: (id) => (s.geminiModel = id),
	});
}

/** Local whisper.cpp engine fields (binary path, model path, extra args). */
function renderLocalWhisperSettings(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	// A stored local-whisper selection synced to a platform that cannot
	// run it (mobile) keeps its fields visible but blocked, so the user
	// sees why transcription will not run instead of editable settings
	// that quietly do nothing.
	const unavailable = !isProviderAvailableOnPlatform(
		TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
	);
	const unavailableHint = unavailable
		? ' Local whisper.cpp is not available on this device; pick a cloud engine to transcribe here.'
		: '';
	addText(ctx, {
		name: 'whisper.cpp binary path',
		desc: `Absolute path to the whisper.cpp executable.${unavailableHint}`,
		get: () => s.localWhisperBinaryPath,
		set: (v) => (s.localWhisperBinaryPath = v),
		disabled: unavailable,
	});
	addText(ctx, {
		name: 'Model path',
		desc: `Absolute path to a GGML model file (.bin). Download one of: ${LOCAL_WHISPER_MODEL_NAMES.join(', ')} (names ending in .en are English-only).`,
		helpLink: {
			label: 'Download whisper.cpp models',
			url: LOCAL_WHISPER_MODELS_DOC_URL,
		},
		get: () => s.localWhisperModelPath,
		set: (v) => (s.localWhisperModelPath = v),
		disabled: unavailable,
	});
	addText(ctx, {
		name: 'Extra arguments',
		desc: 'Optional extra CLI arguments, space-separated.',
		get: () => s.localWhisperExtraArgs,
		set: (v) => (s.localWhisperExtraArgs = v),
		disabled: unavailable,
	});
}

/** Transcript output destination and in-note formatting. */
function renderTranscriptOutputSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'Transcript output');

	// Speaker labels only exist when diarization is actually in effect (the
	// engine can diarize AND the user enabled it), so the speaker-related
	// output controls are inert without it. Disable and dim them, like the
	// Speaker diarization toggle, so they read as unavailable rather than as
	// settings that quietly do nothing.
	const diarizes = effectiveDiarize(
		s.transcriptionProvider,
		s.transcriptionDiarize,
	);
	const speakerDisabledHint =
		'Available only with speaker diarization; the current engine and settings produce no speaker labels.';

	addDropdown(ctx, {
		name: 'Destination',
		desc: 'Insert into the note, save as a sidecar file, both, or save a file and link it in the note.',
		options: TRANSCRIPT_DESTINATION_OPTIONS,
		get: () => s.transcriptDestination,
		set: (v) =>
			(s.transcriptDestination = v as typeof s.transcriptDestination),
		rerender: true,
	});

	if (s.transcriptDestination !== 'note') {
		addDropdown(ctx, {
			name: 'File format',
			desc: 'Format for the transcript sidecar file.',
			options: TRANSCRIPT_FILE_FORMAT_OPTIONS,
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
		desc: diarizes ? undefined : speakerDisabledHint,
		get: () => s.transcriptIncludeSpeakers,
		set: (v) => (s.transcriptIncludeSpeakers = v),
		disabled: !diarizes,
	});

	addToggle(ctx, {
		name: 'Merge speaker turns',
		desc: diarizes
			? 'Combine consecutive segments from the same speaker into one line (diarized transcripts only).'
			: speakerDisabledHint,
		get: () => s.transcriptMergeConsecutiveSpeaker,
		set: (v) => (s.transcriptMergeConsecutiveSpeaker = v),
		disabled: !diarizes,
	});

	addText(ctx, {
		name: 'Timestamp format',
		desc: 'Template for the timestamp; {time} is the timecode/link. Avoid wrapping {time} in [ ] when timestamp links are on.',
		get: () => s.transcriptTimestampFormat,
		set: (v) => (s.transcriptTimestampFormat = v || '{time}'),
	});
	addText(ctx, {
		name: 'Speaker format',
		desc: diarizes
			? 'Template for the speaker label; {speaker} is the name.'
			: speakerDisabledHint,
		get: () => s.transcriptSpeakerFormat,
		set: (v) => (s.transcriptSpeakerFormat = v || '**{speaker}**'),
		disabled: !diarizes,
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
		desc: 'Clean up punctuation/formatting, summarize into key points, or apply a custom instruction.',
		options: LLM_TASK_OPTIONS,
		get: () => s.llmPostProcessTask,
		set: (v) => (s.llmPostProcessTask = v as typeof s.llmPostProcessTask),
		rerender: true,
	});

	renderLlmPromptField(ctx);
	renderLlmProviderFields(ctx);
}

/**
 * Editable prompt for the selected task. Cleanup and summary expose their
 * (language-agnostic) base prompt with the language clause appended at request
 * time; custom is sent verbatim and gets a larger field.
 */
function renderLlmPromptField(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	if (s.llmPostProcessTask === 'cleanup') {
		addTextArea(ctx, {
			name: 'Cleanup prompt',
			desc: 'System instruction for the cleanup pass. The transcript language is appended automatically. Leave empty to use the built-in default.',
			get: () => s.llmCleanupPrompt,
			set: (v) => (s.llmCleanupPrompt = v),
		});
		return;
	}
	if (s.llmPostProcessTask === 'summary') {
		addTextArea(ctx, {
			name: 'Summary prompt',
			desc: 'System instruction for the summary pass. The transcript language is appended automatically. Leave empty to use the built-in default.',
			get: () => s.llmSummaryPrompt,
			set: (v) => (s.llmSummaryPrompt = v),
		});
		return;
	}
	addTextArea(ctx, {
		name: 'Custom instruction',
		desc: 'System instruction applied to the transcript text. Sent verbatim - include any language directive yourself.',
		get: () => s.llmCustomInstruction,
		set: (v) => (s.llmCustomInstruction = v),
		rows: 8,
	});
}

/** Provider dropdown, shared vendor key, base URL, model picker, token budget. */
function renderLlmProviderFields(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addDropdown(ctx, {
		name: 'LLM provider',
		options: LLM_PROVIDER_OPTIONS,
		get: () => s.llmProvider,
		set: (v) => {
			// Move the base URL to the picked provider's default when it is still
			// a default, so choosing Anthropic does not leave an OpenAI URL behind
			// (and vice versa). The model is per-provider and switches on its own.
			const provider = v as typeof s.llmProvider;
			applyLlmProviderDefaults(s, provider);
			s.llmProvider = provider;
		},
		rerender: true,
	});
	addText(ctx, {
		name: 'LLM base URL',
		desc: 'API base URL (e.g. https://api.openai.com/v1, https://api.anthropic.com/v1, or https://generativelanguage.googleapis.com).',
		get: () => s.llmBaseUrl,
		set: (v) => (s.llmBaseUrl = v),
	});
	renderLlmKeyField(ctx);
	renderLlmModelPicker(ctx);
	addNumberInput(ctx, {
		name: 'Max output tokens',
		desc: 'Upper bound on the LLM response length.',
		min: MIN_LLM_MAX_TOKENS,
		max: MAX_LLM_MAX_TOKENS,
		step: 512,
		get: () => s.llmMaxTokens,
		set: (v) => (s.llmMaxTokens = v),
	});
}

/**
 * API-key field bound to the shared per-vendor key. OpenAI and Gemini reuse the
 * transcription key (so a vendor token is entered once); Anthropic keeps its
 * own.
 */
function renderLlmKeyField(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	if (s.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC) {
		addText(ctx, {
			name: 'Anthropic API key',
			desc: 'Stored in plugin data on this device.',
			get: () => s.anthropicApiKey,
			set: (v) => (s.anthropicApiKey = v),
			secret: true,
		});
		return;
	}
	if (s.llmProvider === LLM_PROVIDER_IDS.GEMINI) {
		addText(ctx, {
			name: 'Google Gemini API key',
			desc: 'Shared with the Gemini transcription engine - set it in either place.',
			get: () => s.geminiApiKey,
			set: (v) => (s.geminiApiKey = v),
			secret: true,
		});
		return;
	}
	addText(ctx, {
		name: 'OpenAI API key',
		desc: 'Shared with the Whisper API transcription engine - set it in either place.',
		get: () => s.whisperApiKey,
		set: (v) => (s.whisperApiKey = v),
		secret: true,
	});
}

/** Model picker bound to the selected provider's saved, user-editable list. */
function renderLlmModelPicker(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	if (s.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC) {
		addModelPicker(ctx, {
			name: 'LLM model',
			desc: 'Pick an Anthropic model (e.g. claude-opus-4-8, claude-sonnet-4-6).',
			helpLink: {
				label: 'Anthropic models',
				url: ANTHROPIC_MODELS_DOC_URL,
			},
			getModels: () => s.llmAnthropicModels,
			setModels: (models) => (s.llmAnthropicModels = models),
			getSelected: () => s.llmAnthropicModel,
			setSelected: (id) => (s.llmAnthropicModel = id),
		});
		return;
	}
	if (s.llmProvider === LLM_PROVIDER_IDS.GEMINI) {
		addModelPicker(ctx, {
			name: 'LLM model',
			desc: 'Pick a Gemini model (e.g. gemini-2.5-flash, gemini-2.5-pro).',
			helpLink: {
				label: 'Gemini model list',
				url: GEMINI_MODELS_DOC_URL,
			},
			getModels: () => s.llmGeminiModels,
			setModels: (models) => (s.llmGeminiModels = models),
			getSelected: () => s.llmGeminiModel,
			setSelected: (id) => (s.llmGeminiModel = id),
		});
		return;
	}
	addModelPicker(ctx, {
		name: 'LLM model',
		desc: 'Pick an OpenAI model (e.g. gpt-4o-mini, gpt-4o).',
		helpLink: {
			label: 'OpenAI models',
			url: OPENAI_MODELS_DOC_URL,
		},
		getModels: () => s.llmOpenAiModels,
		setModels: (models) => (s.llmOpenAiModels = models),
		getSelected: () => s.llmOpenAiModel,
		setSelected: (id) => (s.llmOpenAiModel = id),
	});
}
