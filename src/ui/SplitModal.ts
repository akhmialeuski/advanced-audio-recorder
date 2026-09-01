/**
 * Modal dialog for splitting an audio file into time-based parts.
 * WAV files are split losslessly at the byte level; compressed formats
 * are decoded once and re-encoded per part.
 * @module ui/SplitModal
 */

import { App, Notice, Setting, TFile } from 'obsidian';
import { PluginModal } from './PluginModal';
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
	addNumberInputTo,
} from '../settings/settingControls';
import {
	clampSplitMinutes,
	sanitizePartSuffix,
	SplitService,
} from '../recording/api';
import type {
	AudioRecorderSettings,
	ConversionLinkAction,
} from '../settings/settingsSchema';
import type { ChapterCut } from '../recording/SplitService';
import { chapters, type PlayerMarker } from '../markers/markerModel';
import { PLUGIN_LOG_PREFIX } from '../constants';

/**
 * Modal for splitting an audio file into parts of a fixed duration.
 */
export class SplitModal extends PluginModal {
	private readonly sourceFile: TFile;
	private partMinutes: number;
	private partSuffix: string;
	private bitrate: number;
	private deleteSource: boolean;
	private linkAction: ConversionLinkAction;
	/**
	 * Cut at the recording's chapter boundaries rather than every N minutes.
	 * Offered only when the recording has chapters to cut at.
	 */
	private byChapters = false;
	/** The recording's chapters, loaded when the dialog opens. */
	private chapterCuts: ChapterCut[] = [];
	/** Whether the split pipeline is currently running. */
	private isSplitting = false;
	/** Progress notice shown when the modal is closed mid-split. */
	private progressNotice: Notice | null = null;
	/** Split pipeline behind the form. */
	private readonly splitService: SplitService;

	constructor(
		app: App,
		sourceFile: TFile,
		getSettings: () => AudioRecorderSettings,
		/**
		 * Where the recording's chapters are read from. Absent, the dialog
		 * offers a fixed-length split only, exactly as it did before.
		 */
		private readonly markers?: {
			getMarkers(path: string): Promise<PlayerMarker[]>;
		},
	) {
		super(app);
		const settings = getSettings();
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

		const durationSetting = new Setting(contentEl)
			.setName('Part duration')
			.setDesc('Length of each part in minutes.');
		addNumberInputTo(durationSetting, {
			min: MIN_SPLIT_CHUNK_MINUTES,
			max: MAX_SPLIT_CHUNK_MINUTES,
			step: 1,
			get: () => this.partMinutes,
			set: (value) => {
				this.partMinutes = value;
			},
		});

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

		// Offered only once the recording is known to have chapters: a toggle
		// that cuts at nothing is worse than no toggle.
		const chapterSetting = new Setting(contentEl)
			.setName('Cut at chapters')
			.setDesc('Loading the recording chapters...');
		chapterSetting.settingEl.toggle(false);
		void this.loadChapters(chapterSetting, [
			durationSetting,
			suffixSetting,
		]);

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

	/**
	 * Reads the recording's chapters and, when it has any, offers to cut at
	 * them. Loaded rather than assumed: the sidecar read is asynchronous, and
	 * the dialog is worth showing before it answers.
	 * @param setting - The row the toggle goes in
	 * @param hideWhenByChapters - Rows that mean nothing for a chapter split
	 */
	private async loadChapters(
		setting: Setting,
		hideWhenByChapters: readonly Setting[],
	): Promise<void> {
		const markers = await this.readMarkers();
		this.chapterCuts = chapters(markers).map((chapter) => ({
			startSeconds: chapter.time,
			title: chapter.label,
		}));
		if (this.chapterCuts.length === 0) {
			return;
		}
		setting.setDesc(
			`Cut the recording at its ${String(this.chapterCuts.length)} chapters instead of every few minutes. Each part is named after its chapter.`,
		);
		setting.addToggle((toggle) => {
			toggle.setValue(this.byChapters).onChange((value) => {
				this.byChapters = value;
				// A chapter split has no fixed length and names its parts
				// after the chapters, so neither row applies to it.
				for (const row of hideWhenByChapters) {
					row.settingEl.toggle(!value);
				}
			});
		});
		setting.settingEl.toggle(true);
	}

	/**
	 * The recording's markers, or none when they cannot be read. A sidecar
	 * that will not open is a reason to offer no chapter split, never a
	 * reason to fail the dialog.
	 * @returns The markers, or an empty list
	 */
	private async readMarkers(): Promise<PlayerMarker[]> {
		if (!this.markers) {
			return [];
		}
		try {
			return await this.markers.getMarkers(this.sourceFile.path);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the chapters of ${this.sourceFile.path}:`,
				error,
			);
			return [];
		}
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
					...(this.byChapters ? { cuts: this.chapterCuts } : {}),
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
