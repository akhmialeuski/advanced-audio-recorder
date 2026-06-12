/**
 * Tests for the plugin entry point: settings load/save resilience.
 * @module tests/unit/main
 */

import { App } from 'obsidian';
import AudioRecorderPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings/Settings';

jest.mock('../../src/recording/RecordingManager', () => ({
	RecordingManager: jest.fn().mockImplementation(() => ({
		toggleRecording: jest.fn(),
		togglePauseResume: jest.fn(),
		stopRecording: jest.fn(),
		cleanup: jest.fn(),
		updateSettings: jest.fn(),
		getStatus: jest.fn(),
	})),
}));

jest.mock('../../src/ui/ContextMenu', () => ({
	ContextMenu: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
	})),
}));

jest.mock('../../src/ui/StatusBar', () => ({
	updateStatusBar: jest.fn(),
	initializeStatusBar: jest.fn(),
}));

jest.mock('../../src/ui/RibbonIcon', () => ({
	updateRibbonIcon: jest.fn(),
	initializeRibbonIcon: jest.fn(),
}));

jest.mock('../../src/ui/DeviceSelectionModal', () => ({
	showDeviceSelectionModal: jest.fn(),
}));

// Fixture path: in production the directory comes from manifest.dir
const PLUGIN_DIR = 'config-dir/plugins/advanced-audio-recorder';
const DATA_PATH = `${PLUGIN_DIR}/data.json`;
const BACKUP_PATH = `${PLUGIN_DIR}/data.json.bak`;
const RETRY_DELAY_MS = 250;

const MANIFEST = {
	id: 'advanced-audio-recorder',
	name: 'Advanced Audio Recorder',
	version: '1.3.3',
	dir: PLUGIN_DIR,
};

type LoadDataResult = Record<string, unknown> | null | undefined;

interface PluginHarness {
	plugin: AudioRecorderPlugin;
	loadData: jest.Mock;
	saveData: jest.Mock;
	adapterRead: jest.Mock;
	adapterWrite: jest.Mock;
	adapterExists: jest.Mock;
}

/**
 * Creates a plugin instance with mocked persistence functions.
 * data.json does not exist by default; tests that model an existing
 * but unreadable file flip adapterExists to true.
 * @param loadDataResults - Sequence of loadData results per call
 */
function createPlugin(loadDataResults: LoadDataResult[]): PluginHarness {
	const app = new App();
	const plugin = new AudioRecorderPlugin(app as never, MANIFEST as never);

	const loadData = jest.fn();
	for (const result of loadDataResults) {
		loadData.mockResolvedValueOnce(result);
	}
	const saveData = jest.fn().mockResolvedValue(undefined);
	(plugin as unknown as Record<string, unknown>).loadData = loadData;
	(plugin as unknown as Record<string, unknown>).saveData = saveData;

	const adapterRead = jest.fn().mockResolvedValue('');
	const adapterWrite = jest.fn().mockResolvedValue(undefined);
	const adapterExists = jest.fn().mockResolvedValue(false);
	plugin.app.vault.adapter.read = adapterRead;
	plugin.app.vault.adapter.write = adapterWrite;
	plugin.app.vault.adapter.exists = adapterExists;

	return {
		plugin,
		loadData,
		saveData,
		adapterRead,
		adapterWrite,
		adapterExists,
	};
}

/**
 * Runs plugin.onload while advancing the retry timer, so loads that
 * hit the retry path resolve under fake timers.
 */
async function onloadWithTimers(plugin: AudioRecorderPlugin): Promise<void> {
	const promise = plugin.onload();
	await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
	await promise;
}

