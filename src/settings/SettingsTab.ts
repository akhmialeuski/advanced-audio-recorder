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
	setIcon,
} from 'obsidian';
import type { Plugin } from 'obsidian';
import type {
	AudioRecorderSettings,
	OutputMode,
	ConversionLinkAction,
} from './settingsSchema';
import {
	getSupportedSampleRates,
	buildMimeType,
	listFormatAvailability,
} from '../audio/AudioCapabilityDetector';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import {
	CHANNEL_MODES,
	CHANNEL_MODE_SOURCE,
	normalizeChannelMode,
	type ChannelMode,
} from '../audio/downmix';
import {
	channelSelectionAvailable,
	getAudioInputDeviceSnapshot,
	type AudioInputDeviceSnapshot,
} from '../recording/AudioStreamHandler';
import { getEncoderDescription } from '../ui/formatDescriptions';
import { TestRecorder } from '../recording/TestRecorder';
import { FolderSuggest } from './FolderSuggest';
import {
	DEFAULT_SPLIT_PART_SUFFIX,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	SPLIT_PART_SUFFIX_PATTERN,
	MIN_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	CLEANUP_HIGHPASS_STEP_HZ,
	CLEANUP_GATE_STEP_DB,
	CLEANUP_LEVELING_STEP_DB,
	DOCS_URL,
	FORMAT_WAV,
} from '../constants';
import { SystemDiagnostics } from '../diagnostics/SystemDiagnostics';
import { SystemInfoModal } from '../diagnostics/SystemInfoModal';
import { renderTranscriptionSection } from './sections/transcriptionSettingsSection';
import { SETTING_DISABLED_CLASS } from './settingControls';
import {
	isAutoSplitSupported,
	isChannelModeSelectionSupported,
	isDeviceSelectionSupported,
	isMultiTrackCaptureSupported,
	isSampleRateSelectionSupported,
} from '../platform/capabilities';

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

interface DeviceDropdownBinding {
	readonly dropdown: DropdownComponent;
	readonly getSelectedDeviceId: () => string;
}

const EMPTY_DEVICE_SNAPSHOT: AudioInputDeviceSnapshot = {
	enumerationSucceeded: false,
	devices: [],
	channelLimits: new Map(),
};

/**
 * Settings tab for the Audio Recorder plugin.
 */
export class AudioRecorderSettingTab extends PluginSettingTab {
	plugin: AudioRecorderPluginInterface;
	private deviceDropdowns: DeviceDropdownBinding[] = [];
	private readonly bitrateOptionsKbps = [64, 96, 128, 160, 192, 256, 320];
	private readonly testRecorder = new TestRecorder();
	private testAudioElement: HTMLAudioElement | null = null;
	/**
	 * Device-change listener active while the settings tab is open.
	 * Registered via addEventListener so other consumers of the event
	 * are not overwritten, and removed in hide() so the handler cannot
	 * outlive the tab (or the plugin).
	 */
	private deviceChangeHandler: (() => void) | null = null;
	/**
	 * Maximum capture channels per device id (null = unknown), read
	 * from device capabilities without opening the microphone. Channel
	 * selectors consult this to grey themselves out for devices that
	 * positively report a single channel.
	 */
	private deviceSnapshot: AudioInputDeviceSnapshot = EMPTY_DEVICE_SNAPSHOT;
	/** Latest device refresh generation; older async results are discarded. */
	private deviceRefreshGeneration = 0;
	/** Prevents a refresh from updating controls after the tab is hidden. */
	private isDisplayed = false;
	/**
	 * Re-evaluators for every channel-mode dropdown on the tab. Run
	 * after the capability map loads, after a device selection changes,
	 * and on devicechange events.
	 */
	private channelDropdownUpdaters: (() => void)[] = [];
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

