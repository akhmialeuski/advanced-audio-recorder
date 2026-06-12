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
	SECONDS_PER_MINUTE,
	SPLIT_PART_SUFFIX_PATTERN,
	SPLIT_PART_SUFFIX_RULE_TEXT,
} from '../constants';
import { decodeAudioBlob } from '../recording/AudioFormatConverter';
import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from './settingHelpers';
import {
	parseWavLayout,
	buildWavPart,
	clampSplitMinutes,
	computeWavPartBytes,
	sliceAudioBuffer,
	computePartCount,
	buildPartFileName,
	sanitizePartSuffix,
} from '../recording/AudioSplitter';
import { updateLinksInVault } from '../utils/LinkUpdater';
import type { VaultLinkUpdateResult } from '../utils/LinkUpdater';
import { delay } from '../utils/TimeUtils';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/Settings';

/**
 * Modal for splitting an audio file into parts of a fixed duration.
 */
export class SplitModal extends Modal {
	private readonly sourceFile: TFile;
	private partMinutes: number;
	private partSuffix: string;
	private bitrate: number;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;
	/** Whether the split pipeline is currently running. */
	private isSplitting = false;
	/** Progress notice shown when the modal is closed mid-split. */
	private progressNotice: Notice | null = null;

	constructor(app: App, sourceFile: TFile, settings: AudioRecorderSettings) {
		super(app);
		this.sourceFile = sourceFile;
		this.partMinutes = clampSplitMinutes(settings.splitChunkMinutes);
		this.partSuffix = sanitizePartSuffix(settings.splitPartSuffix);
		this.bitrate = settings.bitrate;
		this.deleteSource = settings.deleteSourceAfterSplit;
		this.linkAction = settings.conversionLinkAction;
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

		const suffixSetting = new Setting(contentEl).setName(
			'Part name suffix',
		);
		const updateSuffixExample = (): void => {
			const trimmed = this.partSuffix.trim();
			if (trimmed !== '' && !SPLIT_PART_SUFFIX_PATTERN.test(trimmed)) {
				// Keep the last valid example; the red border already
				// marks the input as invalid
				return;
			}
			const example =
				trimmed === '' ? DEFAULT_SPLIT_PART_SUFFIX : trimmed;
			suffixSetting.setDesc(
				`Appended with the part number, e.g. "${this.sourceFile.basename}-${example}1.${this.getTargetExtension()}".`,
			);
		};
		updateSuffixExample();
		suffixSetting.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SPLIT_PART_SUFFIX)
				.setValue(this.partSuffix)
				.onChange((value) => {
					this.partSuffix = value;
					// Mirror resolvePartSuffix: surrounding whitespace
					// is ignored and empty means the default suffix
					const trimmed = value.trim();
					text.inputEl.toggleClass(
						'aar-input-invalid',
						trimmed !== '' &&
							!SPLIT_PART_SUFFIX_PATTERN.test(trimmed),
					);
					updateSuffixExample();
				}),
		);

		if (this.sourceFile.extension.toLowerCase() !== FORMAT_WAV) {
			this.bitrate = addBitrateSetting(contentEl, {
				desc: 'Bitrate used when re-encoding parts of compressed formats.',
				initialBitrate: this.bitrate,
				onChange: (bitrate) => {
					this.bitrate = bitrate;
				},
			});
		}

		addDeleteSourceSetting(contentEl, {
			desc: 'Remove the original file after a successful split.',
			initialValue: this.deleteSource,
			onChange: (value) => {
				this.deleteSource = value;
			},
		});

		addLinkActionSetting(contentEl, {
			desc: 'How to handle links to the source file. Links in note bodies across the whole vault are updated; links in frontmatter properties are not.',
			initialValue: this.linkAction,
			onChange: (value) => {
				this.linkAction = value;
			},
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
		if (this.isSplitting && !this.progressNotice) {
			// Timeout 0 keeps the notice visible until hidden explicitly;
			// setProgress mirrors further pipeline progress into it
			this.progressNotice = new Notice(
				`Splitting "${this.sourceFile.name}" continues in the background...`,
				0,
			);
		}
		this.contentEl.empty();
	}

	/**
	 * Shows pipeline progress in the modal and mirrors it to the
	 * background notice when the modal was closed mid-split.
	 * @param progressEl - Progress element inside the modal
	 * @param text - Progress text; an empty string clears the element
	 */
	private setProgress(progressEl: HTMLElement, text: string): void {
		progressEl.setText(text);
		if (this.progressNotice && text !== '') {
			this.progressNotice.setMessage(
				`Splitting "${this.sourceFile.name}": ${text}`,
			);
		}
	}

	/**
	 * Resolves the extension the part files will get: WAV sources stay
	 * WAV; compressed sources keep their format when an offline encoder
	 * exists and fall back to WAV otherwise.
	 * @returns Part file extension without the dot
	 */
	private getTargetExtension(): string {
		const sourceExtension = this.sourceFile.extension.toLowerCase();
		if (
			sourceExtension === FORMAT_WAV ||
			!isOfflineEncodingSupported(sourceExtension)
		) {
			return FORMAT_WAV;
		}
		return sourceExtension;
	}

	/**
	 * Resolves the effective part suffix from the text field. An empty
	 * field means the default suffix (shown as the placeholder); an
	 * invalid value aborts the split with an explanation instead of
	 * being silently replaced.
	 * @returns The suffix to use, or null when the input is invalid
	 */
	private resolvePartSuffix(): string | null {
		const suffix = this.partSuffix.trim();
		if (suffix === '') {
			return DEFAULT_SPLIT_PART_SUFFIX;
		}
		if (!SPLIT_PART_SUFFIX_PATTERN.test(suffix)) {
			new Notice(SPLIT_PART_SUFFIX_RULE_TEXT);
			return null;
		}
		return suffix;
	}

	/**
	 * Executes the split pipeline: prepare parts, pre-check collisions,
	 * write part files, update links, optionally delete the source.
	 * Failures before any part is written abort the whole split;
	 * failures after that are reported as partial success, because the
	 * part files already exist on disk and a repeated run would abort
	 * on the collision pre-check.
	 */
	private async runSplit(progressEl: HTMLElement): Promise<void> {
		this.isSplitting = true;
		try {
			const suffix = this.resolvePartSuffix();
			if (suffix === null) {
				this.setProgress(progressEl, '');
				return;
			}
			const partSeconds =
				clampSplitMinutes(this.partMinutes) * SECONDS_PER_MINUTE;

			let partFiles: TFile[];
			let partCount: number;
			let firstPartName: string;
			try {
				this.setProgress(progressEl, 'Reading source file...');
				const sourceBytes = await this.app.vault.adapter.readBinary(
					this.sourceFile.path,
				);

				const parts = await this.preparePartBlobs(
					sourceBytes,
					partSeconds,
					suffix,
					progressEl,
				);
				if (!parts) {
					this.setProgress(progressEl, '');
					return;
				}

				const partNames = parts.map((part) => part.fileName);
				const partPaths = await this.resolvePartPaths(partNames);
				if (!partPaths) {
					this.setProgress(progressEl, '');
					return;
				}

				partFiles = await this.writePartFiles(
					parts,
					partPaths,
					progressEl,
				);
				partCount = parts.length;
				firstPartName = partNames[0];
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				this.setProgress(progressEl, `Error: ${message}`);
				new Notice(`Split failed: ${message}`);
				return;
			}

			// The parts exist on disk from here on
			if (!(await this.finishSplit(progressEl, partFiles))) {
				return;
			}

			this.setProgress(progressEl, '');
			new Notice(
				`Split into ${String(partCount)} parts: ${firstPartName} ...`,
			);
			// Cleared before close() so onClose does not start a
			// background notice for an already finished split
			this.isSplitting = false;
			this.close();
		} finally {
			this.isSplitting = false;
			this.progressNotice?.hide();
			this.progressNotice = null;
		}
	}

	/**
	 * Post-write pipeline steps: updates links and optionally deletes
	 * the source file. The part files already exist, so errors here are
	 * reported as partial success and never as a failed split. The
	 * source file is kept when some links could not be updated, because
	 * deleting it would leave those links broken.
	 * @param progressEl - Progress element inside the modal
	 * @param partFiles - Created part files in write order
	 * @returns True when every requested step succeeded
	 */
	private async finishSplit(
		progressEl: HTMLElement,
		partFiles: TFile[],
	): Promise<boolean> {
		let linkResult: VaultLinkUpdateResult | null = null;
		if (this.linkAction !== 'none') {
			this.setProgress(progressEl, 'Updating links...');
			try {
				linkResult = await updateLinksInVault(
					this.app,
					this.sourceFile,
					partFiles,
					this.linkAction,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				this.setProgress(progressEl, `Error: ${message}`);
				new Notice(
					`Parts were created, but updating links failed: ${message}. The source file was kept.`,
				);
				return false;
			}
			if (linkResult.frontmatterReferences > 0) {
				new Notice(
					`${String(linkResult.frontmatterReferences)} frontmatter link(s) still point to the source file: properties cannot hold several links.`,
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
						`Parts were created, but the source file could not be deleted: ${message}`,
					);
					return false;
				}
			}
		}
		return true;
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
		suffix: string,
		progressEl: HTMLElement,
	): Promise<
		{ fileName: string; data: () => Promise<ArrayBuffer> }[] | null
	> {
		const baseName = this.sourceFile.basename;
		const sourceExtension = this.sourceFile.extension.toLowerCase();

		if (sourceExtension === FORMAT_WAV) {
			const layout = parseWavLayout(sourceBytes);
			if (layout) {
				const partBytes = computeWavPartBytes(layout, partSeconds);
				if (partBytes <= 0 || layout.dataLength <= partBytes) {
					new Notice('File is shorter than one part.');
					return null;
				}
				const partCount = computePartCount(
					layout.dataLength,
					partBytes,
				);
				return Array.from({ length: partCount }, (_, index) => ({
					fileName: buildPartFileName(
						baseName,
						suffix,
						index + 1,
						FORMAT_WAV,
					),
					// Built lazily inside data() so at most one part
					// buffer is alive at a time while writing files that
					// can be gigabytes in size
					data: () =>
						Promise.resolve(
							buildWavPart(sourceBytes, layout, partBytes, index),
						),
				}));
			}
			// Non-raw WAV (compressed codec inside): fall through to decode
		}

		this.setProgress(progressEl, 'Decoding audio...');
		const audioBuffer = await decodeAudioBlob(sourceBytes);
		const partSamples = partSeconds * audioBuffer.sampleRate;
		if (audioBuffer.length <= partSamples) {
			new Notice('File is shorter than one part.');
			return null;
		}

		const targetFormat = this.getTargetExtension();
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
	 * @returns The created part files in write order
	 */
	private async writePartFiles(
		parts: { fileName: string; data: () => Promise<ArrayBuffer> }[],
		partPaths: string[],
		progressEl: HTMLElement,
	): Promise<TFile[]> {
		const written: { path: string; file: TFile | null }[] = [];
		try {
			for (let i = 0; i < parts.length; i++) {
				this.setProgress(
					progressEl,
					`Writing part ${String(i + 1)} of ${String(parts.length)}...`,
				);
				const bytes = await parts[i].data();
				const created = await this.app.vault.createBinary(
					partPaths[i],
					bytes,
				);
				written.push({
					path: partPaths[i],
					file: created instanceof TFile ? created : null,
				});
				// Yield to the UI between parts so the progress text repaints
				await delay(0);
			}
		} catch (error) {
			for (const part of written) {
				try {
					if (part.file) {
						// trashFile respects the user's file deletion
						// preference and keeps the rollback recoverable
						await this.app.fileManager.trashFile(part.file);
					} else {
						await this.app.vault.adapter.remove(part.path);
					}
				} catch (cleanupError) {
					console.error(
						`${PLUGIN_LOG_PREFIX} Failed to remove part after split error:`,
						{ path: part.path, cleanupError },
					);
				}
			}
			throw error;
		}
		return written.flatMap((part) => (part.file ? [part.file] : []));
	}
}
