/**
 * Tests for the provider registry, which is the one description of the
 * services the plugin calls. Two readers depend on it in different ways: the
 * settings tab binds controls to the keys it names, and a run reads the values
 * through its accessors, so a key and the accessor beside it have to address
 * the same field. Nothing else checks that, because nothing else can see both.
 * @module tests/unit/providerRegistry.test
 */

import {
	ACCOUNTS,
	ACCOUNT_IDS,
	ENGINES,
	ENGINE_IDS,
	ENGINE_ORDER,
	accountOf,
	engineAccess,
	missingModelMessage,
	vendorConnection,
	vendorMaxTokens,
	type AccountId,
} from 'src/providers/providers';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

/** Every account id, listed independently of the registry. */
const EVERY_ACCOUNT_ID: AccountId[] = [
	ACCOUNT_IDS.OPENAI,
	ACCOUNT_IDS.DEEPGRAM,
	ACCOUNT_IDS.GEMINI,
	ACCOUNT_IDS.ANTHROPIC,
];

/** Reads a settings field by the key a descriptor names. */
const at = (
	settings: AudioRecorderSettings,
	key: keyof AudioRecorderSettings,
): unknown => (settings as unknown as Record<string, unknown>)[key];

describe('provider registry', () => {
	it('describes every account id', () => {
		expect(Object.keys(ACCOUNTS).sort()).toEqual(
			EVERY_ACCOUNT_ID.slice().sort(),
		);
	});

	it('names the same field its accessors read and write', () => {
		// The settings tab declares a control against `baseUrlKey`, while the
		// run reads `baseUrl()`. A copy-paste between two accounts would leave
		// the tab editing one provider and the run calling another.
		const settings = mergeSettings();
		for (const id of EVERY_ACCOUNT_ID) {
			const account = ACCOUNTS[id];
			account.setBaseUrl(settings, `url-${id}`);
			account.setApiKey(settings, `key-${id}`);

			expect(at(settings, account.baseUrlKey)).toBe(`url-${id}`);
			expect(at(settings, account.apiKeyKey)).toBe(`key-${id}`);
			expect(account.baseUrl(settings)).toBe(`url-${id}`);
			expect(account.apiKey(settings)).toBe(`key-${id}`);
		}
	});

	it('ships each account endpoint as the default of the field it names', () => {
		// The shipped endpoint is declared once, in the settings defaults. The
		// migration that carries a superseded URL forward compares against it,
		// so an account naming the wrong key would silently stop migrating.
		for (const id of EVERY_ACCOUNT_ID) {
			const account = ACCOUNTS[id];

			expect(account.baseUrl(DEFAULT_SETTINGS)).toBe(
				at(DEFAULT_SETTINGS, account.baseUrlKey),
			);
			expect(account.baseUrl(DEFAULT_SETTINGS)).toMatch(/^https:\/\//);
			expect(account.apiKey(DEFAULT_SETTINGS)).toBe('');
		}
	});

	it('names the same catalogue fields its accessors read and write', () => {
		const settings = mergeSettings();
		for (const id of ENGINE_ORDER) {
			const models = ENGINES[id].models;
			if (!models) {
				continue;
			}
			models.setModel(settings, `model-${id}`);
			models.setModels(settings, [`model-${id}`]);

			expect(at(settings, models.modelKey)).toBe(`model-${id}`);
			expect(at(settings, models.modelsKey)).toEqual([`model-${id}`]);
		}
	});

	it('gives every engine reached over an account both halves of it', () => {
		for (const id of ENGINE_ORDER) {
			const engine = ENGINES[id];
			// An endpoint with no catalogue would be an engine a run could
			// reach but never name a model for.
			expect(Boolean(accountOf(engine))).toBe(Boolean(engine.models));
			if (!engine.account) {
				continue;
			}
			const access = engineAccess(id);

			expect(access.engine).toBe(engine);
			expect(access.account).toBe(ACCOUNTS[engine.account]);
			expect(access.models).toBe(engine.models);
		}
	});

	it('refuses to resolve an account for the engine that has none', () => {
		expect(() => engineAccess(ENGINE_IDS.LOCAL_WHISPER)).toThrow(
			/not reached over an account/,
		);
	});

	it('names the engine in the message a run gives for an empty catalogue', () => {
		for (const id of ENGINE_ORDER) {
			expect(missingModelMessage(ENGINES[id])).toContain(
				ENGINES[id].label,
			);
		}
	});

	it('reaches every LLM vendor account and ceiling through the registry', () => {
		const settings = mergeSettings();
		for (const id of ENGINE_ORDER) {
			const engine = ENGINES[id];
			if (!engine.llmId) {
				continue;
			}
			expect(vendorConnection(engine.llmId)).toBe(accountOf(engine));
			expect(vendorMaxTokens(settings, engine.llmId)).toBe(
				engine.maxTokens?.get(settings),
			);
		}
	});
});
