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
	debounce,
} from 'obsidian';
import type { Plugin } from 'obsidian';
import type {
	AudioRecorderSettings,
	OutputMode,
	ConversionLinkAction,
} from './Settings';
import {
	detectSupportedFormats,
	getSupportedSampleRates,
	buildMimeType,
} from '../recording/AudioCapabilityDetector';
import {
	getEncoderDescription,
	isOfflineEncodingSupported,
} from '../recording/AudioEncoder';
import {
	DEFAULT_SPLIT_PART_SUFFIX,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	SPLIT_PART_SUFFIX_PATTERN,
	MIN_PLAYER_WAVEFORM_HEIGHT,
	MAX_PLAYER_WAVEFORM_HEIGHT,
	MIN_PLAYER_WAVEFORM_MAX_FILE_MB,
	MAX_PLAYER_WAVEFORM_MAX_FILE_MB,
	MIN_PLAYER_SKIP_SECONDS,
	MAX_PLAYER_SKIP_SECONDS,
	PLAYER_PLAYBACK_RATE_PRESETS,
} from '../constants';
import { SystemDiagnostics } from '../diagnostics/SystemDiagnostics';
import { SystemInfoModal } from '../diagnostics/SystemInfoModal';

/** Debounce delay for saving text settings, in milliseconds. */
const TEXT_SETTING_SAVE_DEBOUNCE_MS = 500;

