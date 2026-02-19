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
	private deviceDropdowns: DropdownComponent[] = [];
	private readonly bitrateOptionsKbps = [64, 96, 128, 160, 192, 256, 320];

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
		return formats.filter((format) => {
			if (format === 'wav') {
				return (
					MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ||
					MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
				);
			}
			if (format === 'webm' || format === 'ogg') {
				return MediaRecorder.isTypeSupported(
					`audio/${format};codecs=opus`,
				);
			}
			return MediaRecorder.isTypeSupported(`audio/${format}`);
		});
	}

	private getCompressionDescription(format: string): string {
		if (format === 'wav') {
			return 'Uncompressed WAV (larger size; requires additional conversion after recording).';
		}
		return 'Compressed audio (smaller size; saved directly from recorder output).';
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
		this.deviceDropdowns = [];
		navigator.mediaDevices.ondevicechange = () => {
			void this.refreshDeviceList();
		};

		new Setting(containerEl)
			.setName('Recording')
			.setDesc(
				'Configure recording quality, output behavior, and device routing. Current implementation is safe for long recording sessions under normal use.',
			)
			.setHeading();

		const supportedFormats = this.getSupportedFormats();
		const selectedBitrateKbps = Math.round(
			this.plugin.settings.bitrate / 1000,
		);
		const updateOutputSummary = (container: HTMLElement): void => {
			container.setText(
				`Output: ${this.plugin.settings.recordingFormat.toUpperCase()}, ${String(Math.round(this.plugin.settings.bitrate / 1000))} kbps. ${this.getCompressionDescription(this.plugin.settings.recordingFormat)}`,
			);
		};
		let summaryEl: HTMLElement | null = null;
		new Setting(containerEl)
			.setName('Recording format')
			.setDesc(
				'Select the final file format. The selected format is applied when files are saved.',
			)
			.addDropdown((dropdown) => {
				supportedFormats.forEach((format) => {
					dropdown.addOption(format, format);
				});
				dropdown.setValue(this.plugin.settings.recordingFormat);
				dropdown.onChange(async (value) => {
					this.plugin.settings.recordingFormat = value;
					await this.plugin.saveSettings();
					if (summaryEl) {
						updateOutputSummary(summaryEl);
					}
				});
			});

		new Setting(containerEl)
			.setName('Audio bitrate')
			.setDesc(
				'Controls compression quality and resulting file size. Higher bitrate = better quality and larger files.',
			)
			.addDropdown((dropdown) => {
				this.bitrateOptionsKbps.forEach((bitrateKbps) => {
					dropdown.addOption(
						String(bitrateKbps),
						`${String(bitrateKbps)} kbps`,
					);
				});
				dropdown.setValue(String(selectedBitrateKbps));
				dropdown.onChange(async (value) => {
					this.plugin.settings.bitrate = parseInt(value, 10) * 1000;
					await this.plugin.saveSettings();
					if (summaryEl) {
						updateOutputSummary(summaryEl);
					}
				});
			});

		const outputSummarySetting = new Setting(containerEl)
			.setName('Output summary')
			.setDesc(
				'Shows the exact format, compression type, and bitrate used for recording.',
			);
		summaryEl = outputSummarySetting.descEl.createDiv();
		updateOutputSummary(summaryEl);

		new Setting(containerEl)
			.setName('Sample rate')
			.setDesc(
				'Select the audio sample rate in hertz. 44.1 kHz or 48 kHz are recommended for voice and general recording.',
			)
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
			.setName('Input device')
			.setDesc(
				'Select the default input device for single-track recordings. You can also change it from the command palette.',
			)
			.addDropdown((dropdown) => {
				this.deviceDropdowns.push(dropdown);
				void this.populateAudioDevices(dropdown).then(() => {
					dropdown.setValue(this.plugin.settings.audioDeviceId || '');
				});
				dropdown.onChange(async (value) => {
					this.plugin.settings.audioDeviceId = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Save folder')
			.setDesc(
				'Specify where recordings are saved in your vault. Existing folders are suggested as you type.',
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

		new Setting(containerEl)
			.setName('Save recordings near active file')
			.setDesc(
				'Save recordings in the same directory as the currently active Markdown file. This mode has priority over save folder.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.saveNearActiveFile)
					.onChange(async (value) => {
						this.plugin.settings.saveNearActiveFile = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.saveNearActiveFile) {
			new Setting(containerEl)
				.setName('Active file subfolder')
				.setDesc(
					'Optional subfolder relative to the active file directory (for example: audio). Created automatically if missing.',
				)
				.addText((text) =>
					text
						.setPlaceholder('Audio')
						.setValue(this.plugin.settings.activeFileSubfolder)
						.onChange(async (value) => {
							this.plugin.settings.activeFileSubfolder = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('Documentation')
			.setDesc(
				'Use the start/stop recording command to control recording state, the pause/resume recording command to temporarily halt capture, and the select audio input device command for quick device switching. Long sessions are supported; choose compressed formats such as webm or ogg to reduce disk usage.',
			)
			.setHeading();

		new Setting(containerEl).setName('File naming').setHeading();

		new Setting(containerEl)
			.setName('File prefix')
			.setDesc('Set the filename prefix used for exported recordings.')
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
			.setDesc(
				'Enable verbose logs for troubleshooting recording issues.',
			)
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
			.setDesc(
				'Enable recording from multiple input devices at the same time.',
			)
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
				.setDesc(
					'Set the number of simultaneous tracks (1-8). Use only what you need to keep configuration simple.',
				)
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
					'Choose whether multi-track output is exported as one combined file or one file per track.',
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
						`Select the input device assigned to track ${String(i)}`,
					)
					.addDropdown((dropdown) => {
						this.deviceDropdowns.push(dropdown);
						void this.populateAudioDevices(dropdown).then(() => {
							dropdown.setValue(
								this.plugin.settings.trackAudioSources.get(i)
									?.deviceId || '',
							);
						});
						dropdown.onChange(async (value) => {
							if (value) {
								this.plugin.settings.trackAudioSources.set(i, {
									deviceId: value,
								});
							} else {
								this.plugin.settings.trackAudioSources.delete(
									i,
								);
							}
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
		dropdown.selectEl.empty();
		dropdown.addOption('', 'Select device');
		const devices = await this.getAudioInputDevices();
		devices.forEach((device) => {
			const label =
				device.label ||
				`Audio device ${device.deviceId.substring(0, 8)}`;
			dropdown.addOption(device.deviceId, label);
		});
	}

	private async refreshDeviceList(): Promise<void> {
		const refreshes = this.deviceDropdowns.map(async (dropdown) => {
			const selectedValue = dropdown.getValue();
			await this.populateAudioDevices(dropdown);
			const hasOption = Array.from(dropdown.selectEl.options).some(
				(option) => option.value === selectedValue,
			);
			dropdown.setValue(hasOption ? selectedValue : '');
		});
		await Promise.all(refreshes);
	}
}
