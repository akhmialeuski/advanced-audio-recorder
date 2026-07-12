/**
 * Modal dialog for converting audio files between formats.
 * @module ui/ConversionModal
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type { DropdownComponent } from 'obsidian';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import {
	CHANNEL_MODE_SOURCE,
	CHANNEL_MODES,
	isMonoChannelMode,
	normalizeChannelMode,
	type ChannelMode,
} from '../audio/downmix';
import { AUDIO_EXTENSIONS, FORMAT_WAV } from '../constants';
import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from './settingHelpers';
import { getEncoderDescription } from './formatDescriptions';
import { ConversionService } from '../recording/api';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/settingsSchema';

/** Optional collaborators and initial form state for ConversionModal. */
export interface ConversionModalOptions {
	onConverted?: (convertedPath: string) => void;
	getWorkerClient?: () => EncodingWorkerClient | null;
	initialChannelMode?: ChannelMode;
}

/**
 * Modal for converting an audio file to a different format.
 */
export class ConversionModal extends Modal {
	private readonly sourceFile: TFile;
	private targetFormat: string = FORMAT_WAV;
	private bitrate: number = 128000;
	private channelMode: ChannelMode = CHANNEL_MODE_SOURCE;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;
	/** Target-format dropdown, rebuilt when the channel mode changes. */
	private formatDropdown: DropdownComponent | null = null;
	/** Whether the conversion pipeline is currently running. */
	private isConverting = false;
	/** Progress notice shown when the modal is closed mid-conversion. */
	private progressNotice: Notice | null = null;
	/** Conversion pipeline behind the form. */
	private readonly conversionService: ConversionService;
	private readonly onConverted?: (convertedPath: string) => void;

