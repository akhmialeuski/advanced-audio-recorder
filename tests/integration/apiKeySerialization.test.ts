/**
 * Unit tests for what reaches data.json of a provider key: nothing for an
 * account that links a keychain secret, the key itself for one that does not
 * or whose move into the keychain is unconfirmed, and a key carried over from
 * the pre-vendor schema landing on the right account before it is moved into
 * the keychain.
 * @module tests/integration/apiKeySerialization.test
 */

import { SecretStorage } from '../mocks/obsidian';
import {
	mergeSettings,
	serializeSettings,
} from 'src/settings/settingsSerialization';
import { ApiKeyMigration } from 'src/settings/apiKeySecrets';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { LLM_PROVIDER_IDS } from 'src/constants';
import { PlatformKind } from 'src/platform/platformKind';

/**
 * Moves the keys into the keychain and confirms the move the way a later start
 * of Obsidian does: a second migration, by an instance that did not write the
 * secrets, finds them in the keychain.
 * @param settings - Settings holding plain-text keys, migrated in place
 * @param store - The keychain
 */
function moveAndConfirm(
	settings: AudioRecorderSettings,
	store: SecretStorage,
): void {
	new ApiKeyMigration(store).migrate(settings);
	new ApiKeyMigration(store).migrate(settings);
}

describe('serializing a provider key', () => {
	it('writes no key for an account that links a secret', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			whisperApiKey: 'sk-resolved',
			whisperApiKeySecret: 'openai-api-key',
		};

		const serialized = serializeSettings(settings, PlatformKind.Desktop);

		expect(serialized.whisperApiKey).toBe('');
		expect(serialized.whisperApiKeySecret).toBe('openai-api-key');
	});

	it('writes the key of an account that links nothing, so it is not lost', () => {
		const settings = { ...DEFAULT_SETTINGS, deepgramApiKey: 'dg-local' };

		const serialized = serializeSettings(settings, PlatformKind.Desktop);

		expect(serialized.deepgramApiKey).toBe('dg-local');
	});

	it('keeps writing the key next to a link whose move is unconfirmed', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			whisperApiKey: 'sk-1',
			whisperApiKeySecret: 'openai-api-key',
			unconfirmedApiKeySecrets: { openai: 'openai-api-key' },
		};

		const serialized = serializeSettings(settings, PlatformKind.Desktop);

		expect(serialized.whisperApiKey).toBe('sk-1');
		expect(serialized.unconfirmedApiKeySecrets).toEqual({
			openai: 'openai-api-key',
		});
	});

	it('writes no key once the account links a secret other than the unconfirmed one', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			whisperApiKey: 'sk-chosen',
			whisperApiKeySecret: 'work-openai',
			unconfirmedApiKeySecrets: { openai: 'openai-api-key' },
		};

		const serialized = serializeSettings(settings, PlatformKind.Desktop);

		expect(serialized.whisperApiKey).toBe('');
	});

	it('leaves the live key in place for the runs that read it', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			whisperApiKey: 'sk-resolved',
			whisperApiKeySecret: 'openai-api-key',
		};

		serializeSettings(settings, PlatformKind.Desktop);

		expect(settings.whisperApiKey).toBe('sk-resolved');
	});

	it('puts no key of any kind into the serialized text once every move is confirmed', () => {
		const settings = {
			...DEFAULT_SETTINGS,
			whisperApiKey: 'sk-1',
			deepgramApiKey: 'dg-1',
			geminiApiKey: 'gm-1',
			mistralApiKey: 'ms-1',
			anthropicApiKey: 'ak-1',
			deepSeekApiKey: 'ds-1',
		};
		moveAndConfirm(settings, new SecretStorage());

		const text = JSON.stringify(
			serializeSettings(settings, PlatformKind.Desktop),
		);

		for (const key of ['sk-1', 'dg-1', 'gm-1', 'ms-1', 'ak-1', 'ds-1']) {
			expect(text).not.toContain(key);
		}
	});
});

describe('a legacy single LLM key', () => {
	it('lands on the account of the selected vendor and moves into the keychain from there', () => {
		const store = new SecretStorage();
		const merged = mergeSettings(
			{
				llmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
				llmApiKey: 'ak-legacy',
			},
			PlatformKind.Desktop,
		);

		moveAndConfirm(merged, store);

		expect(merged.anthropicApiKeySecret).toBe('anthropic-api-key');
		expect(store.getSecret('anthropic-api-key')).toBe('ak-legacy');
		expect(
			serializeSettings(merged, PlatformKind.Desktop).anthropicApiKey,
		).toBe('');
	});

	it('is not written onto an account that already links a secret', () => {
		const merged = mergeSettings(
			{
				llmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
				anthropicApiKeySecret: 'anthropic-api-key',
				llmApiKey: 'ak-legacy',
			},
			PlatformKind.Desktop,
		);

		expect(merged.anthropicApiKey).toBe('');
	});
});
