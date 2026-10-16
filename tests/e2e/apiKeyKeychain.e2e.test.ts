/**
 * The provider keys from load to run, driven the way Obsidian drives the
 * plugin: a data.json written by an earlier version holds them in plain text,
 * the plugin moves them into Obsidian\'s keychain, and once a restart finds
 * them there data.json and the backup beside it hold only the IDs of the
 * secrets.
 * @module tests/e2e/apiKeyKeychain.e2e.test
 */

import { App } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { loadPlugin, MANIFEST } from '../helpers/pluginHarness';
import { asMockApp, asMockPlugin } from '../helpers/obsidianMock';
import { pageOf } from '../helpers/declarativeSettings';
import { useMobilePlatform } from '../helpers/platform';
import { at } from '../helpers/assertions';
import { internalsOf } from '../helpers/doubles';
import { noticeMessages, type SecretStorage } from '../mocks/obsidian';
import { EngineLabel } from 'src/providers/providers';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import AudioRecorderPlugin from 'src/main';

const BACKUP_PATH = `${MANIFEST.dir ?? ''}/data.json.bak`;
const DATA_PATH = `${MANIFEST.dir ?? ''}/data.json`;

/** What a data.json written before the keychain move held. */
const PLAIN_TEXT_KEYS = {
	whisperApiKey: 'sk-plain',
	deepgramApiKey: 'dg-plain',
};

/** The keychain double the app carries, with its internal API typed. */
function keychainOf(app: App): SecretStorage {
	return asMockApp(app).secretStorage;
}

/** Every secret an app's keychain holds, by ID. */
function secretsOf(app: App): Record<string, string> {
	const keychain = keychainOf(app);
	return Object.fromEntries(
		keychain.listSecrets().map((id) => [id, keychain.getSecret(id) ?? '']),
	);
}

/**
 * Obsidian started again: a new app, whose keychain holds what the old one
 * kept on disk, loads the data.json the old session wrote last.
 * @param stored - The data.json the old session wrote last
 * @param kept - The secrets the keychain kept on disk, by ID
 */
async function restart(
	stored: Record<string, unknown>,
	kept: Record<string, string>,
): ReturnType<typeof loadPlugin> {
	const app = new App();
	for (const [id, value] of Object.entries(kept)) {
		keychainOf(app).setSecret(id, value);
	}
	return loadPlugin(stored, app);
}

/** The notices that spoke about the keychain, in order. */
function keychainNotices(): string[] {
	return noticeMessages().filter((message) => message.includes('keychain'));
}

/** The data.json the plugin last wrote. */
function lastWrite(saveData: jest.Mock): Record<string, unknown> {
	return at(saveData.mock.calls, saveData.mock.calls.length - 1)[0] as Record<
		string,
		unknown
	>;
}

/**
 * What the entry of an engine's page reports, read the way the settings
 * window shows it.
 * @param plugin - The loaded plugin
 * @param label - The engine's name on its entry
 */
function engineEntry(plugin: AudioRecorderPlugin, label: string): string {
	const tab = at(asMockPlugin(plugin).settingTabs, 0);
	const page = pageOf(
		tab.getSettingDefinitions() as SettingDefinitionItem[],
		label,
	);
	return typeof page.displayValue === 'function'
		? page.displayValue()
		: (page.displayValue ?? '');
}

