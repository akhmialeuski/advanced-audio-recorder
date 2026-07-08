/**
 * Advanced Audio Recorder plugin for Obsidian.
 * @module main
 */

import { Notice, Platform, Plugin } from 'obsidian';
import { RecordingStatus } from './types';
import type {
	SaveProgress,
	RecordingControls,
	RecordingSaveResult,
} from './types';
import { PLUGIN_LOG_PREFIX } from './constants';
import { AudioRecorderSettings } from './settings/settingsSchema';
import {
	mergeSettingsAsync,
	serializeSettings,
} from './settings/settingsSerialization';
import { AudioRecorderSettingTab } from './settings/SettingsTab';
import { RecordingManager } from './recording/RecordingManager';
import { SessionJournal, JOURNAL_FILE_NAME } from './recording/SessionJournal';
import {
	collectRecoverableSessions,
	recoverSession,
	discardSession,
} from './recording/RecoveryService';
import { RecoveryModal } from './ui/RecoveryModal';
import { EncodingWorkerClient } from './audio/EncodingWorkerClient';
import {
	updateStatusBar,
	updateRecordingLiveStats,
	initializeStatusBar,
	renderTranscriptionStatusBar,
} from './ui/StatusBar';
import { RecordingBanner } from './ui/RecordingBanner';
import { updateRibbonIcon, initializeRibbonIcon } from './ui/RibbonIcon';
import { showDeviceSelectionModal } from './ui/DeviceSelectionModal';
import { ContextMenu } from './ui/ContextMenu';
import type { ActionServices } from './actions/PluginAction';
import { FILE_ACTIONS } from './actions/fileActions';
import { createRecordingMarkerActions } from './actions/recordingMarkerActions';
import {
	registerFileActionCommands,
	registerRecordingActionCommands,
} from './actions/registerActionCommands';
import { EnhancedPlayerRegistrar } from './player/EnhancedPlayerRegistrar';
import { MediaKindStore, MEDIA_KIND_STORE_FILE } from './player/MediaKindStore';
import { MarkerStore } from './markers/MarkerStore';
import { RecordingMarkerModal } from './ui/MarkerModal';
import { TranscriptionModal } from './ui/TranscriptionModal';
import type { TranscriptionModalOptions } from './ui/TranscriptionModal';
import { COMMAND_IDS } from './constants';
import type { MarkerKind } from './markers/markerModel';
import { delay } from './utils/TimeUtils';

/** Delay before retrying a failed settings read, in milliseconds. */
const SETTINGS_READ_RETRY_DELAY_MS = 250;

/** Settings file name used by Obsidian's loadData/saveData. */
const SETTINGS_DATA_FILE = 'data.json';

/** Backup file name for settings, stored next to data.json. */
const SETTINGS_BACKUP_FILE = 'data.json.bak';

/** Accessible label for the status-bar action that reopens a minimized transcription. */
const RESTORE_TRANSCRIPTION_LABEL = 'Restore transcription window';

/** Refresh interval, in ms, for the live recording stats and meter. */
const LIVE_STATS_INTERVAL_MS = 200;

/**
 * Result of reading the stored settings from disk.
 */
interface StoredSettingsReadResult {
	/**
	 * Stored settings, null when no settings exist on disk, or
	 * undefined when no readable settings source is available.
	 */
	data: Partial<AudioRecorderSettings> | null | undefined;
	/**
	 * True when data.json is missing and the settings were recovered
	 * from the backup file: the caller persists them so data.json is
	 * recreated and the backup stops being the only copy on disk.
	 */
	restoredFromBackup: boolean;
	/**
	 * True when a settings file exists on disk but could not be
	 * read: saving stays blocked so the possibly intact (and
	 * possibly newer) stored settings are never overwritten by
	 * values derived from this session's fallback.
	 */
	blockSaving: boolean;
}

/**
 * Status-bar state owned by a minimized transcription modal. The owning
 * modal id is the map key, so it is not repeated here.
 */
interface BackgroundTranscriptionProgress {
	progress: SaveProgress;
	restore: () => void;
}

/**
 * Advanced Audio Recorder plugin for Obsidian.
 */
