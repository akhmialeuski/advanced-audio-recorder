/**
 * Tests for the plugin entry point: settings load/save resilience.
 * @module tests/unit/main
 */

import { App } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { SaveProgress } from 'src/types';
import type { TranscriptionModalOptions } from 'src/ui/TranscriptionModal';

jest.mock('src/recording/RecordingManager', () => ({
	RecordingManager: jest.fn().mockImplementation(() => ({
		toggleRecording: jest.fn(),
		togglePauseResume: jest.fn(),
		stopRecording: jest.fn(),
		cleanup: jest.fn(),
		updateSettings: jest.fn(),
		getStatus: jest.fn(),
	})),
}));

jest.mock('src/ui/ContextMenu', () => ({
	ContextMenu: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
	})),
}));

jest.mock('src/player/EnhancedPlayerRegistrar', () => ({
	EnhancedPlayerRegistrar: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
		dispose: jest.fn(),
		refresh: jest.fn(),
		primeSavedRecordingsForEnhancement: jest.fn(),
	})),
}));

jest.mock('src/ui/StatusBar', () => ({
	updateStatusBar: jest.fn(),
	initializeStatusBar: jest.fn(),
	renderTranscriptionStatusBar: jest.fn(),
}));

jest.mock('src/ui/RibbonIcon', () => ({
	updateRibbonIcon: jest.fn(),
	initializeRibbonIcon: jest.fn(),
}));

jest.mock('src/ui/DeviceSelectionModal', () => ({
	showDeviceSelectionModal: jest.fn(),
}));

jest.mock('src/recording/RecoveryService', () => ({
	collectRecoverableSessions: jest.fn().mockResolvedValue([]),
	recoverSession: jest
		.fn()
		.mockResolvedValue({ recoveredPaths: [], failedTracks: [] }),
	discardSession: jest.fn().mockResolvedValue([]),
}));

