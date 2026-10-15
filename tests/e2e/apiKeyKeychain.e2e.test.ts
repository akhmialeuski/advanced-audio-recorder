/**
 * The provider keys from load to run, driven the way Obsidian drives the
 * plugin: a data.json written by an earlier version holds them in plain text,
 * the plugin moves them into Obsidian\'s keychain, and from then on data.json
 * and the backup beside it hold only the IDs of the secrets.
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

/** What a data.json written before the keychain move held. */
const PLAIN_TEXT_KEYS = {
	whisperApiKey: 'sk-plain',
	deepgramApiKey: 'dg-plain',
};

/** The keychain double the app carries, with its internal API typed. */
function keychainOf(app: App): SecretStorage {
	return asMockApp(app).secretStorage;
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

	it('writes data.json at once, holding the IDs and none of the keys', async () => {
		const { saveData } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const written = lastWrite(saveData);
		expect(written).toMatchObject({
			whisperApiKey: '',
			whisperApiKeySecret: 'openai-api-key',
			deepgramApiKey: '',
			deepgramApiKeySecret: 'deepgram-api-key',
		});
	});

	it('keeps the keys out of the settings backup too', async () => {
		const { app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		const backup = await app.vault.adapter.read(BACKUP_PATH);

		expect(backup).toContain('openai-api-key');
		expect(backup).not.toContain('sk-plain');
		expect(backup).not.toContain('dg-plain');
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

	it('announces nothing and retries on the next load when data.json cannot be written', async () => {
		const app = new App();
		const plugin = new AudioRecorderPlugin(app, MANIFEST);
		const persistence = internalsOf<Record<string, unknown>>(plugin);
		persistence.loadData = jest.fn().mockResolvedValue({
			...PLAIN_TEXT_KEYS,
		});
		persistence.saveData = jest.fn().mockRejectedValue(new Error('EACCES'));
		jest.spyOn(console, 'warn').mockImplementation(() => {});

		await plugin.onload();

		expect(keychainNotices()).toEqual([]);
		// The secrets exist, so the next load links them instead of creating
		// copies.
		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
	});

	it('moves the keys on a phone as well', async () => {
		useMobilePlatform();

		const { app } = await loadPlugin({ ...PLAIN_TEXT_KEYS });

		expect(keychainOf(app).getSecret('openai-api-key')).toBe('sk-plain');
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
