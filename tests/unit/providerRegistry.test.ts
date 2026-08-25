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
	accountKeyMissing,
	accountOf,
	accountRequiresKey,
	accountTranscribes,
	engineAccess,
	enginesOfAccount,
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

	it('lists the engines behind each account, and no others', () => {
		for (const id of EVERY_ACCOUNT_ID) {
			const behind = enginesOfAccount(id);

			expect(behind.map((engine) => engine.id)).toEqual(
				ENGINE_ORDER.filter(
					(engineId) => ENGINES[engineId].account === id,
				),
			);
			expect(behind.every((engine) => engine.account === id)).toBe(true);
		}
	});

	it('says which accounts something transcribes through', () => {
		for (const id of EVERY_ACCOUNT_ID) {
			// The endpoint of an account something transcribes through is a
			// transcription endpoint, whatever else the account also answers.
			// A caller about to write one on another feature's behalf reads
			// this rather than assuming the two are separate fields.
			expect(accountTranscribes(id)).toBe(
				enginesOfAccount(id).some((engine) => engine.transcriptionId),
			);
		}
		expect(accountTranscribes(ACCOUNT_IDS.OPENAI)).toBe(true);
		expect(accountTranscribes(ACCOUNT_IDS.GEMINI)).toBe(true);
		expect(accountTranscribes(ACCOUNT_IDS.DEEPGRAM)).toBe(true);
		expect(accountTranscribes(ACCOUNT_IDS.ANTHROPIC)).toBe(false);
	});
});

// A key is a property of the endpoint, not of the engine. The Base URL row
// exists so a run can be pointed at a compatible server, and the most valuable
// thing to point it at - Ollama, LM Studio, LocalAI, a whisper-server build -
// wants no key at all. Demanding one there sent users to type a decoy string
// that then travelled in a real Authorization header.
describe('which endpoints actually need a key', () => {
	it('requires one at every account default, which is a cloud endpoint', () => {
		for (const id of EVERY_ACCOUNT_ID) {
			expect(accountRequiresKey(ACCOUNTS[id], mergeSettings({}))).toBe(
				true,
			);
		}
	});

	it('requires none once the endpoint has been repointed', () => {
		for (const id of EVERY_ACCOUNT_ID) {
			const settings = mergeSettings({});
			ACCOUNTS[id].setBaseUrl(settings, 'http://localhost:1234/v1');

			expect(accountRequiresKey(ACCOUNTS[id], settings)).toBe(false);
		}
	});

	// The path and a trailing slash are the user's business; what identifies
	// the vendor's own endpoint is the host it answers on.
	it('still requires one when only the path or slash differs', () => {
		const settings = mergeSettings({});
		ACCOUNTS[ACCOUNT_IDS.OPENAI].setBaseUrl(
			settings,
			'https://api.openai.com/v1/',
		);

		expect(accountRequiresKey(ACCOUNTS[ACCOUNT_IDS.OPENAI], settings)).toBe(
			true,
		);
	});

	// Another vendor's cloud host does want a key, but saying so here would be
	// guessing: it answers 401 itself, in its own wording, which is the one
	// answer that is never wrong.
	it('leaves another host to refuse the request itself', () => {
		const settings = mergeSettings({});
		ACCOUNTS[ACCOUNT_IDS.OPENAI].setBaseUrl(
			settings,
			'https://api.groq.com/openai/v1',
		);

		expect(accountRequiresKey(ACCOUNTS[ACCOUNT_IDS.OPENAI], settings)).toBe(
			false,
		);
	});

	it("treats an unparsable endpoint as the user's own", () => {
		const settings = mergeSettings({});
		ACCOUNTS[ACCOUNT_IDS.GEMINI].setBaseUrl(settings, 'not a url');

		expect(accountRequiresKey(ACCOUNTS[ACCOUNT_IDS.GEMINI], settings)).toBe(
			false,
		);
	});

	// An emptied field is the default endpoint, which is where a key is needed.
	it('requires one again when the endpoint is cleared', () => {
		const settings = mergeSettings({});
		ACCOUNTS[ACCOUNT_IDS.DEEPGRAM].setBaseUrl(settings, '');

		expect(
			accountRequiresKey(ACCOUNTS[ACCOUNT_IDS.DEEPGRAM], settings),
		).toBe(true);
	});
});

// The composite every surface asks - both factories, the refusal a command
// line answers with, the engine summary, the count of configured accounts.
// Each of them used to read the key on its own, so a copy that was not brought
// along when the rule moved onto the endpoint did not fail: it disagreed.
describe('whether an account is short of the key a run needs', () => {
	/** Settings selecting an account with an empty key. */
	function withNoKey(accountId: AccountId): AudioRecorderSettings {
		const settings = mergeSettings({});
		ACCOUNTS[accountId].setApiKey(settings, '');
		return settings;
	}

	it('is short of one at the default endpoint, which is the cloud', () => {
		expect(
			accountKeyMissing(
				ACCOUNTS[ACCOUNT_IDS.OPENAI],
				withNoKey(ACCOUNT_IDS.OPENAI),
			),
		).toBe(true);
	});

	it('is not short of one the endpoint never wanted', () => {
		const settings = withNoKey(ACCOUNT_IDS.OPENAI);
		ACCOUNTS[ACCOUNT_IDS.OPENAI].setBaseUrl(
			settings,
			'http://localhost:11434/v1',
		);

		expect(accountKeyMissing(ACCOUNTS[ACCOUNT_IDS.OPENAI], settings)).toBe(
			false,
		);
	});

	it('is not short of one it holds', () => {
		const settings = mergeSettings({});
		ACCOUNTS[ACCOUNT_IDS.GEMINI].setApiKey(settings, 'k');

		expect(accountKeyMissing(ACCOUNTS[ACCOUNT_IDS.GEMINI], settings)).toBe(
			false,
		);
	});

	// The two halves are one question, and asking them apart is what let the
	// answers drift. Every account is checked, so a new one arrives answered.
	it.each(Object.values(ACCOUNT_IDS))(
		'reads %s as its two halves together',
		(accountId) => {
			const account = ACCOUNTS[accountId];
			const settings = withNoKey(accountId);

			expect(accountKeyMissing(account, settings)).toBe(
				accountRequiresKey(account, settings),
			);
		},
	);
});
