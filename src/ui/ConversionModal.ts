/**
 * Modal dialog for converting audio files between formats.
 * @module ui/ConversionModal
 */

import { App, Notice, Setting, TFile } from 'obsidian';
import { CancellableJobModal } from './CancellableJobModal';
import type { DropdownComponent } from 'obsidian';
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
import {
	ConversionService,
	conversionDefaults,
	conversionTargets,
} from '../recording/api';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
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
export class ConversionModal extends CancellableJobModal {
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
		const defaults = conversionDefaults(getSettings());
		this.sourceFile = sourceFile;
		this.bitrate = defaults.bitrate;
		this.deleteSource = defaults.deleteSource;
		this.linkAction = defaults.linkAction;
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

		this.renderJobActions('Convert', progressEl, () =>
			this.runConversion(progressEl),
		);
	}

	protected override jobTitle(): string {
		return `Converting "${this.sourceFile.name}"`;
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

	/**
	 * Runs the conversion through the frame, which offers the Cancel for as
	 * long as it runs and closes the dialog once it is done.
	 * @param progressEl - Progress element inside the modal
	 */
	private async runConversion(progressEl: HTMLElement): Promise<void> {
		await this.runJob(async (token) => {
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
				token,
			);
			if (outcome.status === 'cancelled') {
				new Notice(`Cancelled converting "${this.sourceFile.name}".`);
				return false;
			}
			if (outcome.status !== 'completed') {
				return false;
			}

			this.setProgress(progressEl, '');
			// Conversion already rewrote the note's link (linkAction); prime
			// the new file so the enhanced player applies without reopening
			// the note.
			this.onConverted?.(outcome.newPath);
			const action = this.deleteSource ? 'Replaced with' : 'Converted to';
			new Notice(`${action} ${outcome.newFileName}`);
			return true;
		});
	}
}
