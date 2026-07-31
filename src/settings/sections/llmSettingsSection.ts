/**
 * The one LLM field that is not a declared control: the vendor's API key, which
 * is a password field. Which settings field that key lives in - OpenAI and
 * Gemini reuse their transcription keys so a vendor token is entered once,
 * Anthropic keeps its own - comes from the vendor registry.
 * @module settings/sections/llmSettingsSection
 */

import { addText, type SettingsSectionContext } from '../settingControls';
import { selectedLlmVendor } from '../../transcription/llm/vendors';

/**
 * Renders the selected vendor's API-key field.
 * @param ctx - Section context
 */
export function renderLlmSection(ctx: SettingsSectionContext): void {
	const s = ctx.settings;
	const vendor = selectedLlmVendor(s);
	addText(ctx, {
		name: vendor.keyFieldName,
		desc: vendor.keyFieldDesc,
		helpLink: {
			label: vendor.modelsDocLabel,
			url: vendor.modelsDocUrl,
		},
		get: () => vendor.settings.apiKey(s),
		set: (v) => vendor.settings.setApiKey(s, v),
		secret: true,
	});
}
