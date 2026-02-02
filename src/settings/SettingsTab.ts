/**
 * Settings tab UI for the Audio Recorder plugin.
 * @module settings/SettingsTab
 */

import {
	App,
	DropdownComponent,
	PluginSettingTab,
	Setting,
	TFolder,
	Vault,
} from 'obsidian';
import type { Plugin } from 'obsidian';
import type { AudioRecorderSettings, OutputMode } from './Settings';

/**
 * Plugin interface for settings tab.
 */
interface AudioRecorderPluginInterface extends Plugin {
	settings: AudioRecorderSettings;
	saveSettings(): Promise<void>;
}

/**
 * Settings tab for the Audio Recorder plugin.
 */
export class AudioRecorderSettingTab extends PluginSettingTab {
	plugin: AudioRecorderPluginInterface;

	/**
	 * Creates a new AudioRecorderSettingTab.
	 * @param app - The Obsidian App instance
	 * @param plugin - The plugin instance
	 */
	constructor(app: App, plugin: AudioRecorderPluginInterface) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Gets all available audio input devices.
	 */
	async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((device) => device.kind === 'audioinput');
	}

	/**
	 * Gets supported audio formats.
	 */
	getSupportedFormats(): string[] {
		const formats = ['ogg', 'webm', 'mp3', 'm4a', 'mp4', 'wav'];
		return formats.filter((format) =>
			MediaRecorder.isTypeSupported(`audio/${format}`),
		);
	}

	/**
	 * Gets folder options for autocomplete.
	 */
	getFolderOptions(): string[] {
		const folders: string[] = [];
		Vault.recurseChildren(this.app.vault.getRoot(), (file) => {
			if (file instanceof TFolder) {
				folders.push(file.path);
			}
		});
		return folders;
	}

	/**
	 * Displays the settings UI.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Audio recorder')
			.setDesc('Configure the audio recorder plugin.')
			.setHeading();

		const supportedFormats = this.getSupportedFormats();
		new Setting(containerEl)
			.setName('Recording format')
			.setDesc('Select the audio recording format.')
			.addDropdown((dropdown) => {
				supportedFormats.forEach((format) => {
					dropdown.addOption(format, format);
				});
				dropdown.setValue(this.plugin.settings.recordingFormat);
				dropdown.onChange(async (value) => {
					this.plugin.settings.recordingFormat = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Sample rate')
			.setDesc('Select the audio sample rate.')
			.addDropdown((dropdown) => {
				const sampleRates = [8000, 16000, 22050, 44100, 48000];
				sampleRates.forEach((rate) => {
					dropdown.addOption(String(rate), String(rate));
				});
				dropdown.setValue(String(this.plugin.settings.sampleRate));
				dropdown.onChange(async (value) => {
					this.plugin.settings.sampleRate = parseInt(value, 10);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Save folder')
			.setDesc(
				'Specify the folder to save recordings. Autocomplete enabled.',
			)
			.addText((text) => {
				const folderOptions = this.getFolderOptions();
				text.inputEl.setAttribute('list', 'folder-options');
				const datalist = document.createElement('datalist');
				datalist.id = 'folder-options';
				folderOptions.forEach((folder) => {
					const option = document.createElement('option');
					option.value = folder;
					datalist.appendChild(option);
				});
				text.inputEl.appendChild(datalist);
				text.setValue(this.plugin.settings.saveFolder);
				text.onChange(async (value) => {
					this.plugin.settings.saveFolder = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl).setName('File naming').setHeading();

		new Setting(containerEl)
			.setName('File prefix')
			.setDesc('Set a prefix for the audio file names.')
			.addText((text) =>
				text
					.setPlaceholder('Enter file prefix')
					.setValue(this.plugin.settings.filePrefix)
					.onChange(async (value) => {
						this.plugin.settings.filePrefix = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enable debug logging')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Multi-track recording').setHeading();

		new Setting(containerEl)
			.setName('Enable multi-track recording')
			.setDesc('Toggle to activate or deactivate multi-track recording.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableMultiTrack)
					.onChange(async (value) => {
						this.plugin.settings.enableMultiTrack = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.enableMultiTrack) {
			new Setting(containerEl)
				.setName('Maximum tracks')
				.setDesc('Set the number of simultaneous tracks (1-8).')
				.addSlider((slider) =>
					slider
						.setLimits(1, 8, 1)
						.setValue(this.plugin.settings.maxTracks)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.maxTracks = value;
							await this.plugin.saveSettings();
							this.display();
						}),
				);

			new Setting(containerEl)
				.setName('Output mode')
				.setDesc(
					'Choose between single combined file or separate files for each track.',
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOption('single', 'Single file')
						.addOption('multiple', 'Multiple files')
						.setValue(this.plugin.settings.outputMode)
						.onChange(async (value: string) => {
							this.plugin.settings.outputMode =
								value as OutputMode;
							await this.plugin.saveSettings();
						}),
				);

			for (let i = 1; i <= this.plugin.settings.maxTracks; i++) {
				new Setting(containerEl)
					.setName(`Audio source for track ${String(i)}`)
					.setDesc(
						`Select the audio input device for track ${String(i)}`,
					)
					.addDropdown(async (dropdown) => {
						await this.populateAudioDevices(dropdown);
						dropdown.setValue(
							this.plugin.settings.trackAudioSources[i] || '',
						);
						dropdown.onChange(async (value) => {
							this.plugin.settings.trackAudioSources[i] = value;
							await this.plugin.saveSettings();
						});
					});
			}
		}
	}

	/**
	 * Populates dropdown with audio devices.
	 * @param dropdown - The dropdown component
	 */
	async populateAudioDevices(dropdown: DropdownComponent): Promise<void> {
		const devices = await this.getAudioInputDevices();
		devices.forEach((device) => {
			const label =
				device.label ||
				`Audio device ${device.deviceId.substring(0, 8)}`;
			dropdown.addOption(device.deviceId, label);
		});
	}
}
