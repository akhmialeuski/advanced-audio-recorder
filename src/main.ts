/**
 * Advanced Audio Recorder plugin for Obsidian.
 * @module main
 */

import { Notice, Plugin } from 'obsidian';
import { RecordingStatus } from './types';
import type { SaveProgress, RecordingControls } from './types';
import { PLUGIN_LOG_PREFIX } from './constants';
import {
	AudioRecorderSettings,
	mergeSettingsAsync,
	serializeSettings,
} from './settings/Settings';
import { AudioRecorderSettingTab } from './settings/SettingsTab';
import { RecordingManager } from './recording/RecordingManager';
import { updateStatusBar, initializeStatusBar } from './ui/StatusBar';
import { updateRibbonIcon, initializeRibbonIcon } from './ui/RibbonIcon';
import { showDeviceSelectionModal } from './ui/DeviceSelectionModal';
import { ContextMenu } from './ui/ContextMenu';

/** Delay before retrying a failed settings read, in milliseconds. */
const SETTINGS_READ_RETRY_DELAY_MS = 250;

/** Settings file name used by Obsidian's loadData/saveData. */
const SETTINGS_DATA_FILE = 'data.json';

/** Backup file name for settings, stored next to data.json. */
const SETTINGS_BACKUP_FILE = 'data.json.bak';

/**
 * Advanced Audio Recorder plugin for Obsidian.
 */
export default class AudioRecorderPlugin extends Plugin {
	settings!: AudioRecorderSettings;
	private recordingManager!: RecordingManager;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private contextMenu!: ContextMenu;
	/**
	 * True when data.json exists on disk but could not be read at load
	 * time. While set, saveSettings refuses to write so the possibly
	 * intact file is never overwritten with defaults.
	 */
	private settingsLoadFailed = false;

	/**
	 * Called when the plugin is loaded.
	 */
	async onload(): Promise<void> {
		await this.loadSettings();

		this.recordingManager = new RecordingManager(
			this.app,
			this.settings,
			(status: RecordingStatus, saveProgress?: SaveProgress) => {
				const controls = this.buildRecordingControls(status);
				updateStatusBar(
					this.statusBarItem,
					status,
					saveProgress,
					controls,
				);
				updateRibbonIcon(this.ribbonIconEl, status);
			},
		);

		this.addSettingTab(new AudioRecorderSettingTab(this.app, this));
		this.registerCommands();
		this.ribbonIconEl = this.addRibbonIcon(
			'microphone',
			'Start/stop recording',
			() => {
				void this.recordingManager.toggleRecording();
			},
		);
		this.setupStatusBar();

		this.contextMenu = new ContextMenu(this.app, this, () => this.settings);
		this.contextMenu.register();
	}

	/**
	 * Called when the plugin is unloaded.
	 */
	onunload(): void {
		this.recordingManager.cleanup();
		initializeStatusBar(this.statusBarItem);
		initializeRibbonIcon(this.ribbonIconEl);
	}

	/**
	 * Loads plugin settings from storage.
	 * Distinguishes "data.json is missing" (first install, defaults are
	 * correct) from "data.json exists but could not be read" (transient
	 * file lock during a plugin update, truncated file): the latter
	 * falls back to defaults only in memory and blocks saving, so the
	 * stored settings are never overwritten by the fallback. The two
	 * cases are told apart by an explicit adapter.exists() check, not
	 * by the loadData() return value: loadData() maps a missing file
	 * to null only when the failed read carries an ENOENT error code,
	 * and on some filesystems the read fails with a different code.
	 */
	async loadSettings(): Promise<void> {
		const data = await this.readStoredSettings();

		if (data === undefined) {
			this.settingsLoadFailed = true;
			new Notice(
				'Advanced Audio Recorder: the settings file could not be read. ' +
					'Using defaults for this session; settings stored on disk are untouched. ' +
					'Restart Obsidian to recover them.',
			);
			this.settings = await mergeSettingsAsync({});
			return;
		}

		this.settingsLoadFailed = false;
		this.settings = await mergeSettingsAsync(data ?? {});
		await this.backupSettings();
	}

	/**
	 * Saves plugin settings to storage.
	 */
	async saveSettings(): Promise<void> {
		if (this.settingsLoadFailed) {
			// Never overwrite a possibly intact data.json with the
			// in-memory defaults that replaced the unreadable settings
			new Notice(
				'Settings were not loaded correctly; changes are not saved ' +
					'to protect your stored settings. Restart Obsidian.',
			);
			return;
		}
		await this.saveData(serializeSettings(this.settings));
		await this.backupSettings();
		this.recordingManager.updateSettings(this.settings);
	}