	private getCompressionDescription(format: string): string {
		const encoder = getEncoderDescription(format);
		if (format === FORMAT_WAV) {
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
		this.isDisplayed = true;
		containerEl.empty();
		this.deviceDropdowns = [];
		this.channelDropdownUpdaters = [];
		this.deviceSnapshot = EMPTY_DEVICE_SNAPSHOT;
		if (!this.deviceChangeHandler) {
			this.deviceChangeHandler = (): void => {
				void this.refreshDeviceList();
			};
			navigator.mediaDevices.addEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
		}

		// Quick access to the full documentation, so users do not have to
		// hunt through the GitHub repository for the guides.
		this.renderDocumentationLink(containerEl);

		// Audio input
		new Setting(containerEl).setName('Audio input').setHeading();

		const deviceSelectable = isDeviceSelectionSupported();
		const deviceSetting = new Setting(containerEl)
			.setName('Input device')
			.setDesc(
				deviceSelectable
					? 'Select the default input device for single-track recordings. You can also change it from the command palette.'
					: 'Not selectable on this device; recording uses the system default microphone.',
			)
			.addDropdown((dropdown) => {
				if (!deviceSelectable) {
					dropdown.setDisabled(true);
					return;
				}
				this.deviceDropdowns.push({
					dropdown,
					getSelectedDeviceId: () =>
						this.plugin.settings.audioDeviceId || '',
				});
				dropdown.onChange(async (value) => {
					this.plugin.settings.audioDeviceId = value;
					await this.plugin.saveSettings();
					// The channel selector is bound to this device
					this.runChannelDropdownUpdaters();
				});
			});
		if (!deviceSelectable) {
			deviceSetting.settingEl.addClass(SETTING_DISABLED_CLASS);
		}

		const sampleRateSelectable = isSampleRateSelectionSupported();
		const sampleRateSetting = new Setting(containerEl)
			.setName('Sample rate')
			.setDesc(
				sampleRateSelectable
					? 'Audio sample rate in hertz.'
					: 'Not selectable on this device; the system capture rate is used.',
			)
			.addDropdown((dropdown) => {
				const sampleRates = getSupportedSampleRates();
				sampleRates.forEach((rate) => {
					dropdown.addOption(String(rate), String(rate));
				});
				dropdown.setValue(String(this.plugin.settings.sampleRate));
				if (!sampleRateSelectable) {
					dropdown.setDisabled(true);
					return;
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.sampleRate = parseInt(value, 10);
					await this.plugin.saveSettings();
				});
			});
		if (!sampleRateSelectable) {
			sampleRateSetting.settingEl.addClass(SETTING_DISABLED_CLASS);
		}

		new Setting(containerEl)
			.setName('Recording channels')
			.setDesc(
				'Channel layout for single-track recordings: keep the device layout, or reduce to mono during capture. The left/right channel options suit audio interfaces whose two mono inputs show up as one stereo device: a single microphone is kept at full level instead of being mixed with a silent channel. Disabled when the selected device reports a mono-only input. Multi-track sessions use the per-track selectors below instead.',
			)
			.addDropdown((dropdown) => {
				this.bindChannelModeDropdown(dropdown, {
					getDeviceId: () => this.plugin.settings.audioDeviceId,
					// An empty id means the platform default device,
					// whose capability is not knowable here: keep enabled
					hasDevice: () => true,
					getMode: () => this.plugin.settings.recordingChannels,
					setMode: async (mode) => {
						this.plugin.settings.recordingChannels = mode;
						await this.plugin.saveSettings();
					},
				});
			});

		// Output format
		new Setting(containerEl).setName('Output format').setHeading();

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
				'Select the final file format. The selected format is applied when files are saved. Formats this device cannot record are shown blocked.',
			)
			.addDropdown((dropdown) => {
				const entries = listFormatAvailability();
				for (const entry of entries) {
					const label = !entry.available
						? `${entry.format.toUpperCase()} (not supported on this device)`
						: entry.direct
							? entry.format.toUpperCase()
							: `${entry.format.toUpperCase()} (offline)`;
					dropdown.addOption(entry.format, label);
				}
				// A stored format outside the registry (hand-edited or from a
				// future version) still needs an option so setValue holds it.
				const stored = this.plugin.settings.recordingFormat;
				if (!entries.some((entry) => entry.format === stored)) {
					dropdown.addOption(stored, stored.toUpperCase());
				}
				// Block the formats this device cannot record: they stay
				// visible (so the full format list reads the same on every
				// platform) but cannot be selected.
				for (const option of Array.from(dropdown.selectEl.options)) {
					const entry = entries.find(
						(candidate) => candidate.format === option.value,
					);
					option.disabled = entry ? !entry.available : false;
				}
				dropdown.setValue(stored);
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

		// File storage
		new Setting(containerEl).setName('File storage').setHeading();

		new Setting(containerEl)
			.setName('Save folder')
			.setDesc(
				'Specify where recordings are saved in your vault. Existing folders are suggested as you type.',
			)
			.addText((text) => {
				new FolderSuggest(this.app, text.inputEl, () =>
					this.getFolderOptions(),
				);
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
				'When enabled, the plugin remembers the note and insertion position where recording started. The audio link is inserted at that location, even if you navigate away during recording. Note: if the original note is edited during recording, the insertion position may shift.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.insertAtOriginalPosition)
					.onChange(async (value) => {
						this.plugin.settings.insertAtOriginalPosition = value;
						await this.plugin.saveSettings();
					}),
			);

		// Audio splitting
		new Setting(containerEl).setName('Audio splitting').setHeading();

		const autoSplitAvailable = isAutoSplitSupported();
		const autoSplitSetting = new Setting(containerEl)
			.setName('Split recordings automatically')
			.setDesc(
				autoSplitAvailable
					? 'Save the recording as separate part files of fixed duration instead of one long file. Not applied to merged multi-track recordings.'
					: 'Not available on this device. Recordings are saved as one file; manual splitting from the context menu still works.',
			)
			.addToggle((toggle) => {
				// Reflect the effective state: a stored "on" synced from
				// another platform reads as off where auto-split cannot run.
				toggle
					.setValue(
						this.plugin.settings.autoSplitEnabled &&
							autoSplitAvailable,
					)
					.onChange(async (value) => {
						this.plugin.settings.autoSplitEnabled = value;
						await this.plugin.saveSettings();
					});
				if (!autoSplitAvailable) {
					toggle.setDisabled(true);
				}
			});
		if (!autoSplitAvailable) {
			autoSplitSetting.settingEl.addClass(SETTING_DISABLED_CLASS);
		}

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

		// Multi-track recording
		new Setting(containerEl).setName('Multi-track recording').setHeading();

		const multiTrackAvailable = isMultiTrackCaptureSupported();
		const multiTrackSetting = new Setting(containerEl)
			.setName('Enable multi-track recording')
			.setDesc(
				multiTrackAvailable
					? 'Enable recording from multiple input devices at the same time.'
					: 'Not available on this device. Recording captures a single track from the default microphone.',
			)
			.addToggle((toggle) => {
				// Reflect the effective state: a stored "on" synced from
				// another platform reads as off where multi-track capture
				// is unavailable, and the toggle cannot be switched on.
				toggle
					.setValue(
						this.plugin.settings.enableMultiTrack &&
							multiTrackAvailable,
					)
					.onChange(async (value) => {
						this.plugin.settings.enableMultiTrack = value;
						await this.plugin.saveSettings();
						this.display();
					});
				if (!multiTrackAvailable) {
					toggle.setDisabled(true);
				}
			});
		if (!multiTrackAvailable) {
			multiTrackSetting.settingEl.addClass(SETTING_DISABLED_CLASS);
		}

		if (this.plugin.settings.enableMultiTrack && multiTrackAvailable) {
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
						this.deviceDropdowns.push({
							dropdown,
							getSelectedDeviceId: () =>
								this.plugin.settings.trackAudioSources.get(i)
									?.deviceId || '',
						});
						dropdown.onChange(async (value) => {
							if (value) {
								// Keep the track's channel mode across a
								// device swap. Capability observation only
								// disables the selector; it never rewrites
								// the user's persistent choice.
								this.plugin.settings.trackAudioSources.set(i, {
									deviceId: value,
									channelMode:
										this.plugin.settings.trackAudioSources.get(
											i,
										)?.channelMode ?? CHANNEL_MODE_SOURCE,
								});
							} else {
								this.plugin.settings.trackAudioSources.delete(
									i,
								);
							}
							await this.plugin.saveSettings();
							// The track's channel selector is bound to
							// this device
							this.runChannelDropdownUpdaters();
						});
					});

				new Setting(containerEl)
					.setName(`Channels for track ${String(i)}`)
					.setDesc(
						`Channel layout for track ${String(i)}: keep the device layout, or reduce this track to mono during capture. Disabled when the track has no device or its device reports a mono-only input.`,
					)
					.addDropdown((dropdown) => {
						this.bindChannelModeDropdown(dropdown, {
							getDeviceId: () =>
								this.plugin.settings.trackAudioSources.get(i)
									?.deviceId ?? '',
							hasDevice: () =>
								Boolean(
									this.plugin.settings.trackAudioSources.get(
										i,
									)?.deviceId,
								),
							getMode: () =>
								this.plugin.settings.trackAudioSources.get(i)
									?.channelMode ?? CHANNEL_MODE_SOURCE,
							setMode: async (mode) => {
								const source =
									this.plugin.settings.trackAudioSources.get(
										i,
									);
								if (!source) {
									// No device selected: nothing to bind
									// the mode to
									return;
								}
								this.plugin.settings.trackAudioSources.set(i, {
									...source,
									channelMode: mode,
								});
								await this.plugin.saveSettings();
							},
						});
					});
			}
		}

