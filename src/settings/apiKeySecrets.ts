/**
 * Where the provider API keys are kept: in Obsidian's keychain, with only the
 * ID of each secret in the plugin's settings.
 *
 * The keys used to be plain fields of data.json, which is the one file of the
 * plugin a sync service copies everywhere and a backup tool archives, and the
 * settings backup beside it held a second copy. Obsidian's keychain keeps a
 * secret on the device it was entered on, encrypted with the operating
 * system's own store where one is available, and lets the settings name it by
 * an ID. That ID is what data.json stores now; the key itself reaches the
 * disk the plugin writes only until a moved key is known to be kept.
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
import { isRecord } from '../utils/objects';
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

/** What one migration did, for the load that ran it. */
export interface ApiKeyMigrationResult {
	/**
	 * The accounts this load linked to a secret, announced once data.json
	 * holds the link.
	 */
	readonly linked: AccountId[];
	/**
	 * Whether data.json has to be written: an account was linked, or a
	 * plain-text copy kept for a secret is no longer needed.
	 */
	readonly changed: boolean;
}

/**
 * Moves every key data.json still holds in plain text into the keychain and
 * links the account to it, and drops the plain-text copy only once a later
 * start of Obsidian has found the secret in the keychain.
 *
 * The keychain does not report a lost write. Obsidian's setSecret() keeps the
 * value in memory and starts the write to disk without waiting for it: the
 * desktop store swallows a localStorage error, and a failed encryption only
 * rejects a promise nobody awaits. A read right after the write answers from
 * memory and cannot tell a kept secret from a lost one. A start of Obsidian
 * can, because it loads the keychain from disk before any plugin. So every
 * secret this instance writes is listed in `unconfirmedApiKeySecrets`, the
 * serializer keeps writing the key next to the link of a listed account, and
 * a later load by an instance that did not write the secret, finding it there,
 * removes the entry.
 *
 * Which secrets were written is held by the instance, not on disk: a load
 * repeated in the same session, after a synced data.json arrives, still sees
 * the keychain in memory and proves nothing. Disabling and enabling the plugin
 * without restarting Obsidian makes a new instance, which takes the secret as
 * kept; a key is lost that way only when the keychain's own write failed as
 * well. A secret deleted on the Keychain page before its move is confirmed
 * looks like a lost write to the next load, which stores it again, so the
 * doubt always resolves to keeping the key.
 */
export class ApiKeyMigration {
	private readonly store: ApiKeySecretStore;
	/** IDs of the secrets this instance stored. */
	private readonly written = new Set<string>();

	/**
	 * @param store - The keychain
	 */
	constructor(store: ApiKeySecretStore) {
		this.store = store;
	}

	/**
	 * Moves and confirms the keys of every account.
	 *
	 * Only an account holding a key is moved, and one whose linked secret
	 * exists on this device is not: the keychain answers for it. A secret this
	 * plugin created that already holds the same key is reused; otherwise a new
	 * one is created under an ID no stored secret uses, so a secret that holds
	 * something else is never overwritten.
	 *
	 * An account that links an ID nothing is stored under while data.json still
	 * holds a key has that key stored under the linked ID. That is a move whose
	 * write to the keychain a restart found missing, or a file an older version
	 * of the plugin wrote after the link was made; the ID is free on this
	 * device either way, so nothing is overwritten.
	 *
	 * A key the keychain refuses stays where it is. The account then keeps no
	 * ID, which is what tells the serializer to keep writing the key, so the
	 * only copy is not lost; the next load tries again.
	 * @param settings - The settings to migrate in place, as just loaded
	 */
	migrate(settings: AudioRecorderSettings): ApiKeyMigrationResult {
		const unconfirmed: Record<string, string> = {
			...settings.unconfirmedApiKeySecrets,
		};
		const linked: AccountId[] = [];
		let changed = false;
		for (const [accountId, account] of accounts()) {
			const key = account.apiKey(settings);
			const link = account.apiKeySecret(settings);
			// A copy kept for a link the user has since changed, or for an
			// account that no longer holds a key, protects nothing.
			const pending = unconfirmed[accountId];
			if (pending !== undefined && (pending !== link || key === '')) {
				delete unconfirmed[accountId];
				changed = true;
			}
			if (key === '') {
				continue;
			}
			if (link !== '' && this.store.getSecret(link) !== null) {
				if (accountId in unconfirmed && !this.written.has(link)) {
					delete unconfirmed[accountId];
					changed = true;
				}
				continue;
			}
			const id =
				link !== '' ? link : secretIdFor(accountId, key, this.store);
			if (!this.storeKey(account, id, key)) {
				account.setApiKeySecret(settings, '');
				delete unconfirmed[accountId];
				continue;
			}
			if (link !== id) {
				account.setApiKeySecret(settings, id);
				linked.push(accountId);
				changed = true;
			}
			if (this.written.has(id) && unconfirmed[accountId] !== id) {
				unconfirmed[accountId] = id;
				changed = true;
			}
		}
		settings.unconfirmedApiKeySecrets = unconfirmed;
		return { linked, changed };
	}

