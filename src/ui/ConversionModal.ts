/**
 * Modal dialog for converting audio files between formats.
 * @module ui/ConversionModal
 */

import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
	getEncoderDescription,
} from '../recording/AudioEncoder';
import { AUDIO_EXTENSIONS, FORMAT_WAV } from '../constants';
import { getSupportedBitrates } from '../recording/AudioCapabilityDetector';
import { decodeAudioDataAtNativeRate } from '../recording/AudioFormatConverter';
import { updateLinksInOpenEditors } from '../utils/LinkUpdater';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/Settings';

/**
 * Modal for converting an audio file to a different format.
 */
export class ConversionModal extends Modal {
	private readonly sourceFile: TFile;
	private targetFormat: string = FORMAT_WAV;
	private bitrate: number = 128000;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;

	constructor(app: App, sourceFile: TFile, settings: AudioRecorderSettings) {
		super(app);
		this.sourceFile = sourceFile;
		this.deleteSource = settings.deleteSourceAfterConversion;
		this.linkAction = settings.conversionLinkAction;
	}

	onOpen(): void {
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

		new Setting(contentEl)
			.setName('Bitrate')
			.setDesc('Audio bitrate for compressed formats.')
			.addDropdown((dropdown) => {
				const bitrates = getSupportedBitrates();
				bitrates.forEach((bps) => {
					const kbps = Math.round(bps / 1000);
					dropdown.addOption(String(bps), `${String(kbps)} kbps`);
				});
				dropdown.setValue(String(this.bitrate));
				dropdown.onChange((value) => {
					this.bitrate = parseInt(value, 10);
				});
			});

		new Setting(contentEl)
			.setName('Delete source file')
			.setDesc('Remove the original file after successful conversion.')
			.addToggle((toggle) =>
				toggle.setValue(this.deleteSource).onChange((value) => {
					this.deleteSource = value;
				}),
			);

		new Setting(contentEl)
			.setName('Update links in notes')
			.setDesc('How to handle links to the converted file in your notes.')
			.addDropdown((dropdown) => {
				dropdown.addOption('none', 'Do nothing');
				dropdown.addOption('replace', 'Replace source link');
				dropdown.addOption('after', 'Insert after source link');
				dropdown.setValue(this.linkAction);
				dropdown.onChange((value) => {
					this.linkAction = value as ConversionLinkAction;
				});
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

	onClose(): void {
		this.contentEl.empty();
	}

	private async runConversion(progressEl: HTMLElement): Promise<void> {
		try {
			const baseName = this.sourceFile.basename;
			const directory = this.sourceFile.parent?.path ?? '';
			const newFileName = `${baseName}.${this.targetFormat}`;
			const newPath = normalizePath(
				directory ? `${directory}/${newFileName}` : newFileName,
			);

			// Check if target file already exists
			if (await this.app.vault.adapter.exists(newPath)) {
				new Notice(
					`File "${newFileName}" already exists. Choose a different format or rename the existing file.`,
				);
				return;
			}

			progressEl.setText('Reading source file...');
			const arrayBuffer = await this.app.vault.adapter.readBinary(
				this.sourceFile.path,
			);

			progressEl.setText('Decoding audio...');
			const audioBuffer = await decodeAudioDataAtNativeRate(arrayBuffer);

			progressEl.setText('Encoding...');
			const blob = await encodeAudioBuffer(
				audioBuffer,
				{
					format: this.targetFormat,
					bitrate: this.bitrate,
				},
				(percent) => {
					progressEl.setText(`Encoding... ${String(percent)}%`);
				},
			);

			progressEl.setText('Saving...');
			await this.app.vault.createBinary(
				newPath,
				await blob.arrayBuffer(),
			);

			// Update links in notes
			if (this.linkAction !== 'none') {
				progressEl.setText('Updating links...');
				updateLinksInOpenEditors(
					this.app,
					this.sourceFile.name,
					[newFileName],
					this.linkAction,
				);
			}

			// Delete source file
			if (this.deleteSource) {
				progressEl.setText('Removing source file...');
				await this.app.fileManager.trashFile(this.sourceFile);
			}

			progressEl.setText('');
			const action = this.deleteSource ? 'Replaced with' : 'Converted to';
			new Notice(`${action} ${newFileName}`);
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			progressEl.setText(`Error: ${message}`);
			new Notice(`Conversion failed: ${message}`);
		}
	}
}
