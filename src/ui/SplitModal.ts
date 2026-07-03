/**
 * Modal dialog for splitting an audio file into time-based parts.
 * WAV files are split losslessly at the byte level; compressed formats
 * are decoded once and re-encoded per part.
 * @module ui/SplitModal
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import {
	FORMAT_WAV,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	DEFAULT_SPLIT_PART_SUFFIX,
	SECONDS_PER_MINUTE,
	SPLIT_PART_SUFFIX_PATTERN,
	SPLIT_PART_SUFFIX_RULE_TEXT,
} from '../constants';
import {
	addBitrateSetting,
	addDeleteSourceSetting,
	addLinkActionSetting,
} from './settingHelpers';
import {
	clampSplitMinutes,
	sanitizePartSuffix,
	SplitService,
} from '../recording/api';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/settingsSchema';

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
	/** Split pipeline behind the form. */
	private readonly splitService: SplitService;

	constructor(app: App, sourceFile: TFile, settings: AudioRecorderSettings) {
		super(app);
		this.splitService = new SplitService(app);
		this.sourceFile = sourceFile;
		this.partMinutes = clampSplitMinutes(settings.splitChunkMinutes);
		this.partSuffix = sanitizePartSuffix(settings.splitPartSuffix);
		this.bitrate = settings.bitrate;
		this.deleteSource = settings.deleteSourceAfterSplit;
		this.linkAction = settings.conversionLinkAction;
	}

	override onOpen(): void {
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

	override onClose(): void {
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
	 * Resolves the extension the part files will get.
	 * @returns Part file extension without the dot
	 */
	private getTargetExtension(): string {
		return this.splitService.getTargetExtension(this.sourceFile);
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
	 * Runs the split pipeline for the configured form values. Failure
	 * details are surfaced by the pipeline itself; the form only shows
	 * the completion notice and closes.
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

			const outcome = await this.splitService.split(
				{
					sourceFile: this.sourceFile,
					partSeconds,
					suffix,
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
			new Notice(
				`Split into ${String(outcome.partCount)} parts: ${outcome.firstPartName} ...`,
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
}
