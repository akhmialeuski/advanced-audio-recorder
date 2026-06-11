/**
 * Modal dialog for splitting an audio file into time-based parts.
 * WAV files are split losslessly at the byte level; compressed formats
 * are decoded once and re-encoded per part.
 * @module ui/SplitModal
 */

import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
} from '../recording/AudioEncoder';
import {
	FORMAT_WAV,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import { getSupportedBitrates } from '../recording/AudioCapabilityDetector';
import { decodeAudioDataAtNativeRate } from '../recording/AudioFormatConverter';
import {
	parseWavLayout,
	splitWavBuffer,
	sliceAudioBuffer,
	computePartCount,
	buildPartFileName,
	sanitizePartSuffix,
} from '../recording/AudioSplitter';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/Settings';

/** Seconds in one minute. */
const SECONDS_PER_MINUTE = 60;

/**
 * Modal for splitting an audio file into parts of a fixed duration.
 */
export class SplitModal extends Modal {
	private readonly sourceFile: TFile;
	private partMinutes: number;
	private partSuffix: string;
	private bitrate: number;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction = 'replace';

	constructor(app: App, sourceFile: TFile, settings: AudioRecorderSettings) {
		super(app);
		this.sourceFile = sourceFile;
		this.partMinutes = settings.splitChunkMinutes;
		this.partSuffix = sanitizePartSuffix(settings.splitPartSuffix);
		this.bitrate = settings.bitrate;
		this.deleteSource = settings.deleteSourceAfterSplit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName('Split audio into parts').setHeading();
		contentEl.createEl('p', {
			text: `Source: ${this.sourceFile.name}`,
			cls: 'aar-split-source',
		});

		new Setting(contentEl)
			.setName('Part duration')
			.setDesc('Length of each part in minutes.')
			.addSlider((slider) =>
				slider
					.setLimits(
						MIN_SPLIT_CHUNK_MINUTES,
						MAX_SPLIT_CHUNK_MINUTES,
						1,
					)
					.setValue(this.partMinutes)
					.setDynamicTooltip()
					.onChange((value) => {
						this.partMinutes = value;
					}),
			);

		new Setting(contentEl)
			.setName('Part name suffix')
			.setDesc(
				`Appended with the part number, e.g. "${this.sourceFile.basename}-${this.partSuffix}1.${this.sourceFile.extension}".`,
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SPLIT_PART_SUFFIX)
					.setValue(this.partSuffix)
					.onChange((value) => {
						this.partSuffix = value;
					}),
			);

		if (this.sourceFile.extension.toLowerCase() !== FORMAT_WAV) {
			new Setting(contentEl)
				.setName('Bitrate')
				.setDesc(
					'Bitrate used when re-encoding parts of compressed formats.',
				)
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
		}

		new Setting(contentEl)
			.setName('Delete source file')
			.setDesc('Remove the original file after a successful split.')
			.addToggle((toggle) =>
				toggle.setValue(this.deleteSource).onChange((value) => {
					this.deleteSource = value;
				}),
			);

		new Setting(contentEl)
			.setName('Update links in notes')
			.setDesc(
				'How to handle links to the source file in your notes. Links in all notes of the vault are updated.',
			)
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
			cls: 'aar-split-progress',
		});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText('Split')
				.setCta()
				.onClick(() => {
					button.setDisabled(true);
					void this.runSplit(progressEl).finally(() => {
						button.setDisabled(false);
					});
				});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * Executes the split pipeline: prepare parts, pre-check collisions,
	 * write part files, update links, optionally delete the source.
	 */
	private async runSplit(progressEl: HTMLElement): Promise<void> {
		try {
			const partSeconds =
				Math.max(
					MIN_SPLIT_CHUNK_MINUTES,
					Math.floor(this.partMinutes),
				) * SECONDS_PER_MINUTE;

			progressEl.setText('Reading source file...');
			const sourceBytes = await this.app.vault.adapter.readBinary(
				this.sourceFile.path,
			);

			const parts = await this.preparePartBlobs(
				sourceBytes,
				partSeconds,
				progressEl,
			);
			if (!parts) {
				return;
			}

			const partNames = parts.map((part) => part.fileName);
			const partPaths = await this.resolvePartPaths(partNames);
			if (!partPaths) {
				return;
			}

			await this.writePartFiles(parts, partPaths, progressEl);

			if (this.linkAction !== 'none') {
				progressEl.setText('Updating links...');
				await updateLinksInVault(
					this.app,
					this.sourceFile,
					partNames,
					this.linkAction,
				);
			}

			if (this.deleteSource) {
				progressEl.setText('Removing source file...');
				await this.app.fileManager.trashFile(this.sourceFile);
			}

			progressEl.setText('');
			new Notice(
				`Split into ${String(parts.length)} parts: ${partNames[0]} ...`,
			);
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			progressEl.setText(`Error: ${message}`);
			new Notice(`Split failed: ${message}`);
		}
	}

	/**
	 * Builds part blobs from the source bytes. WAV sources with a raw
	 * sample data chunk are split byte-exactly without decoding; other
	 * formats are decoded once and re-encoded per part.
	 * @returns Parts with target file names, or null when splitting
	 * is not possible (a Notice explains why)
	 */
	private async preparePartBlobs(
		sourceBytes: ArrayBuffer,
		partSeconds: number,
		progressEl: HTMLElement,
	): Promise<
		{ fileName: string; data: () => Promise<ArrayBuffer> }[] | null
	> {
		const suffix = sanitizePartSuffix(this.partSuffix);
		const baseName = this.sourceFile.basename;
		const sourceExtension = this.sourceFile.extension.toLowerCase();

		if (sourceExtension === FORMAT_WAV) {
			const layout = parseWavLayout(sourceBytes);
			if (layout) {
				const partBytes =
					Math.floor(
						(layout.byteRate * partSeconds) / layout.blockAlign,
					) * layout.blockAlign;
				if (layout.dataLength <= partBytes) {
					new Notice('File is shorter than one part.');
					return null;
				}
				progressEl.setText('Splitting audio data...');
				const buffers = splitWavBuffer(
					sourceBytes,
					layout,
					partSeconds,
				);
				return buffers.map((buffer, index) => ({
					fileName: buildPartFileName(
						baseName,
						suffix,
						index + 1,
						FORMAT_WAV,
					),
					data: () => Promise.resolve(buffer),
				}));
			}
			// Non-raw WAV (compressed codec inside): fall through to decode
		}

		progressEl.setText('Decoding audio...');
		const audioBuffer = await decodeAudioDataAtNativeRate(sourceBytes);
		const partSamples = partSeconds * audioBuffer.sampleRate;
		if (audioBuffer.length <= partSamples) {
			new Notice('File is shorter than one part.');
			return null;
		}

		const targetFormat = isOfflineEncodingSupported(sourceExtension)
			? sourceExtension
			: FORMAT_WAV;
		if (targetFormat !== sourceExtension) {
			new Notice(
				`Encoding to "${sourceExtension}" is unavailable; parts are saved as WAV.`,
			);
		}

		const partCount = computePartCount(audioBuffer.length, partSamples);
		return Array.from({ length: partCount }, (_, index) => ({
			fileName: buildPartFileName(
				baseName,
				suffix,
				index + 1,
				targetFormat,
			),
			data: async () => {
				const slice = sliceAudioBuffer(
					audioBuffer,
					index * partSamples,
					(index + 1) * partSamples,
				);
				const blob = await encodeAudioBuffer(slice, {
					format: targetFormat,
					bitrate: this.bitrate,
				});
				return blob.arrayBuffer();
			},
		}));
	}

	/**
	 * Resolves full vault paths for all parts and aborts when any
	 * target file already exists.
	 * @returns Normalized part paths, or null on collision
	 */
	private async resolvePartPaths(
		partNames: string[],
	): Promise<string[] | null> {
		const directory = this.sourceFile.parent?.path ?? '';
		const paths = partNames.map((name) =>
			normalizePath(directory ? `${directory}/${name}` : name),
		);
		for (const path of paths) {
			if (await this.app.vault.adapter.exists(path)) {
				new Notice(
					`File "${path}" already exists. Rename it or choose a different suffix.`,
				);
				return null;
			}
		}
		return paths;
	}

	/**
	 * Writes all part files, yielding to the UI between parts.
	 * On failure removes already-written parts and rethrows, keeping
	 * the source file intact.
	 */
	private async writePartFiles(
		parts: { fileName: string; data: () => Promise<ArrayBuffer> }[],
		partPaths: string[],
		progressEl: HTMLElement,
	): Promise<void> {
		const writtenPaths: string[] = [];
		try {
			for (let i = 0; i < parts.length; i++) {
				progressEl.setText(
					`Writing part ${String(i + 1)} of ${String(parts.length)}...`,
				);
				const bytes = await parts[i].data();
				await this.app.vault.createBinary(partPaths[i], bytes);
				writtenPaths.push(partPaths[i]);
				// Yield to the UI between parts: MP3 encoding is synchronous
				await new Promise<void>((resolve) =>
					activeWindow.setTimeout(resolve, 0),
				);
			}
		} catch (error) {
			for (const path of writtenPaths) {
				try {
					await this.app.vault.adapter.remove(path);
				} catch (cleanupError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to remove part after split error:`,
						{ path, cleanupError },
					);
				}
			}
			throw error;
		}
	}
}