/** Duration of the diagnostics test recording, in milliseconds. */
const TEST_RECORDING_DURATION_MS = 5000;

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
	private testRecorder: MediaRecorder | null = null;
	private testChunks: Blob[] = [];
	private testAudioElement: HTMLAudioElement | null = null;
	/**
	 * Device-change listener active while the settings tab is open.
	 * Registered via addEventListener so other consumers of the event
	 * are not overwritten, and removed in hide() so the handler cannot
	 * outlive the tab (or the plugin).
	 */
	private deviceChangeHandler: (() => void) | null = null;
	/**
	 * Debounced settings save shared by the text fields, which fire
	 * onChange on every keystroke and would otherwise rewrite data.json
	 * per character. Toggles, dropdowns, and sliders save directly.
	 */
	private readonly saveTextSettingDebounced = debounce(
		() => {
			void this.plugin.saveSettings();
		},
		TEXT_SETTING_SAVE_DEBOUNCE_MS,
		true,
	);

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
		const encoder = getEncoderDescription(format);
		if (format === 'wav') {
			return `Uncompressed WAV (larger size). Encoder: ${encoder}.`;
		}
		if (
			isOfflineEncodingSupported(format) &&
			!this.isMediaRecorderFormat(format)
		) {
			return `Compressed audio via offline encoding. Encoder: ${encoder}.`;
		}
		return `Compressed audio (smaller size; saved directly from recorder output). Encoder: ${encoder}.`;
	}

	private isMediaRecorderFormat(format: string): boolean {
		if (typeof MediaRecorder === 'undefined') {
			return false;
		}
		return MediaRecorder.isTypeSupported(buildMimeType(format));
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
		if (!this.deviceChangeHandler) {
			this.deviceChangeHandler = (): void => {
				void this.refreshDeviceList();
			};
			navigator.mediaDevices.addEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
		}

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
			.setDesc('Audio sample rate in hertz.')
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
					const label = this.isMediaRecorderFormat(format)
						? format.toUpperCase()
						: `${format.toUpperCase()} (offline)`;
					dropdown.addOption(format, label);
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
			.setName('Delete source after conversion')
			.setDesc(
				'When converting audio via the context menu, delete the original file after a successful conversion.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deleteSourceAfterConversion)
					.onChange(async (value) => {
						this.plugin.settings.deleteSourceAfterConversion =
							value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Update links after conversion')
			.setDesc(
				'How to handle links to the source file in notes after conversion.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('none', 'Do nothing');
				dropdown.addOption('replace', 'Replace source link');
				dropdown.addOption('after', 'Insert after source link');
				dropdown.setValue(this.plugin.settings.conversionLinkAction);
				dropdown.onChange(async (value) => {
					this.plugin.settings.conversionLinkAction =
						value as ConversionLinkAction;
					await this.plugin.saveSettings();
				});
			});

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
				const datalist = text.inputEl.createEl('datalist', {
					attr: { id: 'folder-options' },
				});
				folderOptions.forEach((folder) => {
					datalist.createEl('option', { attr: { value: folder } });
				});
				text.setValue(this.plugin.settings.saveFolder);
				text.onChange((value) => {
					this.plugin.settings.saveFolder = value;
					this.saveTextSettingDebounced();
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
						.onChange((value) => {
							this.plugin.settings.activeFileSubfolder = value;
							this.saveTextSettingDebounced();
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
					.onChange((value) => {
						this.plugin.settings.filePrefix = value;
						this.saveTextSettingDebounced();
					}),
			);

		new Setting(containerEl)
			.setName('Insert at original position')
			.setDesc(
				'When enabled, the plugin remembers the note and cursor position where recording started. The audio link is inserted at that location, even if you navigate away during recording. Note: if the original note is edited during recording, the insertion position may shift.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.insertAtOriginalPosition)
					.onChange(async (value) => {
						this.plugin.settings.insertAtOriginalPosition = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Audio splitting ───────────────────────────────────────
		new Setting(containerEl).setName('Audio splitting').setHeading();

		new Setting(containerEl)
			.setName('Split recordings automatically')
			.setDesc(
				'Save the recording as separate part files of fixed duration instead of one long file. Desktop only; not applied to merged multi-track recordings.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSplitEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSplitEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Part duration')
			.setDesc(
				'Length of each part in minutes. Also used as the default for manual splitting from the context menu.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(
						MIN_SPLIT_CHUNK_MINUTES,
						MAX_SPLIT_CHUNK_MINUTES,
						1,
					)
					.setValue(this.plugin.settings.splitChunkMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.splitChunkMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Part name suffix')
			.setDesc(
				'Appended with the part number to part file names, e.g. "recording-part1.webm". Letters, digits, hyphens, and underscores only.',
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SPLIT_PART_SUFFIX)
					.setValue(this.plugin.settings.splitPartSuffix)
					.onChange((value) => {
						// Mirror the manual split dialog: surrounding
						// whitespace is ignored and an empty field means
						// the default suffix. Only valid suffixes are
						// persisted; the red border tells the user the
						// last valid value is still in effect
						const trimmed = value.trim();
						const valid =
							trimmed === '' ||
							SPLIT_PART_SUFFIX_PATTERN.test(trimmed);
						text.inputEl.toggleClass('aar-input-invalid', !valid);
						if (!valid) {
							return;
						}
						this.plugin.settings.splitPartSuffix =
							trimmed === ''
								? DEFAULT_SPLIT_PART_SUFFIX
								: trimmed;
						this.saveTextSettingDebounced();
					}),
			);

		new Setting(containerEl)
			.setName('Delete source after split')
			.setDesc(
				'Default state of the delete source file option in the manual split dialog.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deleteSourceAfterSplit)
					.onChange(async (value) => {
						this.plugin.settings.deleteSourceAfterSplit = value;
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

		// ── Audio player ───────────────────────────────────────────
		this.renderAudioPlayerSettings(containerEl);

		// ── Diagnostics ────────────────────────────────────────────
		new Setting(containerEl).setName('Diagnostics').setHeading();

		const testContainer = containerEl.createDiv();
		new Setting(testContainer)
			.setName('Test recording')
			.setDesc(
				'Records a 5-second test clip using your current settings and plays it back. Nothing is saved to your vault.',
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
	 * Renders the enhanced audio player settings. The master toggle is
	 * always shown; the detailed controls appear only while the player
	 * is enabled, and toggling it re-renders the tab so they show or
	 * hide immediately.
	 * @param containerEl - The settings container element
	 */
	private renderAudioPlayerSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Audio player').setHeading();

		new Setting(containerEl)
			.setName('Enhanced audio player')
			.setDesc(
				'Replace the built-in audio embed with a richer player (waveform, speed, skip, volume, loop, timecode links). Applies to notes rendered after the change.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enhancedPlayerEnabled)
					.onChange(async (value) => {
						this.plugin.settings.enhancedPlayerEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (!this.plugin.settings.enhancedPlayerEnabled) {
			return;
		}

		new Setting(containerEl)
			.setName('Show waveform')
			.setDesc(
				'Draw a waveform behind the seek bar. Disable to show a plain progress bar (no decoding required).',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowWaveform)
					.onChange(async (value) => {
						this.plugin.settings.playerShowWaveform = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.playerShowWaveform) {
			new Setting(containerEl)
				.setName('Waveform height')
				.setDesc('Height of the waveform in pixels.')
				.addSlider((slider) =>
					slider
						.setLimits(
							MIN_PLAYER_WAVEFORM_HEIGHT,
							MAX_PLAYER_WAVEFORM_HEIGHT,
							2,
						)
						.setValue(this.plugin.settings.playerWaveformHeight)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.playerWaveformHeight = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName('Waveform file size limit')
				.setDesc(
					'Files larger than this size in megabytes skip the waveform and show a plain seek bar, because drawing a waveform decodes the whole file into memory.',
				)
				.addSlider((slider) =>
					slider
						.setLimits(
							MIN_PLAYER_WAVEFORM_MAX_FILE_MB,
							MAX_PLAYER_WAVEFORM_MAX_FILE_MB,
							1,
						)
						.setValue(
							this.plugin.settings.playerWaveformMaxFileSizeMb,
						)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.playerWaveformMaxFileSizeMb =
								value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('Show speed control')
			.setDesc('Show a playback-speed button on the player.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowSpeedControl)
					.onChange(async (value) => {
						this.plugin.settings.playerShowSpeedControl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default playback speed')
			.setDesc('Speed applied to players when a note opens.')
			.addDropdown((dropdown) => {
				PLAYER_PLAYBACK_RATE_PRESETS.forEach((rate) => {
					dropdown.addOption(String(rate), `${String(rate)}x`);
				});
				dropdown.setValue(
					String(this.plugin.settings.playerDefaultPlaybackRate),
				);
				dropdown.onChange(async (value) => {
					this.plugin.settings.playerDefaultPlaybackRate =
						Number(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Show skip buttons')
			.setDesc('Show skip-forward and skip-back buttons.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowSkipButtons)
					.onChange(async (value) => {
						this.plugin.settings.playerShowSkipButtons = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.playerShowSkipButtons) {
			new Setting(containerEl)
				.setName('Skip amount')
				.setDesc('Seconds skipped by the skip buttons.')
				.addSlider((slider) =>
					slider
						.setLimits(
							MIN_PLAYER_SKIP_SECONDS,
							MAX_PLAYER_SKIP_SECONDS,
							1,
						)
						.setValue(this.plugin.settings.playerSkipSeconds)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.playerSkipSeconds = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('Show volume control')
			.setDesc('Show a volume slider on the player.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowVolumeControl)
					.onChange(async (value) => {
						this.plugin.settings.playerShowVolumeControl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show time display')
			.setDesc('Show elapsed and total time on the player.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowTimeDisplay)
					.onChange(async (value) => {
						this.plugin.settings.playerShowTimeDisplay = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Loop by default')
			.setDesc('Start new players with looping enabled.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerDefaultLoop)
					.onChange(async (value) => {
						this.plugin.settings.playerDefaultLoop = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Timecode links')
			.setDesc(
				'Enable links with a #t= offset (e.g. [[recording#t=1:30]]) to jump a player to that position, and the "copy timestamp link" button on the player.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerEnableTimestampLinks)
					.onChange(async (value) => {
						this.plugin.settings.playerEnableTimestampLinks = value;
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
	 * Runs a short test recording and plays back the result. The
	 * microphone stream is released in a finally block so an error in
	 * recorder setup (or the tab being hidden during the wait) can
	 * never leave the device captured.
	 * @param container - DOM element to append playback controls to
	 */
	private async runTestRecording(container: HTMLElement): Promise<void> {
		let stream: MediaStream | null = null;
		try {
			this.cleanupTestRecording();

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

			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					deviceId: this.plugin.settings.audioDeviceId
						? { exact: this.plugin.settings.audioDeviceId }
						: undefined,
					sampleRate: this.plugin.settings.sampleRate,
				},
			});

			this.testChunks = [];
			// Local reference: hide() may run cleanupTestRecording (which
			// nulls this.testRecorder) at any await point below
			const recorder = new MediaRecorder(stream, {
				mimeType,
				audioBitsPerSecond: this.plugin.settings.bitrate,
			});
			this.testRecorder = recorder;

			recorder.ondataavailable = (event: BlobEvent): void => {
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
				recorder.addEventListener('stop', () => resolve(), {
					once: true,
				});
			});

			recorder.start();

			await new Promise<void>((resolve) =>
				window.setTimeout(resolve, TEST_RECORDING_DURATION_MS),
			);

			if (recorder.state !== 'inactive') {
				recorder.stop();
			}
			await recordingPromise;

			if (this.testRecorder !== recorder) {
				// The tab was hidden during the wait: cleanup already
				// discarded the recorder and the result has nowhere to go
				return;
			}

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
		} finally {
			if (stream) {
				for (const track of stream.getTracks()) {
					track.stop();
				}
			}
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
	private cleanupTestRecording(): void {
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
	}

	/**
	 * Cleans up test recording resources when settings tab is hidden,
	 * flushes a pending debounced text-setting save, and detaches the
	 * device-change listener registered in display().
	 */
	hide(): void {
		this.saveTextSettingDebounced.run();
		this.cleanupTestRecording();
		if (this.deviceChangeHandler) {
			navigator.mediaDevices.removeEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
			this.deviceChangeHandler = null;
		}
	}
}
