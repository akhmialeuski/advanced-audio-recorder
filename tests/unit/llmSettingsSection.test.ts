/**
 * Tests the one LLM field still rendered by hand: the vendor's API key, which
 * is a password field. Which settings property it writes follows the selected
 * provider - OpenAI and Gemini deliberately share their transcription keys
 * while Anthropic keeps its own - so a field bound to the wrong one silently
 * sends the user's key to the wrong vendor, or asks for one already entered.
 * @module tests/unit/llmSettingsSection.test
 */

import { renderLlmSection } from 'src/settings/sections/llmSettingsSection';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { llmVendor } from 'src/transcription/llm/vendors';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
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

describe('renderLlmSection', () => {
	it('renders the selected vendor key field, and nothing else', () => {
		// Everything else in the section is declared; this block is the one row
		// no control type covers.
		render({ llmProvider: LLM_PROVIDER_IDS.ANTHROPIC });

		expect(capturedSettings).toHaveLength(1);
		expect(settingRow(llmVendor(LLM_PROVIDER_IDS.ANTHROPIC).keyFieldName));
	});

	it.each([
		[LLM_PROVIDER_IDS.OPENAI_COMPATIBLE, 'whisperApiKey'],
		[LLM_PROVIDER_IDS.ANTHROPIC, 'anthropicApiKey'],
		[LLM_PROVIDER_IDS.GEMINI, 'geminiApiKey'],
	] as const)(
		'writes the %s key into its own settings field',
		(provider, property) => {
			const { settings } = render({ llmProvider: provider });
			const row = capturedSettings[0]?.name ?? '';

			changeSetting(row, 'text', 'token-value');

			expect(settings[property]).toBe('token-value');
		},
	);

	it('names the field after the vendor, so a shared key says whose it is', () => {
		render({ llmProvider: LLM_PROVIDER_IDS.GEMINI });

		expect(capturedSettings[0]?.name).toBe(
			llmVendor(LLM_PROVIDER_IDS.GEMINI).keyFieldName,
		);
	});
});
