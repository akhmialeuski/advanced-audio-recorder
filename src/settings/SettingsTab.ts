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
import {
	detectSupportedFormats,
	getSupportedSampleRates,
	buildMimeType,
} from '../recording/AudioCapabilityDetector';
import { SystemDiagnostics } from '../diagnostics/SystemDiagnostics';
import { SystemInfoModal } from '../diagnostics/SystemInfoModal';

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
	private testRecordingPath: string | null = null;
	private testRecorder: MediaRecorder | null = null;
	private testChunks: Blob[] = [];
	private testAudioElement: HTMLAudioElement | null = null;

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
	 * Gets supported audio formats using runtime detection.
	 */
	getSupportedFormats(): string[] {
		return detectSupportedFormats();
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

		// ── Audio input ──────────────────────────────────────────────
		new Setting(containerEl).setName('Audio input').setHeading();

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
			.setName('Sample rate')
			.setDesc(
				'Audio sample rate in hertz. For voice and general recording, 44.1 kHz or 48 kHz are recommended.',
			)
			.addDropdown((dropdown) => {
				const sampleRates = getSupportedSampleRates();
				sampleRates.forEach((rate) => {
					dropdown.addOption(String(rate), String(rate));
				});
				dropdown.setValue(String(this.plugin.settings.sampleRate));
				dropdown.onChange(async (value) => {
					this.plugin.settings.sampleRate = parseInt(value, 10);
					await this.plugin.saveSettings();
				});
			});

		// ── Output format ───────────────────────────────────────────
		new Setting(containerEl).setName('Output format').setHeading();

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

		// ── File storage ──────────────────────────────────────────
		new Setting(containerEl).setName('File storage').setHeading();

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

		// ── Multi-track recording ─────────────────────────────────
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

		// ── Diagnostics ────────────────────────────────────────────
		new Setting(containerEl).setName('Diagnostics').setHeading();

		const testContainer = containerEl.createDiv();
		new Setting(testContainer)
			.setName('Test recording')
			.setDesc(
				'Records a 5-second test clip using your current settings and plays it back. The test file is automatically deleted when you leave settings.',
			)
			.addButton((button) =>
				button.setButtonText('Start test').onClick(() => {
					void this.runTestRecording(testContainer);
				}),
			);

		new Setting(containerEl)
			.setName('System info')
			.setDesc(
				'Show full system diagnostics including plugin settings, audio devices, and browser capabilities.',
			)
			.addButton((button) =>
				button.setButtonText('Show info').onClick(() => {
					void SystemDiagnostics.collect(
						this.plugin.settings,
						this.app,
					).then((data) => {
						new SystemInfoModal(this.app, data).open();
					});
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

	/**
	 * Runs a short test recording and plays back the result.
	 * @param container - DOM element to append playback controls to
	 */
	private async runTestRecording(container: HTMLElement): Promise<void> {
		try {
			await this.cleanupTestRecording();

			const format = this.plugin.settings.recordingFormat;
			const recorderFormat = format === 'wav' ? 'webm' : format;
			const mimeType = buildMimeType(recorderFormat);

			if (!MediaRecorder.isTypeSupported(mimeType)) {
				this.showTestStatus(
					container,
					`Format "${format}" is not supported in this browser.`,
					true,
				);
				return;
			}

			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: this.plugin.settings.audioDeviceId
						? { exact: this.plugin.settings.audioDeviceId }
						: undefined,
					sampleRate: this.plugin.settings.sampleRate,
				},
			});

			this.testChunks = [];
			this.testRecorder = new MediaRecorder(stream, {
				mimeType,
				audioBitsPerSecond: this.plugin.settings.bitrate,
			});

			this.testRecorder.ondataavailable = (event: BlobEvent): void => {
				if (event.data.size > 0) {
					this.testChunks.push(event.data);
				}
			};

			this.showTestStatus(
				container,
				'\u25CF Recording... (5 seconds)',
				false,
				'aar-test-recording',
			);

			const recordingPromise = new Promise<void>((resolve) => {
				if (this.testRecorder) {
					this.testRecorder.addEventListener(
						'stop',
						() => resolve(),
						{ once: true },
					);
				}
			});

			this.testRecorder.start();

			await new Promise<void>((resolve) => setTimeout(resolve, 5000));

			if (this.testRecorder.state !== 'inactive') {
				this.testRecorder.stop();
			}
			for (const track of stream.getTracks()) {
				track.stop();
			}

			await recordingPromise;

			if (this.testChunks.length === 0) {
				this.showTestStatus(
					container,
					'Test recording produced no data. Try a different format or device.',
					true,
				);
				return;
			}

			const blob = new Blob(this.testChunks, {
				type: `audio/${recorderFormat}`,
			});
			const url = URL.createObjectURL(blob);

			this.showTestStatus(
				container,
				'\u2714 Test recording complete. Listen below:',
				false,
				'aar-test-success',
			);

			this.testAudioElement = container.createEl('audio', {
				attr: { controls: 'true', src: url },
			});
			this.testAudioElement.addClass('aar-test-audio');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			this.showTestStatus(
				container,
				`Test recording failed: ${message}`,
				true,
			);
		}
	}

	/**
	 * Displays test status message in the container.
	 */
	private showTestStatus(
		container: HTMLElement,
		message: string,
		isError: boolean,
		extraClass?: string,
	): void {
		const existingStatus = container.querySelector('.aar-test-status');
		if (existingStatus) {
			existingStatus.remove();
		}
		const existingAudio = container.querySelector('.aar-test-audio');
		if (existingAudio) {
			existingAudio.remove();
		}

		const statusEl = container.createDiv({ cls: 'aar-test-status' });
		statusEl.setText(message);
		if (isError) {
			statusEl.addClass('aar-test-error');
		}
		if (extraClass) {
			statusEl.addClass(extraClass);
		}
	}

	/**
	 * Removes test recording resources.
	 */
	private async cleanupTestRecording(): Promise<void> {
		if (this.testRecorder && this.testRecorder.state !== 'inactive') {
			this.testRecorder.stop();
		}
		this.testRecorder = null;
		this.testChunks = [];

		if (this.testAudioElement) {
			const src = this.testAudioElement.src;
			if (src.startsWith('blob:')) {
				URL.revokeObjectURL(src);
			}
			this.testAudioElement.remove();
			this.testAudioElement = null;
		}

		if (this.testRecordingPath) {
			try {
				await this.app.vault.adapter.remove(this.testRecordingPath);
			} catch {
				// File may already be deleted
			}
			this.testRecordingPath = null;
		}
	}

	/**
	 * Cleans up test recording resources when settings tab is hidden.
	 */
	hide(): void {
		void this.cleanupTestRecording();
	}
}