export default class AudioRecorderPlugin extends Plugin {
	settings!: AudioRecorderSettings;
	private recordingManager!: RecordingManager;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private contextMenu!: ContextMenu;
	private recordingBanner!: RecordingBanner;
	private playerRegistrar!: EnhancedPlayerRegistrar;
	private journal!: SessionJournal;
	private encodingWorker: EncodingWorkerClient | null = null;
	private recordingStatus: RecordingStatus = RecordingStatus.Idle;
	private recordingSaveProgress: SaveProgress | undefined;
	/**
	 * Minimized transcriptions reporting progress in the status bar, keyed by
	 * a per-modal id. Insertion order is preserved, so the most recently
	 * updated job is the one rendered; clearing it falls back to the previous
	 * still-minimized job instead of blanking the bar.
	 */
	private backgroundTranscriptions = new Map<
		number,
		BackgroundTranscriptionProgress
	>();
	private nextBackgroundTranscriptionId = 0;
	/**
	 * True when data.json exists on disk but could not be read at load
	 * time. While set, saveSettings refuses to write so the possibly
	 * intact file is never overwritten with defaults.
	 */
	private settingsLoadFailed = false;
	/**
	 * True once settings have been assigned at least once. Lets a
	 * failed reload keep the current in-memory settings instead of
	 * replacing them with defaults.
	 */
	private settingsInitialized = false;

