/**
 * Advanced Audio Recorder plugin for Obsidian.
 * @module main
 */

import { Notice, Plugin } from 'obsidian';
import type { TFile } from 'obsidian';
import { RecordingStatus } from './types';
import type {
	SaveProgress,
	RecordingControls,
	RecordingSaveResult,
} from './types';
import { PLUGIN_LOG_PREFIX } from './constants';
import {
	isDeviceSelectionSupported,
	isRecordingBannerSupported,
} from './platform/capabilities';
import type { AudioRecorderSettings } from './settings/settingsSchema';
import {
	mergeSettingsAsync,
	serializeSettings,
} from './settings/settingsSerialization';
import { AudioRecorderSettingTab } from './settings/SettingsTab';
import { RecordingManager } from './recording/RecordingManager';
import { detectSilentChannel } from './recording/silentChannelDetector';
import type { ChannelMode } from './audio/downmix';
import { ConversionModal } from './ui/ConversionModal';
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
	renderPlaybackStatusBar,
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
import { RecordingSidecarStore } from './sidecar/RecordingSidecarStore';
import { AutoChapterService } from './chapters/AutoChapterService';
import { RecordingMarkerModal } from './ui/MarkerModal';
import { isAudioFile } from './utils/audioFile';
import { openPluginSettings } from './obsidian/settingsNavigation';
import { transcriptionRefusal } from './settings/settingsAttention';
import { registerCliCommands, type CliHost } from './obsidian/cliCommands';
import { TranscriptionModal } from './ui/TranscriptionModal';
import type { TranscriptionModalOptions } from './ui/TranscriptionModal';
import {
	isProviderAvailableOnPlatform,
	SessionCostTracker,
} from './transcription/api';
import { COMMAND_IDS } from './constants';
import type { MarkerKind } from './markers/markerModel';
import type { PlaybackControlsState } from './player/playbackControls';
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

interface SilentChannelSuggestion {
	file: TFile;
	keepMode: ChannelMode;
	silentSide: 'left' | 'right';
}

/**
 * Advanced Audio Recorder plugin for Obsidian.
 */
export default class AudioRecorderPlugin extends Plugin {
	// Obsidian 1.13 declares `settings?: unknown` on the base Plugin; narrow it
	// to the plugin's own type. Assigned in onload via loadSettings().
	declare settings: AudioRecorderSettings;
	private recordingManager!: RecordingManager;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private contextMenu!: ContextMenu;
	private recordingBanner!: RecordingBanner;
	private playerRegistrar!: EnhancedPlayerRegistrar;
	private autoChapterService!: AutoChapterService;
	/** Shared per-recording sidecar store (markers + transcript data). */
	private sidecarStore!: RecordingSidecarStore;
	private journal!: SessionJournal;
	private encodingWorker: EncodingWorkerClient | null = null;
	private recordingStatus: RecordingStatus = RecordingStatus.Idle;
	private recordingSaveProgress: SaveProgress | undefined;
	/** Active enhanced-player playback represented in the shared status bar. */
	private playbackState: PlaybackControlsState | null = null;
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
	 * Session-wide per-engine transcription spending. Lives on the plugin
	 * (transcription services are per-run) so the running totals survive
	 * across dialogs until Obsidian restarts.
	 */
	private readonly transcriptionCostTracker = new SessionCostTracker();
	/** Current actionable silent-channel notice, replaced per save. */
	private silentChannelNotice: Notice | null = null;
	/** Invalidates an older asynchronous analysis when a newer save starts. */
	private silentChannelSuggestionGeneration = 0;
	/**
	 * Whether Obsidian has unloaded this plugin. Work already in flight when
	 * that happens must not reach back into the UI it tore down.
	 */
	private unloaded = false;
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
		// One sidecar store owns every `<recording>.markers.json`: markers and
		// transcript data live in the same document, so a single cache and
		// serialized write chain keep the two sections from clobbering each
		// other. It is shared by recording (which writes live markers at
		// stop), the player registrar (which reads/edits them), auto
		// chapters, transcription, and the rename dialog.
		this.sidecarStore = new RecordingSidecarStore(this.app);
		// Auto chapters write into the same store; the player registrar is
		// created later, so the refresh closure resolves it lazily.
		this.autoChapterService = new AutoChapterService(
			this.app,
			() => this.settings,
			this.sidecarStore,
			(path) => {
				this.playerRegistrar.reloadMarkersFor(path);
			},
			// Chapter generation bills the LLM provider, so its estimated cost
			// joins the same session counter the transcription runs report to.
			{ costSink: this.transcriptionCostTracker },
		);
		this.recordingBanner = new RecordingBanner(() => {
			void this.recordingManager.stopRecording();
		});
		this.recordingManager = new RecordingManager(
			this.app,
			this.settings,
			(status: RecordingStatus, saveProgress?: SaveProgress) => {
				this.handleStatusChange(status, saveProgress);
			},
			this.sidecarStore,
			this.journal,
			(result: RecordingSaveResult) => {
				this.handleRecordingSaved(result);
			},
			() => this.encodingWorker,
		);