	/**
	 * @param app - Obsidian app handle
	 * @param sourceFile - Audio file to convert
	 * @param settings - Plugin settings (seed format/bitrate/link defaults)
	 * @param options - Optional callback, worker supplier, and initial channel
	 * mode. A named object keeps future callers from depending on positional
	 * argument order.
	 */
	constructor(
		app: App,
		sourceFile: TFile,
		settings: AudioRecorderSettings,
		options: ConversionModalOptions = {},
	) {
		super(app);
		this.sourceFile = sourceFile;
		this.deleteSource = settings.deleteSourceAfterConversion;
		this.linkAction = settings.conversionLinkAction;
		this.channelMode = normalizeChannelMode(options.initialChannelMode);
		this.onConverted = options.onConverted;
		this.conversionService = new ConversionService(
			app,
			options.getWorkerClient ?? (() => null),
		);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName('Convert audio format').setHeading();
		contentEl.createEl('p', {
			text: `Source: ${this.sourceFile.name}`,
			cls: 'aar-conversion-source',
		});

		new Setting(contentEl)
			.setName('Target format')
			.setDesc('Select the output format.')
			.addDropdown((dropdown) => {
				this.formatDropdown = dropdown;
				this.rebuildFormatOptions();
				dropdown.onChange((value) => {
					this.targetFormat = value;
				});
			});

		new Setting(contentEl)
			.setName('Channels')
			.setDesc(
				'Keep the source channel layout, or downmix to mono. The left/right channel options rescue stereo files where only one channel carries audio (common with dual-input audio interfaces). A mono option also allows converting to the same format.',
			)
			.addDropdown((dropdown) => {
				const labels: Record<ChannelMode, string> = {
					source: 'Keep source channels',
					'mono-mix': 'Mono (mix all channels)',
					'mono-left': 'Mono (left channel)',
					'mono-right': 'Mono (right channel)',
				};
				CHANNEL_MODES.forEach((mode) => {
					dropdown.addOption(mode, labels[mode]);
				});
				dropdown.setValue(this.channelMode);
				dropdown.onChange((value) => {
					this.channelMode = normalizeChannelMode(value);
					this.rebuildFormatOptions();
				});
			});

		this.bitrate = addBitrateSetting(contentEl, {
			desc: 'Audio bitrate for compressed formats.',
			initialBitrate: this.bitrate,
			onChange: (bitrate) => {
				this.bitrate = bitrate;
			},
		});

		addDeleteSourceSetting(contentEl, {
			desc: 'Remove the original file after successful conversion.',
			initialValue: this.deleteSource,
			onChange: (value) => {
				this.deleteSource = value;
			},
		});

		addLinkActionSetting(contentEl, {
			desc: 'How to handle links to the converted file in your notes.',
			initialValue: this.linkAction,
			onChange: (value) => {
				this.linkAction = value;
			},
		});

		const progressEl = contentEl.createDiv({
			cls: 'aar-conversion-progress',
		});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText('Convert')
				.setCta()
				.onClick(() => {
					button.setDisabled(true);
					void this.runConversion(progressEl).finally(() => {
						button.setDisabled(false);
					});
				});
		});
	}

	/**
	 * Formats offered as conversion targets. The source's own format is
	 * excluded for channel-preserving conversions (same format in and
	 * out would be a pointless lossy re-encode) but offered for the mono
	 * modes, so a stereo file can become a mono file of the same format.
	 */
	private availableFormats(): string[] {
		const sourceFormat = this.sourceFile.extension.toLowerCase();
		return AUDIO_EXTENSIONS.filter(
			(format) =>
				isOfflineEncodingSupported(format) &&
				(format !== sourceFormat ||
					isMonoChannelMode(this.channelMode)),
		);
	}

	/**
	 * Rebuilds the target-format dropdown options for the current
	 * channel mode, keeping the selection when it is still offered and
	 * falling back to the first available format when it is not.
	 */
	private rebuildFormatOptions(): void {
		const dropdown = this.formatDropdown;
		if (!dropdown) {
			return;
		}
		const formats = this.availableFormats();
		dropdown.selectEl.empty();
		formats.forEach((format) => {
			const encoder = getEncoderDescription(format);
			dropdown.addOption(format, `${format.toUpperCase()} (${encoder})`);
		});
		const first = formats[0];
		if (!formats.includes(this.targetFormat) && first) {
			this.targetFormat = first;
		}
		dropdown.setValue(this.targetFormat);
	}

	override onClose(): void {
		if (this.isConverting && !this.progressNotice) {
			// Timeout 0 keeps the notice visible until hidden explicitly;
			// setProgress mirrors further pipeline progress into it
			this.progressNotice = new Notice(
				`Converting "${this.sourceFile.name}" continues in the background...`,
				0,
			);
		}
		this.contentEl.empty();
	}

	/**
	 * Shows pipeline progress in the modal and mirrors it to the
	 * background notice when the modal was closed mid-conversion.
	 * @param progressEl - Progress element inside the modal
	 * @param text - Progress text; an empty string clears the element
	 */
	private setProgress(progressEl: HTMLElement, text: string): void {
		progressEl.setText(text);
		if (this.progressNotice && text !== '') {
			this.progressNotice.setMessage(
				`Converting "${this.sourceFile.name}": ${text}`,
			);
		}
	}

	private async runConversion(progressEl: HTMLElement): Promise<void> {
		this.isConverting = true;
		try {
			const outcome = await this.conversionService.convert(
				{
					sourceFile: this.sourceFile,
					targetFormat: this.targetFormat,
					bitrate: this.bitrate,
					channelMode: this.channelMode,
					deleteSource: this.deleteSource,
					linkAction: this.linkAction,
				},
				(text) => {
					this.setProgress(progressEl, text);
				},
			);
			if (outcome.status !== 'completed') {
				return;
			}

			this.setProgress(progressEl, '');
			// Conversion already rewrote the note's link (linkAction); prime the
			// new file so the enhanced player applies without reopening the note.
			this.onConverted?.(outcome.newPath);
			const action = this.deleteSource ? 'Replaced with' : 'Converted to';
			new Notice(`${action} ${outcome.newFileName}`);
			// Cleared before close() so onClose does not start a
			// background notice for an already finished conversion
			this.isConverting = false;
			this.close();
		} finally {
			this.isConverting = false;
			this.progressNotice?.hide();
			this.progressNotice = null;
		}
	}
}
