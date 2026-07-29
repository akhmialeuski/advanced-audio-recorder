/**
 * The LLM post-processing settings: the task and its editable prompt, plus the
 * vendor fields (provider, base URL, key, model, token budget) that the auto
 * chapters and the advanced two-pass mode share.
 * @module settings/sections/llmSettingsSection
 */

import { MIN_LLM_MAX_TOKENS, MAX_LLM_MAX_TOKENS } from '../../constants';
import {
	advancedTwoPassEnabled,
	applyLlmProviderDefaults,
} from '../settingsSchema';
import { LLM_PROVIDER_OPTIONS, LLM_TASK_OPTIONS } from '../labels';
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
import { selectedLlmVendor } from '../../transcription/llm/vendors';

/** Optional LLM post-processing of the transcript. */
export function renderLlmSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	addHeading(ctx, 'LLM post-processing');

	addToggle(ctx, {
		name: 'Enable LLM post-processing',
		desc: 'Clean up punctuation/formatting or summarize the transcript with an LLM.',
		get: () => s.llmPostProcessEnabled,
		set: (v) => (s.llmPostProcessEnabled = v),
		rerender: true,
	});
	// The provider fields stay visible while auto chapters or the advanced
	// two-pass mode needs them, so enabling either feature alone still
	// exposes the key/model to configure. Two-pass counts only when its master
	// switch is also on, since a stale toggle under an off master does nothing.
	if (
		!s.llmPostProcessEnabled &&
		!s.transcriptionAutoChaptersEnabled &&
		!advancedTwoPassEnabled(s)
	) {
		return;
	}

	if (s.llmPostProcessEnabled) {
		addDropdown(ctx, {
			name: 'Task',
			desc: 'Clean up punctuation/formatting, summarize into key points, or apply a custom instruction.',
			options: LLM_TASK_OPTIONS,
			get: () => s.llmPostProcessTask,
			set: (v) =>
				(s.llmPostProcessTask = v as typeof s.llmPostProcessTask),
			rerender: true,
		});
		renderLlmPromptField(ctx);
	}
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
 * API-key field bound to the selected vendor's key field. Which field that is
 * (OpenAI and Gemini reuse their transcription keys so a vendor token is
 * entered once; Anthropic keeps its own) comes from the vendor registry.
 */
function renderLlmKeyField(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	const vendor = selectedLlmVendor(s);
	addText(ctx, {
		name: vendor.keyFieldName,
		desc: vendor.keyFieldDesc,
		get: () => vendor.settings.apiKey(s),
		set: (v) => vendor.settings.setApiKey(s, v),
		secret: true,
	});
}

/** Model picker bound to the selected vendor's saved, user-editable list. */
function renderLlmModelPicker(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	const vendor = selectedLlmVendor(s);
	addModelPicker(ctx, {
		name: 'LLM model',
		desc: vendor.modelPickerDesc,
		helpLink: {
			label: vendor.modelsDocLabel,
			url: vendor.modelsDocUrl,
		},
		getModels: () => vendor.settings.models(s),
		setModels: (models) => vendor.settings.setModels(s, models),
		getSelected: () => vendor.settings.model(s),
		setSelected: (id) => vendor.settings.setModel(s, id),
	});
}
