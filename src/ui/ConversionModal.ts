/**
 * Modal dialog for converting audio files between formats.
 * @module ui/ConversionModal
 */

import { App, Notice, Setting, TFile } from 'obsidian';
import { PluginModal } from './PluginModal';
import { JobProgressNotice } from './JobProgressNotice';
import type { ButtonComponent, DropdownComponent } from 'obsidian';
import {
	ChannelMode,
	channelCountFor,
	normalizeChannelMode,
} from '../audio/downmix';
import { FORMAT_WAV } from '../constants';
import {
	addBitrateSetting,
	type BitrateRow,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from '../settings/settingControls';
import { getEncoderDescription } from './formatDescriptions';
import { ConversionService, conversionTargets } from '../recording/api';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import { CancellationSource } from '../utils/cancellation';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/settingsSchema';

/** Optional collaborators and initial form state for ConversionModal. */
export interface ConversionModalOptions {
	onConverted?: ((convertedPath: string) => void) | undefined;
	getWorkerClient?: () => EncodingWorkerClient | null;
	initialChannelMode?: ChannelMode;
}

/**
 * Modal for converting an audio file to a different format.
 */
export class ConversionModal extends PluginModal {
	private readonly sourceFile: TFile;
	private targetFormat: string = FORMAT_WAV;
	private bitrate: number;
	private channelMode: ChannelMode = ChannelMode.Source;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;
	/** Target-format dropdown, rebuilt when the channel mode changes. */
	private formatDropdown: DropdownComponent | null = null;
	/** Bitrate row, re-offered when the target format changes. */
	private bitrateRow: BitrateRow | null = null;
	/**
	 * The running conversion's cancellation, null while none runs, which makes
	 * it the one answer to whether a conversion is running.
	 */
	private cancellation: CancellationSource | null = null;
	/** The Cancel button, shown only while a conversion runs. */
	private cancelButton: ButtonComponent | null = null;
	/** Progress notice shown when the modal is closed mid-conversion. */
	private progressNotice: JobProgressNotice | null = null;
	/** Conversion pipeline behind the form. */
	private readonly conversionService: ConversionService;
	private readonly onConverted?:
		((convertedPath: string) => void) | undefined;

	/**
	 * @param app - Obsidian app handle
	 * @param sourceFile - Audio file to convert
	 * @param getSettings - Returns plugin settings (seed format/bitrate/link
	 * defaults). A live accessor rather than a snapshot, so every dialog reads
	 * settings the same way.
	 * @param options - Optional callback, worker supplier, and initial channel
	 * mode. A named object keeps future callers from depending on positional
	 * argument order.
	 */
	constructor(
		app: App,
		sourceFile: TFile,
		getSettings: () => AudioRecorderSettings,
		options: ConversionModalOptions = {},
	) {
		super(app);
		const settings = getSettings();
		this.sourceFile = sourceFile;
		this.bitrate = settings.bitrate;
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
					// The layout is re-stated with the format because the
					// encoder answers a different question for each: a mono
					// conversion picked before the format would otherwise be
					// probed as the stereo one the row was built with.
					this.bitrateRow?.rebuild(
						value,
						channelCountFor(this.channelMode),
					);
				});
			});

		new Setting(contentEl)
			.setName('Channels')
			.setDesc(
				'Keep the source channel layout, or downmix to mono. The left/right channel options rescue stereo files where only one channel carries audio (common with dual-input audio interfaces). A mono option also allows converting to the same format.',
			)
			.addDropdown((dropdown) => {
				const labels: Record<ChannelMode, string> = {
					[ChannelMode.Source]: 'Keep source channels',
					[ChannelMode.MonoMix]: 'Mono (mix all channels)',
					[ChannelMode.MonoLeft]: 'Mono (left channel)',
					[ChannelMode.MonoRight]: 'Mono (right channel)',
				};
				Object.values(ChannelMode).forEach((mode) => {
					dropdown.addOption(mode, labels[mode]);
				});
				dropdown.setValue(this.channelMode);
				dropdown.onChange((value) => {
					this.channelMode = normalizeChannelMode(value);
					this.rebuildFormatOptions();
				});
			});

		this.bitrateRow = addBitrateSetting(contentEl, {
			desc: 'Audio bitrate for compressed formats. The lowest values are a mono speech mode and cost real quality on music or stereo.',
			format: this.targetFormat,
			// A mono conversion writes one channel, and an encoder accepts a
			// different set of rates for each layout.
			numberOfChannels: channelCountFor(this.channelMode),
			initialBitrate: this.bitrate,
			onChange: (bitrate) => {
				this.bitrate = bitrate;
			},
		});
		this.bitrate = this.bitrateRow.value;

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

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText('Convert')
					.setCta()
					.onClick(() => {
						button.setDisabled(true);
						void this.runConversion(progressEl).finally(() => {
							button.setDisabled(false);
						});
					});
			})
			.addButton((button) => {
				this.cancelButton = button;
				button.setButtonText('Cancel').onClick(() => {
					button.setDisabled(true);
					this.setProgress(progressEl, 'Cancelling...');
					this.cancellation?.cancel();
				});
				button.buttonEl.toggle(false);
			});
	}

	/**
	 * Formats offered as conversion targets. The source's own format is
	 * excluded for channel-preserving conversions (same format in and
	 * out would be a pointless lossy re-encode) but offered for the mono
	 * modes, so a stereo file can become a mono file of the same format.
	 */
	private availableFormats(): string[] {
		return conversionTargets(
			this.sourceFile.extension.toLowerCase(),
			this.channelMode,
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
		// The channel mode can settle on a different target, and neither the
		// bitrates that target reaches nor the layout the encoder is asked
		// about are the ones on offer now.
		this.bitrateRow?.rebuild(
			this.targetFormat,
			channelCountFor(this.channelMode),
		);
	}

	override onClose(): void {
		if (this.cancellation && !this.progressNotice) {
			// The notice is where the conversion can still be cancelled
			// from; setProgress mirrors further pipeline progress into it
			this.progressNotice = new JobProgressNotice(
				`Converting "${this.sourceFile.name}"`,
				this.cancellation,
				`Converting "${this.sourceFile.name}" continues in the background...`,
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
		this.progressNotice?.setProgress(text);
	}

	/**
	 * Runs the conversion with a Cancel offered for as long as it runs: in
	 * the dialog, and in the notice once the dialog is closed.
	 * @param progressEl - Progress element inside the modal
	 */
	private async runConversion(progressEl: HTMLElement): Promise<void> {
		const cancellation = new CancellationSource();
		this.cancellation = cancellation;
		this.cancelButton?.setDisabled(false);
		this.cancelButton?.buttonEl.toggle(true);
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
				cancellation.token,
			);
			if (outcome.status === 'cancelled') {
				new Notice(`Cancelled converting "${this.sourceFile.name}".`);
				return;
			}
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
			this.cancellation = null;
			this.close();
		} finally {
			this.cancellation = null;
			this.cancelButton?.buttonEl.toggle(false);
			this.progressNotice?.hide();
			this.progressNotice = null;
		}
	}
}