		// Audio player
		this.renderAudioPlayerSettings(containerEl);

		// Transcription
		renderTranscriptionSection({
			containerEl,
			settings: this.plugin.settings,
			save: () => this.plugin.saveSettings(),
			rerender: () => {
				this.display();
			},
			saveDebounced: () => {
				this.saveTextSettingDebounced();
			},
		});

		// Audio processing & feedback
		this.renderInputProcessingSettings(containerEl);

		// Diagnostics
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

		// Populate every device dropdown and capability lookup from one
		// coherent enumeration after all bindings have been registered.
		void this.refreshDeviceList();
	}

	/**
	 * Renders a compact callout at the top of the settings tab linking to the
	 * full online documentation, so the per-feature guides and use-case
	 * walkthroughs are one click away instead of requiring the user to find
	 * them in the GitHub repository.
	 * @param containerEl - The settings container element
	 */
	private renderDocumentationLink(containerEl: HTMLElement): void {
		const callout = containerEl.createDiv({ cls: 'aar-doc-callout' });
		const icon = callout.createSpan({ cls: 'aar-doc-callout-icon' });
		setIcon(icon, 'book-open');

		const body = callout.createDiv({ cls: 'aar-doc-callout-body' });
		body.createSpan({
			text:
				'New here or stuck on a setting? The full guides, setup ' +
				'walkthroughs, and use cases live in the docs. ',
		});
		const link = body.createEl('a', {
			text: 'Open the documentation',
			cls: 'aar-doc-callout-link',
			attr: {
				href: DOCS_URL,
				target: '_blank',
				rel: 'noopener',
			},
		});
		link.setAttribute(
			'aria-label',
			'Open the documentation in your browser',
		);
	}

	/**
	 * Renders the enhanced audio player settings: the master toggle plus the
	 * two window toggles (waveform, markers/chapters). The control buttons
	 * (speed, skip, volume, time, mute, loop, timecode links) are fixed.
	 * @param containerEl - The settings container element
	 */
	private renderAudioPlayerSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Audio player').setHeading();

		new Setting(containerEl)
			.setName('Enhanced audio player')
			.setDesc(
				'Replace the built-in audio embed with a richer player (waveform, speed, skip, volume, loop, timecode links, markers and chapters). Video files keep the built-in player.',
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
			.setDesc('Draw a waveform behind the seek bar.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerShowWaveform)
					.onChange(async (value) => {
						this.plugin.settings.playerShowWaveform = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Markers and chapters')
			.setDesc(
				'Show the markers and chapters list below the player. Markers are stored next to the recording, not in your vault.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.playerEnableMarkers)
					.onChange(async (value) => {
						this.plugin.settings.playerEnableMarkers = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * Renders the audio input-processing constraints and the live
	 * recording-feedback options.
	 * @param containerEl - The settings container element
	 */
	private renderInputProcessingSettings(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName('Audio processing & feedback')
			.setHeading();

		new Setting(containerEl)
			.setName('Noise suppression')
			.setDesc('Apply the browser noise-suppression filter to the input.')
			.addToggle((toggle) =>
				toggle.setValue(s.inputNoiseSuppression).onChange(async (v) => {
					s.inputNoiseSuppression = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Echo cancellation')
			.setDesc('Apply the browser echo-cancellation filter to the input.')
			.addToggle((toggle) =>
				toggle.setValue(s.inputEchoCancellation).onChange(async (v) => {
					s.inputEchoCancellation = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Automatic gain control')
			.setDesc('Let the browser normalize the input level automatically.')
			.addToggle((toggle) =>
				toggle.setValue(s.inputAutoGainControl).onChange(async (v) => {
					s.inputAutoGainControl = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Input level meter')
			.setDesc('Show a live input-level meter while recording.')
			.addToggle((toggle) =>
				toggle.setValue(s.showInputLevelMeter).onChange(async (v) => {
					s.showInputLevelMeter = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Recording stats')
			.setDesc(
				'Show the live elapsed time and total recorded size while recording.',
			)
			.addToggle((toggle) =>
				toggle.setValue(s.showRecordingStats).onChange(async (v) => {
					s.showRecordingStats = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Detect silent channel after recording')
			.setDesc(
				'After saving a recording, check whether it is a stereo file with one silent channel - the typical result of a single microphone on a dual-input audio interface - and offer to convert it to mono. Long recordings are skipped.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(s.detectSilentChannelOnSave)
					.onChange(async (v) => {
						s.detectSilentChannelOnSave = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Mobile recording banner')
			.setDesc(
				'Show a prominent recording banner on mobile, where there is no ribbon indicator.',
			)
			.addToggle((toggle) =>
				toggle.setValue(s.mobileRecordingBanner).onChange(async (v) => {
					s.mobileRecordingBanner = v;
					await this.plugin.saveSettings();
				}),
			);

		this.renderAudioCleanupSettings(containerEl);
	}

	/**
	 * Renders the default settings for the on-demand "Clean up audio"
	 * dialog (high-pass, noise gate, loudness leveling). These prefill the
	 * dialog opened from the context menu; each run can override them.
	 * @param containerEl - The settings container element
	 */
	private renderAudioCleanupSettings(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName('Audio cleanup defaults')
			.setDesc(
				'Defaults for the cleanup action in the file/embed context menu. Cleanup runs on demand and writes a processed copy; it does not change live recording.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('High-pass filter')
			.setDesc('Remove low-frequency rumble below the cutoff by default.')
			.addSlider((slider) =>
				slider
					.setLimits(
						MIN_CLEANUP_HIGHPASS_HZ,
						MAX_CLEANUP_HIGHPASS_HZ,
						CLEANUP_HIGHPASS_STEP_HZ,
					)
					.setValue(s.cleanupHighPassHz)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.cleanupHighPassHz = v;
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setValue(s.cleanupHighPassEnabled)
					.onChange(async (v) => {
						s.cleanupHighPassEnabled = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Noise gate')
			.setDesc(
				'Silence the signal below the threshold (dBFS) by default.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(
						MIN_CLEANUP_GATE_THRESHOLD_DB,
						MAX_CLEANUP_GATE_THRESHOLD_DB,
						CLEANUP_GATE_STEP_DB,
					)
					.setValue(s.cleanupNoiseGateThresholdDb)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.cleanupNoiseGateThresholdDb = v;
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setValue(s.cleanupNoiseGateEnabled)
					.onChange(async (v) => {
						s.cleanupNoiseGateEnabled = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Loudness leveling')
			.setDesc(
				'Even out quiet and loud passages (compressor); makeup gain (dB).',
			)
			.addSlider((slider) =>
				slider
					.setLimits(
						MIN_CLEANUP_LEVELING_MAKEUP_DB,
						MAX_CLEANUP_LEVELING_MAKEUP_DB,
						CLEANUP_LEVELING_STEP_DB,
					)
					.setValue(s.cleanupLevelingMakeupDb)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.cleanupLevelingMakeupDb = v;
						await this.plugin.saveSettings();
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setValue(s.cleanupLevelingEnabled)
					.onChange(async (v) => {
						s.cleanupLevelingEnabled = v;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * Runs every registered channel-dropdown re-evaluator.
	 */
	private runChannelDropdownUpdaters(): void {
		for (const update of this.channelDropdownUpdaters) {
			update();
		}
	}

	/**
	 * Fills a channel-mode dropdown and binds it to a device selection.
	 * The dropdown greys itself out when the bound device positively reports
	 * a single capture channel
	 * (every mono option would be an identity or a fallback there) or
	 * when no device is selected at all. An id missing from a successful
	 * enumeration is treated as unplugged, while an enumeration failure or
	 * a present device with unknown capability keeps the selection enabled.
	 * Capability observation never changes the saved mode. The evaluator
	 * registers itself for re-runs on capability loads and device changes.
	 * @param dropdown - Dropdown to fill and manage
	 * @param binding - Accessors for the bound device and stored mode
	 */
	private bindChannelModeDropdown(
		dropdown: DropdownComponent,
		binding: {
			getDeviceId: () => string;
			hasDevice: () => boolean;
			getMode: () => ChannelMode;
			setMode: (mode: ChannelMode) => Promise<void>;
		},
	): void {
		const labels: Record<ChannelMode, string> = {
			source: 'Same as input device',
			'mono-mix': 'Mono (mix all channels)',
			'mono-left': 'Mono (left channel)',
			'mono-right': 'Mono (right channel)',
		};
		CHANNEL_MODES.forEach((mode) => {
			dropdown.addOption(mode, labels[mode]);
		});
		dropdown.setValue(binding.getMode());
		dropdown.onChange(async (value) => {
			await binding.setMode(normalizeChannelMode(value));
		});
		const update = (): void => {
			const deviceId = binding.getDeviceId();
			// Where the platform offers no channel layout choice (mobile),
			// every channel dropdown stays blocked regardless of devices.
			let available =
				isChannelModeSelectionSupported() && binding.hasDevice();
			if (available && deviceId) {
				const { enumerationSucceeded, channelLimits } =
					this.deviceSnapshot;
				available =
					!enumerationSucceeded ||
					(channelLimits.has(deviceId) &&
						channelSelectionAvailable(channelLimits.get(deviceId)));
			}
			dropdown.setDisabled(!available);
			// Runtime capability data is advisory and may be incomplete.
			// Never rewrite a persistent user choice merely because a device
			// is mono, unplugged, or temporarily absent from enumeration.
			dropdown.setValue(binding.getMode());
		};
		this.channelDropdownUpdaters.push(update);
		update();
	}

	private async refreshDeviceList(): Promise<void> {
		const generation = ++this.deviceRefreshGeneration;
		const snapshot = await getAudioInputDeviceSnapshot();
		if (!this.isDisplayed || generation !== this.deviceRefreshGeneration) {
			return;
		}
		this.deviceSnapshot = snapshot;
		if (snapshot.enumerationSucceeded) {
			for (const binding of this.deviceDropdowns) {
				const { dropdown } = binding;
				dropdown.selectEl.empty();
				for (const device of snapshot.devices) {
					const label =
						device.label ||
						`Audio device ${device.deviceId.substring(0, 8)}`;
					dropdown.addOption(device.deviceId, label);
				}
				const selectedDeviceId = binding.getSelectedDeviceId();
				const isPresent = snapshot.channelLimits.has(selectedDeviceId);
				dropdown.setValue(isPresent ? selectedDeviceId : '');
			}
		}
		this.runChannelDropdownUpdaters();
	}

	/**
	 * Runs a short test recording and plays back the result. The
	 * microphone stream is released in a finally block so an error in
	 * recorder setup (or the tab being hidden during the wait) can
	 * never leave the device captured.
	 * @param container - DOM element to append playback controls to
	 */
	private async runTestRecording(container: HTMLElement): Promise<void> {
		try {
			this.cleanupTestRecording();

			const result = await this.testRecorder.record(
				this.plugin.settings,
				TEST_RECORDING_DURATION_MS,
				() => {
					this.showTestStatus(
						container,
						'\u25CF Recording... (5 seconds)',
						false,
						'aar-test-recording',
					);
				},
			);

			if (result.kind === 'cancelled') {
				// The tab was hidden during the wait: cleanup already
				// discarded the recorder and the result has nowhere to go
				return;
			}
			if (result.kind === 'unsupported') {
				this.showTestStatus(
					container,
					`Format "${this.plugin.settings.recordingFormat}" is not supported in this browser.`,
					true,
				);
				return;
			}
			if (result.kind === 'empty') {
				this.showTestStatus(
					container,
					'Test recording produced no data. Try a different format or device.',
					true,
				);
				return;
			}

			const url = URL.createObjectURL(result.blob);

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
			// Revoke the element's blob URL before dropping it: repeated
			// test recordings would otherwise leak one blob per rerun
			// until the settings tab is closed
			const src = existingAudio.getAttribute('src');
			if (src?.startsWith('blob:')) {
				URL.revokeObjectURL(src);
			}
			if (existingAudio === this.testAudioElement) {
				this.testAudioElement = null;
			}
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
		this.testRecorder.cancel();

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
	override hide(): void {
		this.isDisplayed = false;
		// Invalidate every in-flight enumeration before detaching controls.
		this.deviceRefreshGeneration++;
		this.deviceDropdowns = [];
		this.channelDropdownUpdaters = [];
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