	/**
	 * Called when the plugin is loaded.
	 */
	override async onload(): Promise<void> {
		await this.loadSettings();

		// Offload streaming conversions to a Web Worker when the build
		// injected its source; everything falls back to the main thread
		this.encodingWorker = new EncodingWorkerClient(
			typeof __ENCODING_WORKER_SOURCE__ === 'string'
				? __ENCODING_WORKER_SOURCE__
				: null,
		);
		this.journal = new SessionJournal(
			this.getPluginFilePath(JOURNAL_FILE_NAME),
			this.app,
		);
		// One MarkerStore is shared by recording (which writes live markers
		// at stop) and the player registrar (which reads/edits them), so
		// their cache and serialized write chain stay unified.
		const markerStore = new MarkerStore(this.app);
		this.recordingBanner = new RecordingBanner(() => {
			void this.recordingManager.stopRecording();
		});
		this.recordingManager = new RecordingManager(
			this.app,
			this.settings,
			(status: RecordingStatus, saveProgress?: SaveProgress) => {
				this.handleStatusChange(status, saveProgress);
			},
			this.journal,
			(result: RecordingSaveResult) => {
				this.handleRecordingSaved(result);
			},
			markerStore,
			() => this.encodingWorker,
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

		this.contextMenu = new ContextMenu(
			this,
			this.createActionServices(),
			FILE_ACTIONS,
		);
		this.contextMenu.register();

		// Media kinds persist across sessions so the first open of a note
		// never repeats a file's probe (and the embed upgrade behind it)
		const mediaKindStore = new MediaKindStore(
			this.app,
			this.getPluginFilePath(MEDIA_KIND_STORE_FILE),
		);
		this.playerRegistrar = new EnhancedPlayerRegistrar(
			this,
			this.app,
			() => this.settings,
			markerStore,
			mediaKindStore,
		);
		this.playerRegistrar.register();

		// Recovery runs after the workspace is ready so plugin load is
		// never delayed; a failure here must not break the plugin
		this.app.workspace.onLayoutReady(() => {
			void this.checkForInterruptedSessions();
		});
	}

	/**
	 * Offers recovery for recording sessions that died mid-recording
	 * (crash, power loss, plugin unload). Sessions whose temporary
	 * files vanished self-clear silently; everything else opens the
	 * recovery modal.
	 */
	private async checkForInterruptedSessions(): Promise<void> {
		try {
			const sessions = await collectRecoverableSessions(
				this.journal,
				this.app,
			);
			if (sessions.length === 0) {
				return;
			}
			new RecoveryModal(this.app, sessions, {
				onRecover: async () => {
					const recovered: string[] = [];
					const failed: string[] = [];
					for (const session of sessions) {
						const result = await recoverSession(
							session,
							this.journal,
							this.app,
						);
						recovered.push(...result.recoveredPaths);
						failed.push(...result.failedTracks);
					}
					if (recovered.length > 0) {
						new Notice(
							`Recovered ${String(recovered.length)} audio file(s): ${recovered.join(', ')}`,
						);
					}
					if (failed.length > 0) {
						new Notice(
							`Could not recover ${String(failed.length)} track(s); their temporary files were kept for the next attempt.`,
						);
					}
				},
				onDiscard: async () => {
					const failedPaths: string[] = [];
					for (const session of sessions) {
						failedPaths.push(
							...(await discardSession(
								session,
								this.journal,
								this.app,
							)),
						);
					}
					new Notice(
						failedPaths.length > 0
							? `Some temporary recording files could not be removed: ${failedPaths.join(', ')}`
							: 'Temporary recording files were discarded.',
					);
				},
			}).open();
		} catch (error) {
			console.error(`${PLUGIN_LOG_PREFIX} Recovery check failed:`, error);
		}
	}

	/**
	 * Called when the plugin is unloaded.
	 */
	override onunload(): void {
		this.recordingManager.cleanup();
		this.recordingBanner.hide();
		this.playerRegistrar.dispose();
		this.encodingWorker?.terminate();
		this.encodingWorker = null;
		initializeStatusBar(this.statusBarItem);
		initializeRibbonIcon(this.ribbonIconEl);
	}

	/**
	 * Loads plugin settings from storage.
	 * Distinguishes "data.json is missing" (first install, defaults are
	 * correct) from "data.json exists but could not be read" (transient
	 * file lock during a plugin update, truncated file): the latter
	 * keeps the session on the backup copy or defaults in memory and
	 * blocks saving, so the stored settings are never overwritten by
	 * the fallback. The two
	 * cases are told apart by an explicit adapter.exists() check, not
	 * by the loadData() return value: loadData() maps a missing file
	 * to null only when the failed read carries an ENOENT error code,
	 * and on some filesystems the read fails with a different code.
	 */
	async loadSettings(): Promise<void> {
		const { data, restoredFromBackup, blockSaving } =
			await this.readStoredSettings();

		if (blockSaving) {
			this.settingsLoadFailed = true;
			// A readable backup keeps the session usable on the
			// initial load; a failed reload keeps the current
			// in-memory settings (external change while the file is
			// locked). Saving stays blocked either way so the possibly
			// intact and possibly newer stored settings are never
			// overwritten by this session.
			const backupApplies =
				!this.settingsInitialized &&
				data !== undefined &&
				data !== null;
			new Notice(
				backupApplies
					? 'Advanced Audio Recorder: the settings file could not ' +
							'be read. Settings from the backup file are used ' +
							'for this session, and saving is disabled to ' +
							'protect the stored file. Restart Obsidian to ' +
							'recover.'
					: 'Advanced Audio Recorder: the settings file could not ' +
							'be read. Settings stored on disk are untouched, ' +
							'and saving is disabled to protect them. Restart ' +
							'Obsidian to recover.',
			);
			if (backupApplies) {
				this.settings = await mergeSettingsAsync(data);
			} else if (!this.settingsInitialized) {
				this.settings = await mergeSettingsAsync({});
			}
			this.settingsInitialized = true;
			return;
		}

		this.settingsLoadFailed = false;
		this.settings = await mergeSettingsAsync(data ?? {});
		this.settingsInitialized = true;
		if (restoredFromBackup) {
			new Notice('Settings were restored from the backup file.');
			// Complete the recovery: recreate the missing data.json
			// right away instead of leaving the backup as the only
			// copy until the user happens to change a setting.
			// saveSettings() is not usable here: loadSettings() runs
			// before the RecordingManager is constructed in onload.
			await this.saveData(serializeSettings(this.settings));
		}
		await this.backupSettings();
	}

	/**
	 * Saves plugin settings to storage.
	 */
	async saveSettings(): Promise<void> {
		if (this.settingsLoadFailed) {
			// Never overwrite a possibly intact data.json with the
			// in-memory fallback that replaced the unreadable settings
			new Notice(
				'Settings were not loaded correctly; changes are not saved ' +
					'to protect your stored settings. Restart Obsidian.',
			);
			// The settings tab mutates the in-memory settings before
			// calling saveSettings: propagate them so every subsystem
			// sees the same session state even though nothing is
			// persisted
			this.recordingManager.updateSettings(this.settings);
			this.playerRegistrar.refresh();
			return;
		}
		await this.saveData(serializeSettings(this.settings));
		await this.backupSettings();
		this.recordingManager.updateSettings(this.settings);
		// Apply player-affecting changes (enable toggle, waveform, etc.)
		// to open embeds immediately, without re-opening the note
		this.playerRegistrar.refresh();
	}

	/**
	 * Called by Obsidian when data.json changes externally (sync,
	 * manual edit) while the plugin is loaded. Reloads settings so the
	 * stale in-memory copy does not overwrite the external change on
	 * the next save.
	 */
	override async onExternalSettingsChange(): Promise<void> {
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
	 * is retried once, then the backup file is tried. The same
	 * missing-vs-unreadable distinction applies to the backup itself:
	 * when data.json is missing, the backup is the only copy of the
	 * settings, so a backup that exists but cannot be read blocks
	 * saving instead of being overwritten with defaults.
	 * @returns Read result: stored settings, null when no settings
	 * exist on disk, or undefined when stored settings could not be
	 * read; blockSaving is set whenever an existing settings file
	 * could not be read
	 */
	private async readStoredSettings(): Promise<StoredSettingsReadResult> {
		let data = await this.tryLoadData();
		if (data !== undefined && data !== null) {
			return { data, restoredFromBackup: false, blockSaving: false };
		}

		if (!(await this.pluginFileExists(SETTINGS_DATA_FILE))) {
			if (!(await this.pluginFileExists(SETTINGS_BACKUP_FILE))) {
				// First install: no settings anywhere, defaults apply
				// and saving stays enabled so data.json gets created
				// on the next change
				return {
					data: null,
					restoredFromBackup: false,
					blockSaving: false,
				};
			}
			// Missing data.json with a backup present: restore the
			// lost settings and have the caller persist them. An
			// unreadable backup is the only remaining copy of the
			// settings, so it blocks saving instead.
			const backup = await this.readSettingsBackup();
			return {
				data: backup,
				restoredFromBackup: backup !== undefined,
				blockSaving: backup === undefined,
			};
		}

		await delay(SETTINGS_READ_RETRY_DELAY_MS);
		data = await this.tryLoadData();
		if (data !== undefined && data !== null) {
			return { data, restoredFromBackup: false, blockSaving: false };
		}

		// data.json exists but is unreadable: a readable backup keeps
		// the session usable in memory, while saving stays blocked so
		// the possibly newer data.json is never overwritten with
		// backup-derived values
		return {
			data: await this.readSettingsBackup(),
			restoredFromBackup: false,
			blockSaving: true,
		};
	}

	/**
	 * Calls loadData() and maps a rejected read to undefined. The
	 * current Obsidian implementation never rejects (read and parse
	 * failures are caught internally and reported as undefined), but
	 * that behavior is undocumented; mapping a rejection to the
	 * failed-read result keeps the missing-vs-unreadable
	 * discrimination independent of Obsidian internals.
	 * @returns Stored settings, null for a missing file, or undefined
	 * when the read failed
	 */
	private async tryLoadData(): Promise<
		Partial<AudioRecorderSettings> | null | undefined
	> {
		try {
			return (await this.loadData()) as
				| Partial<AudioRecorderSettings>
				| null
				| undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Checks whether a file in the plugin folder is present on disk.
	 * @param fileName - File name inside the plugin folder
	 * @returns True when the file exists, or when its existence cannot
	 * be determined: the protective assumption treats an unverifiable
	 * file as present so it is never overwritten while possibly intact
	 */
	private async pluginFileExists(fileName: string): Promise<boolean> {
		const filePath = this.getPluginFilePath(fileName);
		if (!filePath) {
			return false;
		}
		try {
			return await this.app.vault.adapter.exists(filePath);
		} catch {
			return true;
		}
	}

	/**
	 * Reads and parses the settings backup file written on every
	 * successful load and save. User-facing messaging is left to the
	 * callers, which know whether the backup replaces a missing
	 * data.json or only carries the session over an unreadable one.
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
			return JSON.parse(raw) as Partial<AudioRecorderSettings>;
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
	 * Builds the shared services injected into every plugin action.
	 * The player registrar is created after the context menu, so the
	 * primer closure resolves it lazily when a processing run finishes.
	 */
	private createActionServices(): ActionServices {
		return {
			app: this.app,
			getSettings: () => this.settings,
			createTranscriptionModalOptions: () =>
				this.createTranscriptionModalOptions(),
			primeForEnhancement: (paths) =>
				this.playerRegistrar.primeSavedRecordingsForEnhancement(paths),
			getWorkerClient: () => this.encodingWorker,
		};
	}

	/**
	 * Registers plugin commands: the recording-session commands plus
	 * every file action from the shared registry, so each context-menu
	 * feature is also reachable from the palette and assignable in the
	 * Hotkeys settings.
	 */
	private registerCommands(): void {
		this.addCommand({
			id: COMMAND_IDS.startStopRecording,
			name: 'Start/stop recording',
			callback: () => {
				void this.recordingManager.toggleRecording();
			},
		});

		this.addCommand({
			id: COMMAND_IDS.pauseResumeRecording,
			name: 'Pause/resume recording',
			callback: () => {
				this.recordingManager.togglePauseResume();
			},
		});

		this.addCommand({
			id: COMMAND_IDS.addRecordingMarker,
			name: 'Add marker/chapter at current position',
			checkCallback: (checking: boolean) => {
				if (!this.recordingManager.canDropMarker()) {
					return false;
				}
				if (!checking) {
					this.openMarkerModal();
				}
				return true;
			},
		});

		this.addCommand({
			id: COMMAND_IDS.selectAudioInputDevice,
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

		registerRecordingActionCommands(
			this,
			createRecordingMarkerActions((kind) => {
				this.openMarkerModal(kind);
			}),
			() => this.recordingManager.canDropMarker(),
		);

		registerFileActionCommands(
			this,
			FILE_ACTIONS,
			this.createActionServices(),
		);
	}

	/**
	 * Transcribe-on-save hook: when enabled, transcribes the first saved
	 * audio file (`audioPaths[0]`). The transcript is targeted at the same
	 * note the recording embed was inserted into (`result.notePath`), so the
	 * timecode links resolve there even if the user navigated to another note
	 * before the async job ran.
	 *
	 * Only the first file is transcribed by design: a multi-track session
	 * produces several tracks of the same audio (transcribing each would be
	 * redundant and multiply API cost), and an auto-split session would
	 * otherwise fire one transcription request per part. For those cases the
	 * user transcribes the desired file explicitly via the context menu or
	 * the "Transcribe audio" command.
	 * @param result - The saved audio paths and the note the links landed in
	 */
	private handleRecordingSaved(result: RecordingSaveResult): void {
		this.playerRegistrar.primeSavedRecordingsForEnhancement(
			result.audioPaths,
		);

		if (
			!this.settings.transcriptionEnabled ||
			!this.settings.transcribeOnSave ||
			result.audioPaths.length === 0
		) {
			return;
		}
		const [firstAudioPath] = result.audioPaths;
		if (!firstAudioPath) {
			return;
		}
		const file = this.app.vault.getFileByPath(firstAudioPath);
		if (!file) {
			return;
		}
		// Open the transcription modal and auto-run it: the user gets visible
		// progress and a cancel button for what can be a long, paid job instead
		// of a silent background request. The modal reports its own errors and
		// writes the configured outputs (with a file fallback when the note is
		// not editable).
		new TranscriptionModal(this.app, file, () => this.settings, {
			...this.createTranscriptionModalOptions(),
			autoStart: true,
			notePath: result.notePath ?? undefined,
		}).open();
	}

	/**
	 * Creates modal options that let a minimized transcription report progress
	 * in this plugin's status bar.
	 * @returns Transcription modal options
	 */
	private createTranscriptionModalOptions(): TranscriptionModalOptions {
		const id = ++this.nextBackgroundTranscriptionId;
		return {
			backgroundProgress: {
				show: (progress: SaveProgress, restore: () => void) => {
					// Re-insert so the most recently updated job sorts last and
					// becomes the rendered one, even when several are minimized.
					this.backgroundTranscriptions.delete(id);
					this.backgroundTranscriptions.set(id, {
						progress,
						restore,
					});
					this.renderStatusBar();
				},
				clear: () => {
					if (this.backgroundTranscriptions.delete(id)) {
						this.renderStatusBar();
					}
				},
			},
		};
	}

	/**
	 * Returns the minimized transcription that should currently occupy the
	 * status bar (the most recently updated one), or undefined when none are
	 * minimized.
	 * @returns The active background transcription, if any
	 */
	private activeBackgroundTranscription():
		| BackgroundTranscriptionProgress
		| undefined {
		let active: BackgroundTranscriptionProgress | undefined;
		for (const entry of this.backgroundTranscriptions.values()) {
			active = entry;
		}
		return active;
	}

	/**
	 * Renders the shared status bar. Recording states take precedence over
	 * minimized transcription progress because they carry recording controls.
	 */
	private renderStatusBar(): void {
		const active = this.activeBackgroundTranscription();
		if (this.recordingStatus === RecordingStatus.Idle && active) {
			renderTranscriptionStatusBar(this.statusBarItem, active.progress, {
				onActivate: active.restore,
				activationLabel: RESTORE_TRANSCRIPTION_LABEL,
			});
			return;
		}

		const controls = this.buildRecordingControls(this.recordingStatus);
		updateStatusBar(
			this.statusBarItem,
			this.recordingStatus,
			this.recordingSaveProgress,
			controls,
			{
				showStats: this.settings.showRecordingStats,
				showMeter: this.settings.showInputLevelMeter,
			},
		);
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
			// Only offered when markers are enabled, since they are surfaced
			// solely by the enhanced player; absent hides the status-bar button
			onAddMarker: this.settings.playerEnableMarkers
				? () => {
						this.openMarkerModal();
					}
				: undefined,
		};
	}

	/**
	 * Captures a marker at the current recording position and opens the
	 * naming modal. No-op when a marker cannot be dropped right now.
	 * @param preselectKind - Marker kind fixed by the invoking command;
	 *   defaults to the kind last chosen in the modal
	 */
	private openMarkerModal(preselectKind?: MarkerKind): void {
		const handle = this.recordingManager.captureMarkerDraft(preselectKind);
		if (!handle) {
			return;
		}
		new RecordingMarkerModal(this.app, handle).open();
	}

	/**
	 * Sets up the status bar item and the live-stats refresh interval.
	 */
	private setupStatusBar(): void {
		this.statusBarItem = this.addStatusBarItem();
		initializeStatusBar(this.statusBarItem);
		// Refresh the live recording indicators a few times a second so the
		// timer and meter stay smooth without re-rendering the status bar.
		this.registerInterval(
			window.setInterval(() => {
				this.pumpLiveStats();
			}, LIVE_STATS_INTERVAL_MS),
		);
	}

	/**
	 * Renders the status bar and the mobile banner for a status change.
	 * @param status - New recording status
	 * @param saveProgress - Optional save progress for the saving state
	 */
	private handleStatusChange(
		status: RecordingStatus,
		saveProgress?: SaveProgress,
	): void {
		this.recordingStatus = status;
		this.recordingSaveProgress =
			status === RecordingStatus.Saving ? saveProgress : undefined;
		// Route through renderStatusBar so minimized transcription progress
		// keeps its precedence when recording returns to idle.
		this.renderStatusBar();
		updateRibbonIcon(this.ribbonIconEl, status);

		const active =
			status === RecordingStatus.Recording ||
			status === RecordingStatus.Paused;
		if (
			active &&
			Platform.isMobile &&
			this.settings.mobileRecordingBanner
		) {
			this.recordingBanner.show(status === RecordingStatus.Paused);
		} else {
			this.recordingBanner.hide();
		}
	}

	/**
	 * Pushes live elapsed time, recorded size, and input level to the
	 * status bar and mobile banner while a recording is active.
	 */
	private pumpLiveStats(): void {
		const status = this.recordingManager.getStatus();
		if (
			status !== RecordingStatus.Recording &&
			status !== RecordingStatus.Paused
		) {
			return;
		}
		const elapsedMs = this.recordingManager.getElapsedMs();
		updateRecordingLiveStats(this.statusBarItem, {
			elapsedMs,
			bytes: this.recordingManager.getRecordedBytes(),
			level: this.recordingManager.getInputLevel(),
		});
		this.recordingBanner.update(
			elapsedMs,
			status === RecordingStatus.Paused,
		);
	}
}