	/**
	 * Makes the keychain hold a key under an ID, writing it only when it does
	 * not already.
	 *
	 * The read after the write answers from memory, so it catches a store that
	 * drops the value at once, not one whose write to disk fails later; that is
	 * what the confirmation on a later start is for. A refusal is logged and
	 * answered false: the caller then leaves the account unlinked, because a
	 * link nothing is stored under resolves to no key and the serializer stops
	 * writing the key of a linked account.
	 * @param account - The account the key belongs to
	 * @param id - The secret's ID
	 * @param key - The key
	 * @returns Whether the keychain holds the key under the ID
	 */
	private storeKey(
		account: ProviderConnection,
		id: string,
		key: string,
	): boolean {
		try {
			if (this.store.getSecret(id) !== key) {
				this.store.setSecret(id, key);
				this.written.add(id);
			}
			if (this.store.getSecret(id) !== key) {
				throw new Error(`the keychain did not keep "${id}"`);
			}
			return true;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} The ${account.keyFieldName} could not be moved to Obsidian's keychain and stays in data.json:`,
				error,
			);
			return false;
		}
	}
}

/**
 * Whether data.json carries an account's key: when the account links no
 * secret, the field is the key itself, and while a move into the keychain is
 * unconfirmed it is the only copy a lost keychain write would leave. Otherwise
 * the field is a runtime copy of the secret and stays out of data.json and its
 * backup, which is what keeping it in the keychain is for.
 * @param settings - Live settings
 * @param accountId - The account asked about
 */
export function writesApiKey(
	settings: AudioRecorderSettings,
	accountId: AccountId,
): boolean {
	const link = ACCOUNTS[accountId].apiKeySecret(settings);
	return link === '' || settings.unconfirmedApiKeySecrets[accountId] === link;
}

/**
 * Reads the stored secret IDs back into strings. data.json is not
 * type-checked, and an ID that is not a string would otherwise reach the
 * keychain as one; anything else reads as no ID at all. The unconfirmed moves
 * are rebuilt the same way, keeping only an account's ID stored as text.
 * @param settings - The merged settings to normalize in place
 */
export function normalizeApiKeySecretIds(
	settings: AudioRecorderSettings,
): void {
	const raw = settings as unknown as Record<string, unknown>;
	const storedUnconfirmed = raw.unconfirmedApiKeySecrets;
	const pending = isRecord(storedUnconfirmed) ? storedUnconfirmed : {};
	const unconfirmed: Record<string, string> = {};
	for (const [accountId, account] of accounts()) {
		const id = raw[account.apiKeySecretKey];
		account.setApiKeySecret(settings, typeof id === 'string' ? id : '');
		const key = raw[account.apiKeyKey];
		account.setApiKey(settings, typeof key === 'string' ? key : '');
		const unconfirmedId = pending[accountId];
		if (typeof unconfirmedId === 'string') {
			unconfirmed[accountId] = unconfirmedId;
		}
	}
	settings.unconfirmedApiKeySecrets = unconfirmed;
}
