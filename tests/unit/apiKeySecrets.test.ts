/**
 * Unit tests for keeping the provider API keys in Obsidian's keychain: moving
 * a plain-text key into it, and resolving each account's key from it.
 * @module tests/unit/apiKeySecrets.test
 */

import { SecretStorage } from '../mocks/obsidian';
import { internalsOf } from '../helpers/doubles';
import {
	migrateApiKeysToSecrets,
	normalizeApiKeySecretIds,
	readableSecretId,
	resolveApiKeys,
} from 'src/settings/apiKeySecrets';
import { ACCOUNTS, ACCOUNT_IDS } from 'src/providers/providers';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';

/**
 * Settings holding the given fields over the shipped defaults, and a keychain
 * holding the given secrets.
 * @param fields - Settings fields that differ from the defaults
 * @param secrets - Secrets already in the keychain, by ID
 */
function createSut(
	fields: Partial<AudioRecorderSettings> = {},
	secrets: Record<string, string> = {},
): { settings: AudioRecorderSettings; store: SecretStorage } {
	const store = new SecretStorage();
	for (const [id, value] of Object.entries(secrets)) {
		store.setSecret(id, value);
	}
	return { settings: { ...DEFAULT_SETTINGS, ...fields }, store };
}

describe('migrateApiKeysToSecrets', () => {
	it('moves a plain-text key under the readable ID and links it', () => {
		const { settings, store } = createSut({ whisperApiKey: 'sk-1' });

		const migrated = migrateApiKeysToSecrets(settings, store);

		expect(migrated).toEqual([ACCOUNT_IDS.OPENAI]);
		expect(store.getSecret('openai-api-key')).toBe('sk-1');
		expect(settings.whisperApiKeySecret).toBe('openai-api-key');
	});

	it.each(
		Object.values(ACCOUNT_IDS).map((accountId) => ({
			accountId,
			id: `${accountId}-api-key`,
		})),
	)('names the $accountId secret $id', ({ accountId, id }) => {
		expect(readableSecretId(accountId)).toBe(id);
	});

	it('moves the key of every account that holds one', () => {
		const { settings, store } = createSut({
			deepgramApiKey: 'dg',
			geminiApiKey: 'gm',
			mistralApiKey: 'ms',
			anthropicApiKey: 'ak',
			deepSeekApiKey: 'ds',
		});

		migrateApiKeysToSecrets(settings, store);

		expect(store.listSecrets().sort()).toEqual([
			'anthropic-api-key',
			'deepgram-api-key',
			'deepseek-api-key',
			'gemini-api-key',
			'mistral-api-key',
		]);
	});

	it('reuses a secret that already holds the same key', () => {
		const { settings, store } = createSut(
			{ whisperApiKey: 'sk-1' },
			{ 'my-openai': 'sk-1' },
		);

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe('my-openai');
		expect(store.listSecrets()).toEqual(['my-openai']);
	});

	it('prefers the readable ID among secrets holding the same key', () => {
		const { settings, store } = createSut(
			{ whisperApiKey: 'sk-1' },
			{ 'my-openai': 'sk-1', 'openai-api-key': 'sk-1' },
		);

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe('openai-api-key');
	});

	it('falls back to an ID scoped to the plugin when the readable one holds another key', () => {
		const { settings, store } = createSut(
			{ whisperApiKey: 'sk-mine' },
			{ 'openai-api-key': 'sk-another-plugin' },
		);

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe(
			'advanced-audio-recorder-openai-api-key',
		);
		expect(store.getSecret('openai-api-key')).toBe('sk-another-plugin');
	});

	it('numbers the scoped ID when that is taken too', () => {
		const { settings, store } = createSut(
			{ whisperApiKey: 'sk-mine' },
			{
				'openai-api-key': 'a',
				'advanced-audio-recorder-openai-api-key': 'b',
				'advanced-audio-recorder-openai-api-key-2': 'c',
			},
		);

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe(
			'advanced-audio-recorder-openai-api-key-3',
		);
	});

	it('never overwrites a stored secret holding something else', () => {
		const secrets = {
			'openai-api-key': 'a',
			'advanced-audio-recorder-openai-api-key': 'b',
		};
		const { settings, store } = createSut(
			{ whisperApiKey: 'sk-mine' },
			secrets,
		);

		migrateApiKeysToSecrets(settings, store);

		for (const [id, value] of Object.entries(secrets)) {
			expect(store.getSecret(id)).toBe(value);
		}
	});

	it('creates nothing for an account with no key', () => {
		const { settings, store } = createSut();

		const migrated = migrateApiKeysToSecrets(settings, store);

		expect(migrated).toEqual([]);
		expect(store.listSecrets()).toEqual([]);
	});

	it('leaves an account alone whose linked secret exists', () => {
		const { settings, store } = createSut(
			{ whisperApiKey: 'stale', whisperApiKeySecret: 'openai-api-key' },
			{ 'openai-api-key': 'sk-1' },
		);

		const migrated = migrateApiKeysToSecrets(settings, store);

		expect(migrated).toEqual([]);
		expect(store.getSecret('openai-api-key')).toBe('sk-1');
	});

	it('stores a key data.json still carries under a linked ID nothing is stored under', () => {
		// An older version of the plugin writes the key next to the link.
		const { settings, store } = createSut({
			whisperApiKey: 'sk-1',
			whisperApiKeySecret: 'work-openai',
		});

		migrateApiKeysToSecrets(settings, store);

		expect(store.getSecret('work-openai')).toBe('sk-1');
		expect(settings.whisperApiKeySecret).toBe('work-openai');
	});

	it('keeps the plain-text key unlinked when the keychain refuses it', () => {
		const { settings, store } = createSut({ whisperApiKey: 'sk-1' });
		jest.spyOn(store, 'setSecret').mockImplementation(() => {
			throw new Error('Secure storage is not available.');
		});
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const migrated = migrateApiKeysToSecrets(settings, store);

		expect(migrated).toEqual([]);
		expect(settings.whisperApiKey).toBe('sk-1');
		expect(settings.whisperApiKeySecret).toBe('');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('OpenAI API key could not be moved'),
			expect.any(Error),
		);
	});

	it('unlinks an ID the keychain refuses, so the key it carried stays on disk', () => {
		const { settings, store } = createSut({
			whisperApiKey: 'sk-1',
			whisperApiKeySecret: 'Hand Edited',
		});
		jest.spyOn(console, 'warn').mockImplementation(() => {});

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe('');
		expect(settings.whisperApiKey).toBe('sk-1');
	});

	it('does not link a secret the keychain accepted but did not keep', () => {
		const { settings, store } = createSut({ whisperApiKey: 'sk-1' });
		jest.spyOn(store, 'setSecret').mockImplementation(() => {});
		jest.spyOn(console, 'warn').mockImplementation(() => {});

		migrateApiKeysToSecrets(settings, store);

		expect(settings.whisperApiKeySecret).toBe('');
	});

	it('links the secrets an earlier run created when it runs again', () => {
		// The save after the first run failed, so the file still holds the
		// plain-text key and no ID.
		const { store } = createSut();
		migrateApiKeysToSecrets(
			{ ...DEFAULT_SETTINGS, whisperApiKey: 'sk-1' },
			store,
		);
		const reloaded = { ...DEFAULT_SETTINGS, whisperApiKey: 'sk-1' };

		migrateApiKeysToSecrets(reloaded, store);

		expect(reloaded.whisperApiKeySecret).toBe('openai-api-key');
		expect(store.listSecrets()).toEqual(['openai-api-key']);
	});
});