describe('AudioRecorderPlugin settings persistence', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	it('merges stored settings with defaults and writes a backup', async () => {
		const { plugin, adapterWrite, loadData } = createPlugin([
			{ filePrefix: 'meeting', sampleRate: 22050 },
		]);

		await onloadWithTimers(plugin);

		expect(loadData).toHaveBeenCalledTimes(1);
		expect(plugin.settings.filePrefix).toBe('meeting');
		expect(plugin.settings.sampleRate).toBe(22050);
		expect(plugin.settings.recordingFormat).toBe(
			DEFAULT_SETTINGS.recordingFormat,
		);
		expect(adapterWrite).toHaveBeenCalledWith(
			BACKUP_PATH,
			expect.stringContaining('"filePrefix":"meeting"'),
		);
	});

	it('uses defaults when data.json is missing and allows saving', async () => {
		const { plugin, saveData } = createPlugin([null]);

		await onloadWithTimers(plugin);

		expect(plugin.settings.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('allows saving when a missing data.json is reported as a failed read', async () => {
		// On some filesystems reading a missing file fails with a
		// non-ENOENT code, so loadData() returns undefined instead of
		// null. The file's absence must still enable saving, otherwise
		// data.json can never be created.
		const { plugin, loadData, saveData, adapterExists } = createPlugin([
			undefined,
		]);

		await onloadWithTimers(plugin);

		expect(adapterExists).toHaveBeenCalledWith(DATA_PATH);
		// No retry for a file that does not exist
		expect(loadData).toHaveBeenCalledTimes(1);
		expect(plugin.settings.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('restores settings from the backup when data.json is missing', async () => {
		const { plugin, adapterRead, saveData } = createPlugin([null]);
		adapterRead.mockResolvedValue(
			JSON.stringify({ filePrefix: 'from-backup' }),
		);

		await onloadWithTimers(plugin);

		expect(adapterRead).toHaveBeenCalledWith(BACKUP_PATH);
		expect(plugin.settings.filePrefix).toBe('from-backup');

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('retries a failed read once and uses the second result', async () => {
		const { plugin, loadData, saveData, adapterExists } = createPlugin([
			undefined,
			{ filePrefix: 'recovered' },
		]);
		adapterExists.mockResolvedValue(true);

		await onloadWithTimers(plugin);

		expect(loadData).toHaveBeenCalledTimes(2);
		expect(plugin.settings.filePrefix).toBe('recovered');

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('restores settings from the backup when both reads fail', async () => {
		const { plugin, adapterRead, saveData, adapterExists } = createPlugin([
			undefined,
			undefined,
		]);
		adapterExists.mockResolvedValue(true);
		adapterRead.mockResolvedValue(
			JSON.stringify({ filePrefix: 'from-backup' }),
		);

		await onloadWithTimers(plugin);

		expect(adapterRead).toHaveBeenCalledWith(BACKUP_PATH);
		expect(plugin.settings.filePrefix).toBe('from-backup');

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('blocks saving when neither data.json nor the backup is readable', async () => {
		const { plugin, adapterRead, saveData, adapterWrite, adapterExists } =
			createPlugin([undefined, undefined]);
		adapterExists.mockResolvedValue(true);
		adapterRead.mockRejectedValue(new Error('EBUSY'));

		await onloadWithTimers(plugin);

		// Defaults are active in memory only
		expect(plugin.settings.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);

		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		// No backup written either: it would capture the defaults
		expect(adapterWrite).not.toHaveBeenCalled();
	});

	it('blocks saving when the backup contains invalid JSON', async () => {
		const { plugin, adapterRead, saveData, adapterExists } = createPlugin([
			undefined,
			undefined,
		]);
		adapterExists.mockResolvedValue(true);
		adapterRead.mockResolvedValue('{ truncated');

		await onloadWithTimers(plugin);

		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
	});

	it('reloads settings on external settings change', async () => {
		const { plugin, loadData } = createPlugin([
			{ filePrefix: 'before' },
			{ filePrefix: 'after-sync' },
		]);

		await onloadWithTimers(plugin);
		expect(plugin.settings.filePrefix).toBe('before');

		await plugin.onExternalSettingsChange();

		expect(loadData).toHaveBeenCalledTimes(2);
		expect(plugin.settings.filePrefix).toBe('after-sync');
	});

	it('recovers saving after a successful reload', async () => {
		const { plugin, adapterRead, saveData, loadData, adapterExists } =
			createPlugin([undefined, undefined]);
		adapterExists.mockResolvedValue(true);
		adapterRead.mockRejectedValue(new Error('EBUSY'));

		await onloadWithTimers(plugin);
		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();

		// The file becomes readable again (lock released)
		loadData.mockResolvedValue({ filePrefix: 'recovered' });
		await plugin.onExternalSettingsChange();

		expect(plugin.settings.filePrefix).toBe('recovered');
		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});
});
