/**
 * Where the provider API keys are kept: in Obsidian's keychain, with only the
 * ID of each secret in the plugin's settings.
 *
 * The keys used to be plain fields of data.json, which is the one file of the
 * plugin a sync service copies everywhere and a backup tool archives, and the
 * settings backup beside it held a second copy. Obsidian's keychain keeps a
 * secret on the device it was entered on, encrypted with the operating
 * system's own store where one is available, and lets the settings name it by
 * an ID. That ID is what data.json stores now; the key itself never reaches
 * the disk the plugin writes.
 *
 * Every reader of a key still reads the account's key field, because that
 * field is resolved from the keychain rather than removed: a run, a cost
 * estimate and a page status all ask the same question they always did. What
 * changed is who writes it - this module, not the user.
 *
 * Written against the three methods it calls rather than against Obsidian's
 * class, so the rules can be tested without the app.
 * @module settings/apiKeySecrets
 */

import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	ACCOUNTS,
	type AccountId,
	type ProviderConnection,
} from '../providers/providers';
import type { AudioRecorderSettings } from './settingsSchema';

/** What this module needs of Obsidian's `SecretStorage`. */
export interface ApiKeySecretStore {
	/** The secret stored under an ID, or null when there is none. */
	getSecret(id: string): string | null;
	/** Stores a secret; throws for an invalid ID or an unavailable store. */
	setSecret(id: string, value: string): void;
	/** The ID of every stored secret. */
	listSecrets(): string[];
}

/**
 * Prefix of the IDs a migration falls back to when the readable one is taken
 * by a secret holding something else. Named after the plugin, so whoever reads
 * the keychain can tell where the secret came from.
 */
const PLUGIN_SECRET_PREFIX = 'advanced-audio-recorder';

/**
 * Every account, with its ID. Read from the registry so an account added there
 * arrives with its key kept in the keychain like the rest.
 */
function accounts(): [AccountId, ProviderConnection][] {
	return Object.entries(ACCOUNTS) as [AccountId, ProviderConnection][];
}

/**
 * Sets every account's key to what the keychain holds under its linked ID.
 *
 * An account with an ID is answered by the keychain alone, and an ID with no
 * secret behind it answers ''. That is the case of a data.json synced from
 * another device: the ID arrived, the secret did not, and the account reads as
 * having no key - which is what the engine page and a run then say - rather
 * than as having one it cannot produce.
 *
 * An account with no ID keeps whatever its key field already holds. That is
 * either nothing, or a key a migration could not move because the keychain
 * refused it, and dropping that one would lose the only copy.
 * @param settings - The settings to resolve in place
 * @param store - The keychain
 */
export function resolveApiKeys(
	settings: AudioRecorderSettings,
	store: ApiKeySecretStore,
): void {
	for (const [, account] of accounts()) {
		const id = account.apiKeySecret(settings);
		if (id !== '') {
			account.setApiKey(settings, store.getSecret(id) ?? '');
		}
	}
}

/**
 * The readable ID a migrated key is created under, such as `openai-api-key`.
 * Unprefixed on purpose: the keychain is shared by every plugin, and a key for
 * the same service is the one another plugin would look for under that name.
 * @param accountId - The account the key belongs to
 */
export function readableSecretId(accountId: AccountId): string {
	return `${accountId}-api-key`;
}

/**
 * The ID a key is moved under: the first of this plugin's own candidates - the
 * readable ID, then one scoped to the plugin, then that one with a number
 * appended - that either holds this key already or holds nothing.
 *
 * Reusing a candidate that holds the key is what makes a migration safe to
 * repeat: a load whose save failed finds the secrets the previous one created
 * and links them again instead of creating a second copy of each. Only the
 * candidates are read. A secret under any other ID belongs to the user or to
 * another plugin, and reading it would mark it as just used on the Keychain
 * page, while linking it would tie the key to a secret this plugin does not
 * own and that another device would not have under the same ID.
 * @param accountId - The account the key belongs to
 * @param key - The key being moved
 * @param store - The keychain
 */
function secretIdFor(
	accountId: AccountId,
	key: string,
	store: ApiKeySecretStore,
): string {
	const taken = new Set(store.listSecrets());
	const readable = readableSecretId(accountId);
	const scoped = `${PLUGIN_SECRET_PREFIX}-${readable}`;
	let candidate = readable;
	for (
		let suffix = 1;
		taken.has(candidate) && store.getSecret(candidate) !== key;
		suffix++
	) {
		candidate = suffix === 1 ? scoped : `${scoped}-${String(suffix)}`;
	}
	return candidate;
}

/**
 * Moves every key data.json still holds in plain text into the keychain and
 * links the account to it.
 *
 * Only an account holding a key is moved, and one whose linked secret exists
 * on this device is not: the keychain answers for it. A secret this plugin
 * created that already holds the same key is reused; otherwise a new one is
 * created under an ID no stored secret uses, so a secret that holds something
 * else is never overwritten.
 *
 * An account that links an ID nothing is stored under while data.json still
 * holds a key - a file written by an older version of the plugin after the
 * link was made - has that key stored under the linked ID. The ID is free on
 * this device, so nothing is overwritten, and the key the file carried is not
 * dropped by the next save.
 *
 * A key the keychain refuses stays where it is. The account then keeps no ID,
 * which is what tells the serializer to keep writing the key, so the only copy
 * is not lost; the next load tries again.
 * @param settings - The settings to migrate in place, as just loaded
 * @param store - The keychain
 * @returns The accounts whose key was moved
 */
export function migrateApiKeysToSecrets(
	settings: AudioRecorderSettings,
	store: ApiKeySecretStore,
): AccountId[] {
	const migrated: AccountId[] = [];
	for (const [accountId, account] of accounts()) {
		const key = account.apiKey(settings);
		const linked = account.apiKeySecret(settings);
		if (key === '' || (linked !== '' && store.getSecret(linked) !== null)) {
			continue;
		}
		const id = linked !== '' ? linked : secretIdFor(accountId, key, store);
		try {
			if (store.getSecret(id) !== key) {
				store.setSecret(id, key);
			}
			// Read back before the account is linked: a store that accepted
			// the write and kept nothing would otherwise leave the account
			// pointing at an empty secret, and the serializer would then drop
			// the only copy of the key.
			if (store.getSecret(id) !== key) {
				throw new Error(`the keychain did not keep "${id}"`);
			}
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The ${account.keyFieldName} could not be moved to Obsidian's keychain and stays in data.json:`,
				error,
			);
			// A link nothing can be stored under resolves to no key, and with
			// a link the serializer stops writing the key: unlinked, the key
			// stays the account's and stays on disk.
			account.setApiKeySecret(settings, '');
			continue;
		}
		account.setApiKeySecret(settings, id);
		migrated.push(accountId);
	}
	return migrated;
}

/**
 * Reads the stored secret IDs back into strings. data.json is not
 * type-checked, and an ID that is not a string would otherwise reach the
 * keychain as one; anything else reads as no ID at all.
 * @param settings - The merged settings to normalize in place
 */
export function normalizeApiKeySecretIds(
	settings: AudioRecorderSettings,
): void {
	const raw = settings as unknown as Record<string, unknown>;
	for (const [, account] of accounts()) {
		const id = raw[account.apiKeySecretKey];
		account.setApiKeySecret(settings, typeof id === 'string' ? id : '');
		const key = raw[account.apiKeyKey];
		account.setApiKey(settings, typeof key === 'string' ? key : '');
	}
}