		this.addSettingTab(new AudioRecorderSettingTab(this.app, this));
		this.registerCommands();
		// The desktop command line, where the app has one. Reports whether it
		// registered, which is what the CLI-less platforms and the Obsidians
		// below 1.12.2 answer.
		registerCliCommands(this, this.createCliHost());
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
			this.sidecarStore,
			mediaKindStore,
		);
		this.playerRegistrar.subscribePlayback((state) => {
			this.playbackState = state;
			// Recording and saving own the status bar and repaint their live
			// stats on their own cadence. A playback snapshot arrives on every
			// timeupdate, so rendering it here while recording would rebuild the
			// recording controls between those updates and flicker the stats.
			// Store it and let the recording state render it once it goes idle.
			if (this.recordingStatus === RecordingStatus.Idle) {
				this.renderStatusBar();
			}
		});
		this.playerRegistrar.register();

		// Recovery runs after the workspace is ready so plugin load is
		// never delayed; a failure here must not break the plugin
		this.app.workspace.onLayoutReady(() => {
			void this.checkForInterruptedSessions();
		});
	}

	/**
	 * Runs once, when the user enables the plugin deliberately - an install, or
	 * a re-enable - rather than on every start.
	 *
	 * It is the one moment Obsidian says a plugin may engage with the user, and
	 * the Settings dialog is already open on Community plugins when it comes.
	 * Switching it to this plugin's own tab puts the documentation callout and
	 * the three rows a first recording needs (input, format, save folder) in
	 * front of them, instead of leaving a freshly enabled recorder to be found.
	 */
	override onUserEnable(): void {
		openPluginSettings(this.app, this.manifest.id);
	}

	/**
	 * What the CLI is allowed to ask of the plugin.
	 *
	 * A port rather than the plugin itself: a command line reaches a running
	 * app from outside it, and what it may do here is these five things.
	 * @returns The host the CLI commands are built over
	 */
	private createCliHost(): CliHost {
		return {
			recordingStatus: (): RecordingStatus =>
				this.recordingManager.getStatus(),
			startRecording: (): Promise<string | null> =>
				this.recordingManager.startRecording(),
			stopRecording: (): Promise<string | null> =>
				this.recordingManager.stopRecording(),
			recordingFormat: (): string => this.settings.recordingFormat,
			transcriptionRefusal: (): string | null =>
				transcriptionRefusal(this.settings),
			audioFileAt: (path: string): TFile | null => {
				const file = this.app.vault.getFileByPath(path);
				return file && isAudioFile(file) ? file : null;
			},
			// The same bargain every other surface makes for a paid job: the
			// dialog runs it, reports its progress, and can be cancelled.
			transcribe: (file: TFile): void => {
				this.openTranscription(file);
			},
		};
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
						// Per session, not per run: recoverSession writes the
						// journal back when it is done, and that write can
						// fail on a read-only or full vault. One session
						// failing must not abandon the sessions after it, nor
						// swallow the report of what was already brought back.
						try {
							const result = await recoverSession(
								session,
								this.journal,
								this.app,
							);
							recovered.push(...result.recoveredPaths);
							failed.push(...result.failedTracks);
						} catch (error) {
							console.error(
								`${PLUGIN_LOG_PREFIX} Failed to recover session:`,
								session.sessionId,
								error,
							);
							failed.push(
								...session.tracks.map(
									(track) => track.fileBaseName,
								),
							);
						}
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
						// Same reasoning as the recovery loop above: a
						// journal write that fails on one session must not
						// leave the rest of them undiscarded and unreported.
						try {
							failedPaths.push(
								...(await discardSession(
									session,
									this.journal,
									this.app,
								)),
							);
						} catch (error) {
							console.error(
								`${PLUGIN_LOG_PREFIX} Failed to discard session:`,
								session.sessionId,
								error,
							);
							failedPaths.push(
								...session.tracks.flatMap(
									(track) => track.segmentPaths,
								),
							);
						}
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
		// Set before anything is torn down: the recorder's stop sequence is
		// asynchronous, so disabling the plugin mid-save leaves its status and
		// saved-recording callbacks in flight, and both of them reach back
		// into UI Obsidian has already detached.
		this.unloaded = true;
		this.silentChannelSuggestionGeneration++;
		this.silentChannelNotice?.hide();
		this.silentChannelNotice = null;
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
			saveSettings: () => this.saveSettings(),
			createTranscriptionModalOptions: () =>
				this.createTranscriptionModalOptions(),
			primeForEnhancement: (paths) =>
				this.playerRegistrar.primeSavedRecordingsForEnhancement(paths),
			getWorkerClient: () => this.encodingWorker,
			autoChapters: this.autoChapterService,
			recordingSidecar: this.sidecarStore,
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
			// Hidden from the palette where device selection is
			// unavailable (mobile records from the default microphone).
			checkCallback: (checking: boolean) => {
				if (!isDeviceSelectionSupported()) {
					return false;
				}
				if (!checking) {
					void showDeviceSelectionModal(
						this.app,
						async (deviceId: string) => {
							this.settings.audioDeviceId = deviceId;
							await this.saveSettings();
						},
					);
				}
				return true;
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
		if (this.unloaded) {
			return;
		}
		this.playerRegistrar.primeSavedRecordingsForEnhancement(
			result.audioPaths,
		);

		// Fire-and-forget lopsided-stereo check; failures never touch the
		// stop sequence and are contained at this orchestration boundary.
		void this.maybeSuggestMonoConversion(result).catch((error: unknown) => {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Silent-channel suggestion failed:`,
				error,
			);
		});

		if (
			!this.settings.transcriptionEnabled ||
			!this.settings.transcribeOnSave ||
			result.audioPaths.length === 0
		) {
			return;
		}
		// A synced desktop config may select an engine this platform
		// cannot run (local whisper.cpp on mobile): auto-starting would
		// pop a doomed transcription after every recording.
		if (
			!isProviderAvailableOnPlatform(this.settings.transcriptionProvider)
		) {
			new Notice(
				'Transcription was skipped: the selected engine is not available on this device. Pick a cloud engine in settings.',
			);
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
		this.openTranscription(file, result.notePath ?? undefined);
	}

	/**
	 * Opens the transcription dialog on a file and starts it there.
	 *
	 * Every transcription this plugin starts on its own - after a recording,
	 * from the command line - goes through here rather than in the background:
	 * the user gets visible progress and a cancel button for what can be a
	 * long, paid job. The dialog reports its own errors and writes the
	 * configured outputs, with a file fallback when the note is not editable.
	 * @param file - The audio file to transcribe
	 * @param notePath - Note the transcript's links should resolve in, where
	 *   the caller knows one; the dialog picks the active note otherwise
	 */
	private openTranscription(file: TFile, notePath?: string): void {
		new TranscriptionModal(this.app, file, () => this.settings, {
			...this.createTranscriptionModalOptions(),
			autoStart: true,
			notePath,
		}).open();
	}

	/**
	 * Checks a freshly saved recording for the lopsided-stereo pattern
	 * (one silent channel, a single mic through a dual-input interface)
	 * and, when found, shows a Notice offering a one-click conversion to
	 * mono that keeps the channel with audio. One file per output track is
	 * inspected (the first part for auto-split), sequentially to bound peak
	 * decode memory. Gated by the setting; a no-op when disabled or when
	 * nothing lopsided is found.
	 * @param result - The saved audio paths
	 */
	private async maybeSuggestMonoConversion(
		result: RecordingSaveResult,
	): Promise<void> {
		const generation = ++this.silentChannelSuggestionGeneration;
		this.silentChannelNotice?.hide();
		this.silentChannelNotice = null;
		if (
			!this.settings.detectSilentChannelOnSave ||
			result.audioPaths.length === 0
		) {
			return;
		}
		const perTrackPaths = result.trackFiles
			?.map((group) => group.files[0])
			.filter((path): path is string => Boolean(path));
		const candidates = Array.from(
			new Set(
				perTrackPaths && perTrackPaths.length > 0
					? perTrackPaths
					: result.audioPaths.slice(0, 1),
			),
		);
		const suggestions: SilentChannelSuggestion[] = [];
		for (const path of candidates) {
			if (generation !== this.silentChannelSuggestionGeneration) {
				return;
			}
			const file = this.app.vault.getFileByPath(path);
			if (!file) {
				continue;
			}
			const detection = await detectSilentChannel(this.app, file, {
				knownDurationSeconds: result.durationSeconds,
			});
			if (detection) {
				suggestions.push({
					file,
					keepMode: detection.keepMode,
					silentSide:
						detection.silentChannel === 1 ? 'right' : 'left',
				});
			}
		}
		if (
			generation !== this.silentChannelSuggestionGeneration ||
			!this.settings.detectSilentChannelOnSave ||
			suggestions.length === 0
		) {
			return;
		}
		this.showSilentChannelNotice(suggestions);
	}

	/**
	 * Shows the actionable lopsided-stereo Notice. Clicking "Convert to
	 * mono" opens the conversion dialog preset to the channel that
	 * carries audio, so the user confirms format/links and runs it.
	 * @param suggestions - Lopsided files and the channel each should keep
	 */
	private showSilentChannelNotice(
		suggestions: SilentChannelSuggestion[],
	): void {
		this.silentChannelNotice?.hide();
		const fragment = createFragment();
		if (suggestions.length > 1) {
			fragment.append(
				`${String(suggestions.length)} recordings have a silent channel: `,
			);
		}
		for (const [index, suggestion] of suggestions.entries()) {
			if (index > 0) {
				fragment.append(' ');
			}
			if (suggestions.length === 1) {
				fragment.append(
					`Recording's ${suggestion.silentSide} channel is silent. `,
				);
			}
			const button = createEl('button', {
				cls: 'aar-silent-channel-convert',
				text:
					suggestions.length === 1
						? 'Convert to mono'
						: `Convert ${suggestion.file.name}`,
				attr: { type: 'button' },
			});
			button.addEventListener('click', () => {
				if (suggestions.length === 1) {
					this.silentChannelNotice?.hide();
					this.silentChannelNotice = null;
				}
				this.openMonoConversion(suggestion.file, suggestion.keepMode);
			});
			fragment.append(button);
		}
		this.silentChannelNotice = new Notice(fragment, 0);
	}

	/**
	 * Opens the conversion dialog preset to the given channel mode and
	 * primes the converted file for the enhanced player. Extracted so
	 * the silent-channel prompt's action is testable without the Notice.
	 * @param file - The file to convert
	 * @param keepMode - Channel mode to preselect in the dialog
	 */
	private openMonoConversion(file: TFile, keepMode: ChannelMode): void {
		new ConversionModal(this.app, file, () => this.settings, {
			onConverted: (convertedPath) => {
				this.playerRegistrar.primeSavedRecordingsForEnhancement([
					convertedPath,
				]);
			},
			getWorkerClient: () => this.encodingWorker,
			initialChannelMode: keepMode,
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
			// Remember the run's dictionary-profile choice so it defaults next
			// time and applies to transcribe-on-save.
			onProfileSelected: async (profileId: string) => {
				this.settings.transcriptionDictionaryProfileId = profileId;
				await this.saveSettings();
			},
			// Remember the run's chapter-profile choice so it defaults next
			// time and applies to the after-transcription generation.
			onChapterProfileSelected: async (profileId: string) => {
				this.settings.transcriptionChapterPromptProfileId = profileId;
				await this.saveSettings();
			},
			// Remember the run's participant-profile choice so it defaults next
			// time and applies to transcribe-on-save.
			onSpeakerProfileSelected: async (profileId: string) => {
				this.settings.transcriptionSpeakerProfileId = profileId;
				await this.saveSettings();
			},
			costTracker: this.transcriptionCostTracker,
			// Speaker-name continuity: the run re-applies stored names and
			// registers the outputs it writes in the recording's sidecar.
			sidecar: this.sidecarStore,
			// After-transcription auto chapters: runs on the fresh in-memory
			// transcript, reporting through its own Notices.
			generateChapters: async (file, transcript) => {
				await this.autoChapterService.generate(file, transcript);
			},
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
	 * Renders the shared status bar. Recording and saving take precedence,
	 * followed by active playback and minimized transcription progress.
	 */
	private renderStatusBar(): void {
		const active = this.activeBackgroundTranscription();
		if (
			this.recordingStatus === RecordingStatus.Idle &&
			this.playbackState
		) {
			renderPlaybackStatusBar(this.statusBarItem, this.playbackState);
			return;
		}
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
		if (this.unloaded) {
			return;
		}
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
			isRecordingBannerSupported() &&
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
