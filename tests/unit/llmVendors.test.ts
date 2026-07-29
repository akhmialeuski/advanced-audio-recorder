/**
 * Tests for the LLM vendor registry: it must describe every provider id the
 * settings can hold, and every consumer (cost model, factory, settings UI,
 * migrations) must resolve a vendor through it rather than falling back to
 * OpenAI for an id it does not recognise.
 */

import {
	DEFAULT_LLM_BASE_URLS,
	LLM_VENDOR_IDS,
	LLM_VENDORS,
	llmVendor,
	selectedLlmVendor,
} from 'src/transcription/llm/vendors';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { resolveLlmPricing, selectedLlmModel } from 'src/transcription/costs';
import {
	createLlmProvider,
	ProviderConfigError,
} from 'src/transcription/factories';
import {
	LLM_PROVIDER_LABELS,
	LLM_PROVIDER_OPTIONS,
	LLM_PROVIDER_PRICING_URLS,
} from 'src/settings/labels';
import type { LlmProviderId } from 'src/settings/settingsSchema';

/** Every id the settings type admits, listed independently of the registry. */
const EVERY_PROVIDER_ID: LlmProviderId[] = [
	LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
	LLM_PROVIDER_IDS.ANTHROPIC,
	LLM_PROVIDER_IDS.GEMINI,
];

describe('LLM vendor registry', () => {
	it('describes every provider id', () => {
		expect(LLM_VENDOR_IDS.slice().sort()).toEqual(
			EVERY_PROVIDER_ID.slice().sort(),
		);
		for (const id of EVERY_PROVIDER_ID) {
			expect(llmVendor(id).id).toBe(id);
		}
	});

	it('gives every vendor the fields its consumers read', () => {
		for (const id of LLM_VENDOR_IDS) {
			const vendor = LLM_VENDORS[id];
			expect(vendor.label).toBeTruthy();
			expect(vendor.defaultBaseUrl).toMatch(/^https:\/\//);
			expect(vendor.pricingUrl).toMatch(/^https:\/\//);
			expect(vendor.modelsDocUrl).toMatch(/^https:\/\//);
			expect(vendor.modelsDocLabel).toBeTruthy();
			expect(vendor.modelPickerDesc).toBeTruthy();
			expect(vendor.keyFieldName).toBeTruthy();
			expect(vendor.keyFieldDesc).toBeTruthy();
			expect(vendor.missingKeyMessage).toBeTruthy();
			expect(vendor.rates.length).toBeGreaterThan(0);
		}
	});

	it('routes each vendor to its own settings fields', () => {
		const settings = mergeSettings();
		for (const id of LLM_VENDOR_IDS) {
			const vendor = LLM_VENDORS[id];
			vendor.settings.setApiKey(settings, `key-${id}`);
			vendor.settings.setModel(settings, `model-${id}`);
			vendor.settings.setModels(settings, [`model-${id}`]);
		}
		// Writing every vendor's fields must not have them overwrite each other.
		for (const id of LLM_VENDOR_IDS) {
			const vendor = LLM_VENDORS[id];
			expect(vendor.settings.apiKey(settings)).toBe(`key-${id}`);
			expect(vendor.settings.model(settings)).toBe(`model-${id}`);
			expect(vendor.settings.models(settings)).toEqual([`model-${id}`]);
		}
	});

	it('collects the shipped base URLs for the auto-switch guard', () => {
		expect(DEFAULT_LLM_BASE_URLS.size).toBe(LLM_VENDOR_IDS.length);
		for (const id of LLM_VENDOR_IDS) {
			expect(
				DEFAULT_LLM_BASE_URLS.has(LLM_VENDORS[id].defaultBaseUrl),
			).toBe(true);
		}
	});
});

describe('registry-derived consumers stay in step', () => {
	it('derives the labels, options, and pricing URLs from the registry', () => {
		for (const id of LLM_VENDOR_IDS) {
			expect(LLM_PROVIDER_LABELS[id]).toBe(LLM_VENDORS[id].label);
			expect(LLM_PROVIDER_PRICING_URLS[id]).toBe(
				LLM_VENDORS[id].pricingUrl,
			);
		}
		expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).toEqual(
			LLM_VENDOR_IDS,
		);
	});

	it('prices and selects the model of the vendor actually configured', () => {
		for (const id of LLM_VENDOR_IDS) {
			const vendor = LLM_VENDORS[id];
			const settings = mergeSettings({ llmProvider: id });
			// The registry, not a per-consumer switch, decides which field holds
			// the model; a vendor left out of a consumer used to silently read
			// OpenAI's.
			expect(selectedLlmModel(settings)).toBe(
				vendor.settings.model(settings),
			);
			expect(selectedLlmVendor(settings)).toBe(vendor);
			// Every seeded default model must be priced by its own vendor's table.
			expect(
				resolveLlmPricing(id, vendor.settings.model(settings)),
			).not.toBeNull();
		}
	});

	it('builds each vendor from its own key and refuses without one', () => {
		for (const id of LLM_VENDOR_IDS) {
			const vendor = LLM_VENDORS[id];
			const missing = mergeSettings({ llmProvider: id });
			vendor.settings.setApiKey(missing, '');
			expect(() => createLlmProvider(missing)).toThrow(
				ProviderConfigError,
			);
			expect(() => createLlmProvider(missing)).toThrow(
				vendor.missingKeyMessage,
			);

			const configured = mergeSettings({ llmProvider: id });
			vendor.settings.setApiKey(configured, 'token');
			expect(createLlmProvider(configured).id).toBe(id);
		}
	});
});