jest.mock('src/ui/RecoveryModal', () => ({
	RecoveryModal: jest.fn().mockImplementation(() => ({
		open: jest.fn(),
	})),
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
	const plugin = new AudioRecorderPlugin(app, MANIFEST);

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
		const { plugin, adapterRead, adapterExists, saveData } = createPlugin([
			null,
		]);
		adapterExists.mockImplementation((path: string) =>
			Promise.resolve(path === BACKUP_PATH),
		);
		adapterRead.mockResolvedValue(
			JSON.stringify({ filePrefix: 'from-backup' }),
		);

		await onloadWithTimers(plugin);

		expect(adapterRead).toHaveBeenCalledWith(BACKUP_PATH);
		expect(plugin.settings.filePrefix).toBe('from-backup');
		// The restore is persisted right away: data.json is recreated
		// so the backup stops being the only copy on disk
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData).toHaveBeenCalledWith(
			expect.objectContaining({ filePrefix: 'from-backup' }),
		);

		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(2);
	});

	it('blocks saving when data.json is missing and the backup cannot be read', async () => {
		// With data.json missing, the backup is the only remaining
		// copy of the settings: a transient read failure must block
		// saving instead of letting the defaults overwrite it
		const { plugin, adapterRead, adapterWrite, adapterExists, saveData } =
			createPlugin([null]);
		adapterExists.mockImplementation((path: string) =>
			Promise.resolve(path === BACKUP_PATH),
		);
		adapterRead.mockRejectedValue(new Error('EBUSY'));

		await onloadWithTimers(plugin);

		// Defaults are active in memory only
		expect(plugin.settings.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);

		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		// The possibly intact backup is never overwritten with defaults
		expect(adapterWrite).not.toHaveBeenCalled();
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

	it('uses the backup for the session and blocks saving when data.json is unreadable', async () => {
		const { plugin, adapterRead, adapterWrite, saveData, adapterExists } =
			createPlugin([undefined, undefined]);
		adapterExists.mockResolvedValue(true);
		adapterRead.mockResolvedValue(
			JSON.stringify({ filePrefix: 'from-backup' }),
		);

		await onloadWithTimers(plugin);

		// The readable backup keeps the session usable in memory
		expect(adapterRead).toHaveBeenCalledWith(BACKUP_PATH);
		expect(plugin.settings.filePrefix).toBe('from-backup');

		// The unreadable data.json may be intact and newer than the
		// backup (settings synced while the plugin was unloaded), so
		// saving stays blocked instead of overwriting it with
		// backup-derived values
		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		expect(adapterWrite).not.toHaveBeenCalled();
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

	it('propagates in-memory settings to the recording manager while saving is blocked', async () => {
		const { plugin, saveData, adapterExists } = createPlugin([
			undefined,
			undefined,
		]);
		adapterExists.mockResolvedValue(true);

		await onloadWithTimers(plugin);

		const { RecordingManager } = jest.requireMock(
			'src/recording/RecordingManager',
		);
		const manager = (RecordingManager as jest.Mock).mock.results[0]
			.value as { updateSettings: jest.Mock };

		// The settings tab mutates the in-memory settings before
		// calling saveSettings; with persistence blocked, the change
		// must still reach the recording manager so the whole session
		// sees one consistent state
		plugin.settings.filePrefix = 'changed-in-session';
		await plugin.saveSettings();

		expect(saveData).not.toHaveBeenCalled();
		expect(manager.updateSettings).toHaveBeenCalledWith(plugin.settings);
	});

	it('primes saved recordings for enhanced player rendering', async () => {
		const { plugin } = createPlugin([null]);

		await onloadWithTimers(plugin);

		const { RecordingManager } = jest.requireMock(
			'src/recording/RecordingManager',
		);
		const onRecordingSaved = (RecordingManager as jest.Mock).mock
			.calls[0][4] as (result: {
			audioPaths: string[];
			notePath: string | null;
		}) => void;
		const { EnhancedPlayerRegistrar } = jest.requireMock(
			'src/player/EnhancedPlayerRegistrar',
		);
		const registrar = (EnhancedPlayerRegistrar as jest.Mock).mock.results[0]
			.value as {
			primeSavedRecordingsForEnhancement: jest.Mock;
		};

		onRecordingSaved({
			audioPaths: ['recordings/fresh.webm'],
			notePath: 'notes/daily.md',
		});

		expect(
			registrar.primeSavedRecordingsForEnhancement,
		).toHaveBeenCalledWith(['recordings/fresh.webm']);
	});

	it('treats a rejected settings read as a failed read', async () => {
		// The current Obsidian loadData() never rejects, but that is
		// undocumented internal behavior; a rejection must degrade to
		// the failed-read path instead of breaking onload
		const { plugin, loadData, saveData } = createPlugin([]);
		loadData.mockRejectedValue(new Error('read failure'));

		await onloadWithTimers(plugin);

		// data.json does not exist: defaults apply and saving stays
		// enabled so the file gets created on the next change
		expect(plugin.settings.filePrefix).toBe(DEFAULT_SETTINGS.filePrefix);
		await plugin.saveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it('blocks saving when a rejected read hits an existing data.json', async () => {
		const { plugin, loadData, saveData, adapterExists } = createPlugin([]);
		adapterExists.mockResolvedValue(true);
		loadData.mockRejectedValue(new Error('read failure'));

		await onloadWithTimers(plugin);

		await plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
	});

	it('keeps the in-memory settings when a reload read fails', async () => {
		const { plugin, loadData, saveData, adapterExists } = createPlugin([
			{ filePrefix: 'loaded' },
		]);

		await onloadWithTimers(plugin);
		expect(plugin.settings.filePrefix).toBe('loaded');

		// External change arrives while the file is locked: every
		// subsequent read fails
		adapterExists.mockResolvedValue(true);
		loadData.mockResolvedValue(undefined);
		const changePromise = plugin.onExternalSettingsChange();
		await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
		await changePromise;

		// The previously loaded settings stay active instead of being
		// replaced with defaults
		expect(plugin.settings.filePrefix).toBe('loaded');

		// Saving stays blocked until a successful reload
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

describe('AudioRecorderPlugin crash recovery wiring', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	const createTestSession = (): Record<string, unknown> => ({
		sessionId: 'session-1',
		startedAt: 1765533600000,
		outputFormat: 'webm',
		recorderFormat: 'webm',
		bitrate: 128000,
		tracks: [],
	});

	it('passes the journal to the RecordingManager', async () => {
		const { plugin } = createPlugin([null]);

		await onloadWithTimers(plugin);

		const { RecordingManager } = jest.requireMock(
			'src/recording/RecordingManager',
		);
		const journalArg = (RecordingManager as jest.Mock).mock.calls[0][3] as {
			readJournal?: unknown;
		};
		expect(typeof journalArg.readJournal).toBe('function');
	});

	it('does not open the recovery modal when nothing is recoverable', async () => {
		const { plugin } = createPlugin([null]);

		await onloadWithTimers(plugin);
		await jest.advanceTimersByTimeAsync(0);

		const { RecoveryModal } = jest.requireMock('src/ui/RecoveryModal');
		expect(RecoveryModal).not.toHaveBeenCalled();
	});

	it('opens the recovery modal for recoverable sessions', async () => {
		const { collectRecoverableSessions } = jest.requireMock(
			'src/recording/RecoveryService',
		);
		const session = createTestSession();
		collectRecoverableSessions.mockResolvedValueOnce([session]);
		const { plugin } = createPlugin([null]);

		await onloadWithTimers(plugin);
		await jest.advanceTimersByTimeAsync(0);

		const { RecoveryModal } = jest.requireMock('src/ui/RecoveryModal');
		expect(RecoveryModal).toHaveBeenCalledWith(
			plugin.app,
			[session],
			expect.objectContaining({
				onRecover: expect.any(Function),
				onDiscard: expect.any(Function),
			}),
		);
		const modalInstance = (RecoveryModal as jest.Mock).mock.results[0]
			.value as { open: jest.Mock };
		expect(modalInstance.open).toHaveBeenCalled();
	});

	it('recovers every offered session through the callback', async () => {
		const { collectRecoverableSessions, recoverSession } = jest.requireMock(
			'src/recording/RecoveryService',
		);
		const sessions = [createTestSession(), createTestSession()];
		collectRecoverableSessions.mockResolvedValueOnce(sessions);
		const { plugin } = createPlugin([null]);

		await onloadWithTimers(plugin);
		await jest.advanceTimersByTimeAsync(0);

		const { RecoveryModal } = jest.requireMock('src/ui/RecoveryModal');
		const callbacks = (RecoveryModal as jest.Mock).mock.calls[0][2] as {
			onRecover: () => Promise<void>;
		};
		await callbacks.onRecover();

		expect(recoverSession).toHaveBeenCalledTimes(2);
	});

	it('does not break onload when the recovery check fails', async () => {
		const consoleErrorSpy = jest
			.spyOn(console, 'error')
			.mockImplementation();
		const { collectRecoverableSessions } = jest.requireMock(
			'src/recording/RecoveryService',
		);
		collectRecoverableSessions.mockRejectedValueOnce(
			new Error('journal exploded'),
		);
		const { plugin } = createPlugin([null]);

		await expect(onloadWithTimers(plugin)).resolves.toBeUndefined();
		await jest.advanceTimersByTimeAsync(0);

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Recovery check failed'),
			expect.any(Error),
		);
		consoleErrorSpy.mockRestore();
	});
});

describe('AudioRecorderPlugin background transcription status bar', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	/** Builds per-modal background-progress callbacks via the private factory. */
	const buildBackgroundProgress = (
		plugin: AudioRecorderPlugin,
	): NonNullable<TranscriptionModalOptions['backgroundProgress']> => {
		const factory = plugin as unknown as {
			createTranscriptionModalOptions: () => TranscriptionModalOptions;
		};
		const options = factory.createTranscriptionModalOptions();
		if (!options.backgroundProgress) {
			throw new Error('Expected background progress callbacks');
		}
		return options.backgroundProgress;
	};

	const progress = (percent: number, description: string): SaveProgress => ({
		percent,
		description,
	});

	it('renders the most recent minimized transcription and falls back when it clears', async () => {
		const { plugin } = createPlugin([null]);
		await onloadWithTimers(plugin);

		const { renderTranscriptionStatusBar, updateStatusBar } =
			jest.requireMock('src/ui/StatusBar');
		(renderTranscriptionStatusBar as jest.Mock).mockClear();

		const first = buildBackgroundProgress(plugin);
		const second = buildBackgroundProgress(plugin);
		const restoreFirst = jest.fn();
		const restoreSecond = jest.fn();

		first.show(progress(10, 'First job'), restoreFirst);
		second.show(progress(60, 'Second job'), restoreSecond);

		// The most recently updated job occupies the single status-bar slot.
		expect(renderTranscriptionStatusBar).toHaveBeenLastCalledWith(
			expect.anything(),
			progress(60, 'Second job'),
			expect.objectContaining({ onActivate: restoreSecond }),
		);

		// Clearing the active job falls back to the other still-minimized job
		// instead of blanking the bar.
		second.clear();
		expect(renderTranscriptionStatusBar).toHaveBeenLastCalledWith(
			expect.anything(),
			progress(10, 'First job'),
			expect.objectContaining({ onActivate: restoreFirst }),
		);

		// Clearing the last job releases the slot to the idle renderer.
		(updateStatusBar as jest.Mock).mockClear();
		first.clear();
		expect(updateStatusBar).toHaveBeenCalled();
	});

	it('keeps the active job displayed when a superseded job clears', async () => {
		const { plugin } = createPlugin([null]);
		await onloadWithTimers(plugin);

		const { renderTranscriptionStatusBar } =
			jest.requireMock('src/ui/StatusBar');

		const first = buildBackgroundProgress(plugin);
		const second = buildBackgroundProgress(plugin);
		const restoreSecond = jest.fn();

		first.show(progress(10, 'First job'), jest.fn());
		second.show(progress(60, 'Second job'), restoreSecond);

		(renderTranscriptionStatusBar as jest.Mock).mockClear();
		// The earlier job finishes while the later one still owns the slot.
		first.clear();
		expect(renderTranscriptionStatusBar).toHaveBeenLastCalledWith(
			expect.anything(),
			progress(60, 'Second job'),
			expect.objectContaining({ onActivate: restoreSecond }),
		);
	});
});
