/**
 * Tests the LLM settings section: which rows appear for which combination of
 * features, and that the vendor-bound fields (API key, model list) really
 * follow the selected provider. The key field is the interesting one - OpenAI
 * and Gemini deliberately share their transcription keys while Anthropic keeps
 * its own, so a field bound to the wrong settings property silently sends the
 * user's key to the wrong vendor or asks for one they already entered.
 * @module tests/unit/llmSettingsSection.test
 */

import { renderLlmSection } from 'src/settings/sections/llmSettingsSection';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { DEFAULT_LLM_BASE_URLS } from 'src/transcription/llm/vendors';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
	enterNumberSetting,
	settingRow,
} from '../helpers/captureSettings';

jest.mock('obsidian', () => ({
	Platform: { isMobile: false, isMobileApp: false },
	Setting: jest.requireActual<typeof import('../helpers/captureSettings')>(
		'../helpers/captureSettings',
	).CapturingSetting,
}));

/** Renders the section and returns the settings plus its hooks. */
function render(overrides: Partial<AudioRecorderSettings> = {}): {
	settings: AudioRecorderSettings;
	ctx: SettingsSectionContext;
} {
	capturedSettings.length = 0;
	const settings = mergeSettings(overrides);
	const ctx: SettingsSectionContext = {
		containerEl: document.createElement('div'),
		settings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
	renderLlmSection(ctx);
	return { settings, ctx };
}

/** Names of the rows rendered by the last render(). */
function renderedRows(): string[] {
	return capturedSettings.map((row) => row.name);
}

describe('renderLlmSection visibility', () => {
	it('shows only the master toggle when nothing needs an LLM', () => {
		render({
			llmPostProcessEnabled: false,
			transcriptionAutoChaptersEnabled: false,
			transcriptionAdvancedSettingsEnabled: false,
		});

		expect(renderedRows()).toEqual([
			'LLM post-processing',
			'Enable LLM post-processing',
		]);
	});

	it('keeps the vendor fields for auto chapters while post-processing is off', () => {
		render({
			llmPostProcessEnabled: false,
			transcriptionAutoChaptersEnabled: true,
		});

		const rows = renderedRows();
		// Auto chapters calls the same vendor, so its key and model must stay
		// configurable even with post-processing off.
		expect(rows).toContain('LLM provider');
		expect(rows).toContain('LLM model');
		// ...but the post-processing task and its prompt belong to the feature
		// that is off.
		expect(rows).not.toContain('Task');
	});

	it('keeps the vendor fields for the advanced two-pass mode', () => {
		render({
			llmPostProcessEnabled: false,
			transcriptionAutoChaptersEnabled: false,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		});

		expect(renderedRows()).toContain('LLM provider');
	});

	it('ignores a two-pass toggle left on under an off master switch', () => {
		render({
			llmPostProcessEnabled: false,
			transcriptionAutoChaptersEnabled: false,
			transcriptionAdvancedSettingsEnabled: false,
			transcriptionAdvancedEnabled: true,
		});

		// A stale toggle under an off master does nothing at run time, so it
		// must not keep the vendor fields on screen either.
		expect(renderedRows()).toEqual([
			'LLM post-processing',
			'Enable LLM post-processing',
		]);
	});
});

describe('renderLlmSection task prompts', () => {
	it.each([
		['cleanup', 'Cleanup prompt'],
		['summary', 'Summary prompt'],
		['custom', 'Custom instruction'],
	])('shows the %s prompt field for that task', (task, field) => {
		render({
			llmPostProcessEnabled: true,
			llmPostProcessTask:
				task as AudioRecorderSettings['llmPostProcessTask'],
		});

		const rows = renderedRows();
		expect(rows).toContain(field);
		// Exactly one prompt field: the others belong to the other tasks.
		expect(
			rows.filter((name) =>
				[
					'Cleanup prompt',
					'Summary prompt',
					'Custom instruction',
				].includes(name),
			),
		).toEqual([field]);
	});

	it('edits the prompt of the selected task', () => {
		const { settings } = render({
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'summary',
		});

		changeSetting('Summary prompt', 'text', 'Five bullets, no preamble.');

		expect(settings.llmSummaryPrompt).toBe('Five bullets, no preamble.');
	});

	it('redraws the section when the task changes so the right prompt appears', async () => {
		const { settings, ctx } = render({
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
		});

		await changeSetting('Task', 'dropdown', 'custom');

		expect(settings.llmPostProcessTask).toBe('custom');
		expect(ctx.rerender).toHaveBeenCalled();
	});
});

describe('renderLlmSection vendor binding', () => {
	it.each([
		[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE, 'OpenAI API key', 'whisperApiKey'],
		[LLM_PROVIDER_IDS.ANTHROPIC, 'Anthropic API key', 'anthropicApiKey'],
		[LLM_PROVIDER_IDS.GEMINI, 'Google Gemini API key', 'geminiApiKey'],
	] as const)(
		'binds the key field of %s to its own settings property',
		(provider, fieldName, property) => {
			const { settings } = render({
				llmPostProcessEnabled: true,
				llmProvider: provider,
			});

			changeSetting(fieldName, 'text', 'sk-typed');

			expect(settings[property]).toBe('sk-typed');
		},
	);

	it.each([
		[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE, 'llmOpenAiModel'],
		[LLM_PROVIDER_IDS.ANTHROPIC, 'llmAnthropicModel'],
		[LLM_PROVIDER_IDS.GEMINI, 'llmGeminiModel'],
	] as const)(
		"shows the model list of %s, not another vendor's",
		(provider, property) => {
			const { settings } = render({
				llmPostProcessEnabled: true,
				llmProvider: provider,
			});

			expect(settingRow('LLM model').dropdownValue).toBe(
				settings[property],
			);
		},
	);

	it('moves a still-default base URL to the newly picked provider', async () => {
		const { settings, ctx } = render({
			llmPostProcessEnabled: true,
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmBaseUrl:
				DEFAULT_LLM_BASE_URLS[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE],
		});

		await changeSetting(
			'LLM provider',
			'dropdown',
			LLM_PROVIDER_IDS.ANTHROPIC,
		);

		expect(settings.llmProvider).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
		// Leaving the OpenAI URL behind would point Anthropic requests at the
		// wrong host, with a confusing 404 as the only symptom.
		expect(settings.llmBaseUrl).toBe(
			DEFAULT_LLM_BASE_URLS[LLM_PROVIDER_IDS.ANTHROPIC],
		);
		expect(ctx.rerender).toHaveBeenCalled();
	});

	it('keeps a hand-entered base URL when the provider changes', async () => {
		const { settings } = render({
			llmPostProcessEnabled: true,
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmBaseUrl: 'https://proxy.internal/v1',
		});

		await changeSetting(
			'LLM provider',
			'dropdown',
			LLM_PROVIDER_IDS.ANTHROPIC,
		);

		expect(settings.llmBaseUrl).toBe('https://proxy.internal/v1');
	});

	it('edits the base URL and the token budget', () => {
		const { settings } = render({ llmPostProcessEnabled: true });

		changeSetting('LLM base URL', 'text', 'https://proxy.internal/v1');
		enterNumberSetting('Max output tokens', '4096');

		expect(settings.llmBaseUrl).toBe('https://proxy.internal/v1');
		expect(settings.llmMaxTokens).toBe(4096);
	});
});
