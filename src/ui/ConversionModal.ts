/**
 * Modal dialog for converting audio files between formats.
 * @module ui/ConversionModal
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import {
	isOfflineEncodingSupported,
	getEncoderDescription,
} from '../audio/AudioEncoder';
import { AUDIO_EXTENSIONS, FORMAT_WAV } from '../constants';
import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from './settingHelpers';
import { ConversionService } from '../recording/ConversionService';
import type { EncodingWorkerClient } from '../audio/EncodingWorkerClient';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/settingsSchema';

/**
 * Modal for converting an audio file to a different format.
 */
export class ConversionModal extends Modal {
	private readonly sourceFile: TFile;
	private targetFormat: string = FORMAT_WAV;
	private bitrate: number = 128000;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;
	/** Whether the conversion pipeline is currently running. */
	private isConverting = false;
	/** Progress notice shown when the modal is closed mid-conversion. */
	private progressNotice: Notice | null = null;
	/** Conversion pipeline behind the form. */
	private readonly conversionService: ConversionService;

	/**
	 * @param app - Obsidian app handle
	 * @param sourceFile - Audio file to convert
	 * @param settings - Plugin settings (seed format/bitrate/link defaults)
	 * @param onConverted - Called with the converted file's path after a
	 *   successful run, so a caller can prime it for the enhanced player.
	 */
	constructor(
		app: App,
		sourceFile: TFile,
		settings: AudioRecorderSettings,
		private readonly onConverted?: (convertedPath: string) => void,
		getWorkerClient: () => EncodingWorkerClient | null = () => null,
	) {
		super(app);
		this.sourceFile = sourceFile;
		this.deleteSource = settings.deleteSourceAfterConversion;
		this.linkAction = settings.conversionLinkAction;
		this.conversionService = new ConversionService(app, getWorkerClient);
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName('Convert audio format').setHeading();
		contentEl.createEl('p', {
			text: `Source: ${this.sourceFile.name}`,
			cls: 'aar-conversion-source',
		});

		const availableFormats = AUDIO_EXTENSIONS.filter(
			(format) =>
				isOfflineEncodingSupported(format) &&
				format !== this.sourceFile.extension.toLowerCase(),
		);

		new Setting(contentEl)
			.setName('Target format')
			.setDesc('Select the output format.')
			.addDropdown((dropdown) => {
				availableFormats.forEach((format) => {
					const encoder = getEncoderDescription(format);
					dropdown.addOption(
						format,
						`${format.toUpperCase()} (${encoder})`,
					);
				});
				if (availableFormats.length > 0) {
					this.targetFormat = availableFormats[0];
					dropdown.setValue(this.targetFormat);
				}
				dropdown.onChange((value) => {
					this.targetFormat = value;
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
