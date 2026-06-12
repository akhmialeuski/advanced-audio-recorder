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
import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from './settingHelpers';
import {
	decodeAudioBlob,
	convertBlobToFormat,
} from '../recording/AudioFormatConverter';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
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
	/** Whether the conversion pipeline is currently running. */
	private isConverting = false;
	/** Progress notice shown when the modal is closed mid-conversion. */
	private progressNotice: Notice | null = null;

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

	onClose(): void {
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

			this.setProgress(progressEl, 'Reading source file...');
			const arrayBuffer = await this.app.vault.adapter.readBinary(
				this.sourceFile.path,
			);

			let blob: Blob;
			if (this.targetFormat === FORMAT_WAV) {
				// WAV needs a full decode; the streaming pipeline only
				// targets compressed formats
				this.setProgress(progressEl, 'Decoding audio...');
				const audioBuffer = await decodeAudioBlob(arrayBuffer);
				this.setProgress(progressEl, 'Encoding...');
				blob = await encodeAudioBuffer(
					audioBuffer,
					{
						format: this.targetFormat,
						bitrate: this.bitrate,
					},
					(percent) => {
						this.setProgress(
							progressEl,
							`Encoding... ${String(percent)}%`,
						);
					},
				);
			} else {
				this.setProgress(progressEl, 'Converting...');
				blob = await convertBlobToFormat(
					new Blob([arrayBuffer]),
					this.targetFormat,
					this.bitrate,
					(percent) => {
						this.setProgress(
							progressEl,
							`Converting... ${String(percent)}%`,
						);
					},
				);
			}

			this.setProgress(progressEl, 'Saving...');
			const createdFile = await this.app.vault.createBinary(
				newPath,
				await blob.arrayBuffer(),
			);

			// The converted file exists on disk from here on
			if (
				!(await this.finishConversion(
					progressEl,
					createdFile,
					newFileName,
				))
			) {
				return;
			}

			this.setProgress(progressEl, '');
			const action = this.deleteSource ? 'Replaced with' : 'Converted to';
			new Notice(`${action} ${newFileName}`);
			// Cleared before close() so onClose does not start a
			// background notice for an already finished conversion
			this.isConverting = false;
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			this.setProgress(progressEl, `Error: ${message}`);
			new Notice(`Conversion failed: ${message}`);
		} finally {
			this.isConverting = false;
			this.progressNotice?.hide();
			this.progressNotice = null;
		}
	}

	/**
	 * Post-write pipeline steps: updates links across the whole vault
	 * (covering notes that are not open, exactly like the split flow)
	 * and optionally deletes the source file. The converted file already
	 * exists, so errors here are reported as partial success. The source
	 * file is kept when some links could not be updated, because
	 * deleting it would leave those links broken.
	 * @param progressEl - Progress element inside the modal
	 * @param createdFile - The converted file
	 * @param newFileName - Display name of the converted file
	 * @returns True when every requested step succeeded
	 */
	private async finishConversion(
		progressEl: HTMLElement,
		createdFile: TFile,
		newFileName: string,
	): Promise<boolean> {
		let linkResult: VaultLinkUpdateResult | null = null;
		if (this.linkAction !== 'none') {
			this.setProgress(progressEl, 'Updating links...');
			try {
				linkResult = await updateLinksInVault(
					this.app,
					this.sourceFile,
					[createdFile],
					this.linkAction,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				this.setProgress(progressEl, `Error: ${message}`);
				new Notice(
					`"${newFileName}" was created, but updating links failed: ${message}. The source file was kept.`,
				);
				return false;
			}
			if (linkResult.frontmatterReferences > 0) {
				new Notice(
					`${String(linkResult.frontmatterReferences)} frontmatter link(s) still point to the source file and must be updated manually.`,
				);
			}
		}

		if (this.deleteSource) {
			if (linkResult !== null && linkResult.skippedReferences > 0) {
				new Notice(
					`Source file kept: ${String(linkResult.skippedReferences)} link(s) could not be updated.`,
				);
			} else {
				this.setProgress(progressEl, 'Removing source file...');
				try {
					await this.app.fileManager.trashFile(this.sourceFile);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.setProgress(progressEl, `Error: ${message}`);
					new Notice(
						`"${newFileName}" was created, but the source file could not be deleted: ${message}`,
					);
					return false;
				}
			}
		}
		return true;
	}
}