describe('loading a data.json that holds API keys in plain text', () => {
	it('moves each key into the keychain under a readable ID', async () => {
		const { app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
		expect(keychainOf(app).getSecret('deepgram-api-key')).toBe('dg-plain');
	});

	it('writes the IDs at once and keeps each key beside its link until a restart confirms the move', async () => {
		const { saveData } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		expect(lastWrite(saveData)).toMatchObject({
			whisperApiKey: 'sk-plain',
			whisperApiKeySecret: 'openai-api-key',
			deepgramApiKey: 'dg-plain',
			deepgramApiKeySecret: 'deepgram-api-key',
			unconfirmedApiKeySecrets: {
				openai: 'openai-api-key',
				deepgram: 'deepgram-api-key',
			},
		});
	});

	it('drops the keys from data.json and its backup once a restart finds the secrets', async () => {
		const first = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const { app, saveData } = await restart(
			lastWrite(first.saveData),
			secretsOf(first.app),
		);

		expect(lastWrite(saveData)).toMatchObject({
			whisperApiKey: '',
			whisperApiKeySecret: 'openai-api-key',
			deepgramApiKey: '',
			unconfirmedApiKeySecrets: {},
		});
		const backup = await app.vault.adapter.read(BACKUP_PATH);
		expect(backup).toContain('openai-api-key');
		expect(backup).not.toContain('sk-plain');
		expect(backup).not.toContain('dg-plain');
	});

	it('keeps every key when the keychain loses its writes before the restart', async () => {
		// Obsidian's keychain answers from memory and does not report a
		// write to disk that failed, so a restart is what finds it missing.
		const first = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const { plugin, app, saveData } = await restart(
			lastWrite(first.saveData),
			{},
		);

		expect(plugin.settings.whisperApiKey).toBe('sk-plain');
		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
		// data.json keeps what it held, and the backup still carries the keys.
		expect(saveData).not.toHaveBeenCalledWith(
			expect.objectContaining({ whisperApiKey: '' }),
		);
		const backup = await app.vault.adapter.read(BACKUP_PATH);
		expect(backup).toContain('sk-plain');
		expect(backup).toContain('dg-plain');
	});

	it('keeps the keys on disk through a reload by the same plugin instance', async () => {
		// A synced data.json reloads the settings mid-session, when the
		// keychain still answers from memory and proves nothing.
		const { plugin, loadData, saveData } = await loadPlugin({
			...PLAIN_TEXT_KEYS,
		});
		loadData.mockResolvedValue(lastWrite(saveData));

		await plugin.onExternalSettingsChange();
		await plugin.saveSettings();

		expect(lastWrite(saveData)).toMatchObject({
			whisperApiKey: 'sk-plain',
			deepgramApiKey: 'dg-plain',
		});
	});

	it('keeps running on the keys it moved', async () => {
		const { plugin } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		expect(plugin.settings.whisperApiKey).toBe('sk-plain');
		expect(plugin.settings.deepgramApiKey).toBe('dg-plain');
	});

	it('says once where the keys went and that other devices need them entered', async () => {
		await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const told = keychainNotices();
		expect(told).toHaveLength(1);
		expect(at(told, 0)).toContain('OpenAI API key, Deepgram API key');
		expect(at(told, 0)).toContain('Settings > Keychain');
		expect(at(told, 0)).toContain('not synced');
	});

	it('does nothing more on the next load', async () => {
		const first = await loadPlugin({ ...PLAIN_TEXT_KEYS });
		const stored = lastWrite(first.saveData);
		const before = keychainOf(first.app).listSecrets();

		const second = await loadPlugin(stored, first.app);

		expect(keychainOf(second.app).listSecrets()).toEqual(before);
		// The one notice is the first load's.
		expect(keychainNotices()).toHaveLength(1);
		expect(second.plugin.settings.whisperApiKey).toBe('sk-plain');
	});

	it('leaves data.json alone when the keychain refuses every key', async () => {
		const app = new App();
		jest.spyOn(keychainOf(app), 'setSecret').mockImplementation(() => {
			throw new Error('Secure storage is not available.');
		});
		jest.spyOn(console, 'warn').mockImplementation(() => {});

		const { plugin, saveData } = await loadPlugin(
			{ ...PLAIN_TEXT_KEYS },
			app,
		);

		expect(plugin.settings.whisperApiKey).toBe('sk-plain');
		expect(saveData).not.toHaveBeenCalledWith(
			expect.objectContaining({ whisperApiKey: '' }),
		);
	});

	it('announces nothing while data.json cannot be written, and links the same secrets on the next load', async () => {
		const app = new App();
		const plugin = new AudioRecorderPlugin(app, MANIFEST);
		const persistence = internalsOf<Record<string, unknown>>(plugin);
		persistence.loadData = jest.fn().mockResolvedValue({
			...PLAIN_TEXT_KEYS,
		});
		const saveData = jest.fn().mockRejectedValue(new Error('EACCES'));
		persistence.saveData = saveData;
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		await plugin.onload();
		expect(keychainNotices()).toEqual([]);

		saveData.mockResolvedValue(undefined);
		await plugin.loadSettings();

		// The secrets the failed load created are linked, not copied.
		expect(keychainOf(app).listSecrets().sort()).toEqual([
			'deepgram-api-key',
			'openai-api-key',
		]);
		expect(lastWrite(saveData)).toMatchObject({
			whisperApiKeySecret: 'openai-api-key',
			deepgramApiKeySecret: 'deepgram-api-key',
		});
		expect(keychainNotices()).toHaveLength(1);
	});

	it('moves the keys on a phone as well', async () => {
		useMobilePlatform();

		const { app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
	});
});

describe('loading while data.json cannot be used', () => {
	it('moves nothing while data.json is unreadable and the backup holds the keys', async () => {
		// Saving is blocked, so a key moved now could never leave data.json,
		// and the session runs on the plain-text keys instead.
		const app = new App();
		await app.vault.adapter.write(DATA_PATH, '{"truncated');
		await app.vault.adapter.write(
			BACKUP_PATH,
			JSON.stringify(PLAIN_TEXT_KEYS),
		);

		const plugin = new AudioRecorderPlugin(app, MANIFEST);
		const persistence = internalsOf<Record<string, unknown>>(plugin);
		// A read that fails twice, as a truncated file does.
		persistence.loadData = jest.fn().mockResolvedValue(undefined);
		const saveData = jest.fn().mockResolvedValue(undefined);
		persistence.saveData = saveData;

		await plugin.onload();

		expect(keychainOf(app).listSecrets()).toEqual([]);
		expect(saveData).not.toHaveBeenCalled();
		expect(plugin.settings.whisperApiKey).toBe('sk-plain');
	});

	it('moves the keys of a backup an earlier version wrote when data.json is missing', async () => {
		const app = new App();
		await app.vault.adapter.write(
			BACKUP_PATH,
			JSON.stringify(PLAIN_TEXT_KEYS),
		);

		const { saveData } = await loadPlugin(null, app);

		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
		expect(lastWrite(saveData)).toMatchObject({
			whisperApiKey: 'sk-plain',
			whisperApiKeySecret: 'openai-api-key',
			unconfirmedApiKeySecrets: {
				openai: 'openai-api-key',
				deepgram: 'deepgram-api-key',
			},
		});
		expect(keychainNotices()).toHaveLength(1);
	});
});

describe('a data.json synced from another device', () => {
	it('reports no key for a secret this device does not hold', async () => {
		const { plugin } = await loadPlugin({
			transcriptionEnabled: true,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramApiKeySecret: 'deepgram-api-key',
		});

		expect(plugin.settings.deepgramApiKey).toBe('');
		expect(engineEntry(plugin, EngineLabel.Deepgram)).toBe('No key');
	});

	it('picks the key up once it is entered in the keychain', async () => {
		const { plugin, app } = await loadPlugin({
			deepgramApiKeySecret: 'deepgram-api-key',
		});

		keychainOf(app).setSecret('deepgram-api-key', 'dg-here');

		expect(plugin.settings.deepgramApiKey).toBe('dg-here');
		expect(engineEntry(plugin, EngineLabel.Deepgram)).not.toBe('No key');
	});
});

describe('a secret changed in the keychain page of Obsidian', () => {
	it('resolves the key again when the secret is edited', async () => {
		const { plugin, app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		keychainOf(app).setSecret('openai-api-key', 'sk-rotated');

		expect(plugin.settings.whisperApiKey).toBe('sk-rotated');
	});

	it('reports no key once the secret is deleted, without writing anything', async () => {
		const { plugin, app, saveData } = await loadPlugin({
			...PLAIN_TEXT_KEYS,
		});
		saveData.mockClear();

		keychainOf(app).deleteSecret('deepgram-api-key');

		expect(plugin.settings.deepgramApiKey).toBe('');
		expect(saveData).not.toHaveBeenCalled();
	});

	it('listens through a registration Obsidian releases on unload', async () => {
		const { plugin, app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const refs = asMockPlugin(plugin).registeredEvents.filter(
			(ref) => ref.name === 'changed',
		);

		expect(refs).toHaveLength(1);
		expect(keychainOf(app).countHandlers('changed')).toBe(1);
	});
});