describe('resolveApiKeys', () => {
	it('sets the key of a linked account to the secret it names', () => {
		const { settings, store } = createSut(
			{ deepgramApiKeySecret: 'deepgram-api-key' },
			{ 'deepgram-api-key': 'dg-1' },
		);

		resolveApiKeys(settings, store);

		expect(settings.deepgramApiKey).toBe('dg-1');
	});

	it('answers no key for a linked secret this device does not hold', () => {
		const { settings, store } = createSut({
			deepgramApiKey: 'stale',
			deepgramApiKeySecret: 'deepgram-api-key',
		});

		resolveApiKeys(settings, store);

		expect(settings.deepgramApiKey).toBe('');
	});

	it('keeps the plain-text key of an account that links nothing', () => {
		const { settings, store } = createSut({ deepgramApiKey: 'dg-local' });

		resolveApiKeys(settings, store);

		expect(settings.deepgramApiKey).toBe('dg-local');
	});
});

describe('normalizeApiKeySecretIds', () => {
	it.each([
		{ name: 'null', value: null },
		{ name: 'a number', value: 7 },
		{ name: 'an object', value: { id: 'x' } },
	])('reads an ID stored as $name as no ID', ({ value }) => {
		const { settings } = createSut();
		internalsOf<Record<string, unknown>>(settings)[
			ACCOUNTS[ACCOUNT_IDS.GEMINI].apiKeySecretKey
		] = value;

		normalizeApiKeySecretIds(settings);

		expect(settings.geminiApiKeySecret).toBe('');
	});

	it('keeps an ID stored as text', () => {
		const { settings } = createSut({
			geminiApiKeySecret: 'gemini-api-key',
		});

		normalizeApiKeySecretIds(settings);

		expect(settings.geminiApiKeySecret).toBe('gemini-api-key');
	});

	it('reads a key stored as anything but text as no key', () => {
		const { settings } = createSut();
		internalsOf<Record<string, unknown>>(settings)['geminiApiKey'] = 42;

		normalizeApiKeySecretIds(settings);

		expect(settings.geminiApiKey).toBe('');
	});
});
