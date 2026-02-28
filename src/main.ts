/**
 * Advanced Audio Recorder plugin for Obsidian.
 * @module main
 */

import { Plugin } from 'obsidian';
import { RecordingStatus } from './types';
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
	 * Called when the plugin is loaded.
	 */
	async onload(): Promise<void> {
		await this.loadSettings();

		this.recordingManager = new RecordingManager(
			this.app,
			this.settings,
			(status: RecordingStatus) => {
				updateStatusBar(this.statusBarItem, status);
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

		this.contextMenu = new ContextMenu(this.app, this);
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
	 */
	async loadSettings(): Promise<void> {
		const data =
			(await this.loadData()) as Partial<AudioRecorderSettings> | null;
		this.settings = await mergeSettingsAsync(data ?? {});
	}

	/**
	 * Saves plugin settings to storage.
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(serializeSettings(this.settings));
		this.recordingManager.updateSettings(this.settings);
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
	 * Sets up the status bar item.
	 */
	private setupStatusBar(): void {
		this.statusBarItem = this.addStatusBarItem();
		initializeStatusBar(this.statusBarItem);
	}
}