	/**
	 * Called by Obsidian when data.json changes externally (sync,
	 * manual edit) while the plugin is loaded. Reloads settings so the
	 * stale in-memory copy does not overwrite the external change on
	 * the next save.
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.recordingManager.updateSettings(this.settings);
	}

	/**
	 * Reads settings from disk. loadData() reports a missing data.json
	 * as null only when the underlying read fails with an ENOENT error
	 * code; other filesystems surface a different code for the same
	 * condition and loadData() then returns undefined, exactly like a
	 * corrupt or locked file. The adapter's exists() check is therefore
	 * the only reliable discriminator between "file missing" and "file
	 * exists but could not be read". A failed read of an existing file
	 * is retried once, then the backup file is tried.
	 * @returns Stored settings, null when data.json is missing (saving
	 * stays enabled), or undefined when data.json exists but neither it
	 * nor the backup could be read
	 */
	private async readStoredSettings(): Promise<
		Partial<AudioRecorderSettings> | null | undefined
	> {
		let data = (await this.loadData()) as
			| Partial<AudioRecorderSettings>
			| null
			| undefined;
		if (data !== undefined && data !== null) {
			return data;
		}

		if (!(await this.settingsFileExists())) {
			// Missing data.json: restore a lost file from the backup,
			// or apply defaults on a first install. Saving stays
			// enabled so the file gets created on the next change.
			return (await this.readSettingsBackup()) ?? null;
		}

		await new Promise<void>((resolve) =>
			activeWindow.setTimeout(resolve, SETTINGS_READ_RETRY_DELAY_MS),
		);
		data = (await this.loadData()) as
			| Partial<AudioRecorderSettings>
			| null
			| undefined;
		if (data !== undefined && data !== null) {
			return data;
		}

		return this.readSettingsBackup();
	}

	/**
	 * Checks whether data.json is present on disk.
	 * @returns True when data.json exists, or when its existence cannot
	 * be determined: the protective assumption keeps saveSettings from
	 * overwriting a file that may still be intact
	 */
	private async settingsFileExists(): Promise<boolean> {
		const dataPath = this.getPluginFilePath(SETTINGS_DATA_FILE);
		if (!dataPath) {
			return false;
		}
		try {
			return await this.app.vault.adapter.exists(dataPath);
		} catch {
			return true;
		}
	}

	/**
	 * Restores settings from the backup file written on every
	 * successful load and save.
	 * @returns Parsed backup settings, or undefined when the backup is
	 * missing or unreadable
	 */
	private async readSettingsBackup(): Promise<
		Partial<AudioRecorderSettings> | undefined
	> {
		const backupPath = this.getSettingsBackupPath();
		if (!backupPath) {
			return undefined;
		}
		try {
			const raw = await this.app.vault.adapter.read(backupPath);
			const parsed = JSON.parse(raw) as Partial<AudioRecorderSettings>;
			new Notice(
				'Advanced Audio Recorder: settings were restored from the backup file.',
			);
			return parsed;
		} catch {
			return undefined;
		}
	}

	/**
	 * Writes the current settings to the backup file next to data.json.
	 * Failures only log a warning: the backup is a best-effort recovery
	 * source and must not break loading or saving.
	 */
	private async backupSettings(): Promise<void> {
		const backupPath = this.getSettingsBackupPath();
		if (!backupPath) {
			return;
		}
		try {
			await this.app.vault.adapter.write(
				backupPath,
				JSON.stringify(serializeSettings(this.settings)),
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to write settings backup:`,
				error,
			);
		}
	}

	/**
	 * Resolves the vault-relative path of the settings backup file.
	 * @returns Backup path, or null when the plugin directory is unknown
	 */
	private getSettingsBackupPath(): string | null {
		return this.getPluginFilePath(SETTINGS_BACKUP_FILE);
	}

	/**
	 * Resolves the vault-relative path of a file in the plugin folder.
	 * @param fileName - File name inside the plugin folder
	 * @returns File path, or null when the plugin directory is unknown
	 */
	private getPluginFilePath(fileName: string): string | null {
		const pluginDir = this.manifest.dir;
		if (!pluginDir) {
			return null;
		}
		return `${pluginDir}/${fileName}`;
	}

	/**
	 * Registers plugin commands.
	 */
	private registerCommands(): void {
		this.addCommand({
			id: 'start-stop-recording',
			name: 'Start/stop recording',
			callback: () => {
				void this.recordingManager.toggleRecording();
			},
		});

		this.addCommand({
			id: 'pause-resume-recording',
			name: 'Pause/resume recording',
			callback: () => {
				this.recordingManager.togglePauseResume();
			},
		});

		this.addCommand({
			id: 'select-audio-input-device',
			name: 'Select audio input device',
			callback: () => {
				void showDeviceSelectionModal(
					this.app,
					async (deviceId: string) => {
						this.settings.audioDeviceId = deviceId;
						await this.saveSettings();
					},
				);
			},
		});
	}

	/**
	 * Builds recording control callbacks for the status bar buttons.
	 * Returns controls only when recording is active or paused.
	 * @param status - Current recording status
	 * @returns RecordingControls or undefined if not in a recording state
	 */
	private buildRecordingControls(
		status: RecordingStatus,
	): RecordingControls | undefined {
		if (
			status !== RecordingStatus.Recording &&
			status !== RecordingStatus.Paused
		) {
			return undefined;
		}

		return {
			onPauseResume: () => {
				this.recordingManager.togglePauseResume();
			},
			onStop: () => {
				void this.recordingManager.stopRecording();
			},
			isPaused: status === RecordingStatus.Paused,
		};
	}

	/**
	 * Sets up the status bar item.
	 */
	private setupStatusBar(): void {
		this.statusBarItem = this.addStatusBarItem();
		initializeStatusBar(this.statusBarItem);
	}
}
