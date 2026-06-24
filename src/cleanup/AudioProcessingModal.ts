/**
 * On-demand audio cleanup dialog: pick which DSP stages to apply
 * (high-pass, noise gate, loudness leveling) and process the file into a
 * cleaned WAV copy. Defaults come from settings; each run can override
 * them. Opened from the context menu.
 * @module cleanup/AudioProcessingModal
 */

import { App, ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian';
import {
	MIN_INPUT_HIGHPASS_HZ,
	MAX_INPUT_HIGHPASS_HZ,
	MIN_INPUT_GATE_THRESHOLD_DB,
	MAX_INPUT_GATE_THRESHOLD_DB,
	MIN_INPUT_LEVELING_MAKEUP_DB,
	MAX_INPUT_LEVELING_MAKEUP_DB,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import { AudioProcessingService } from './AudioProcessingService';
import {
	hasActiveStage,
	resolveAudioDspConfig,
	type AudioDspConfig,
} from './audioDsp';
import type { AudioRecorderSettings } from '../settings/Settings';

/**
 * Audio-cleanup dialog for a single file.
 */
export class AudioProcessingModal extends Modal {
	private readonly config: AudioDspConfig;
	private deleteSource = false;
	private processing = false;

	constructor(
		app: App,
		private readonly file: TFile,
		settings: AudioRecorderSettings,
	) {
		super(app);
		this.config = resolveAudioDspConfig(settings);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Clean up audio').setHeading();
		contentEl.createEl('p', { text: `Source: ${this.file.name}` });
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: 'Produces a processed WAV copy next to the source.',
		});

		this.addStageWithSlider(
			contentEl,
			'High-pass filter',
			'Remove low-frequency rumble below the cutoff (Hz).',
			this.config.highPass.enabled,
			(v) => (this.config.highPass.enabled = v),
			{
				min: MIN_INPUT_HIGHPASS_HZ,
				max: MAX_INPUT_HIGHPASS_HZ,
				step: 5,
				value: this.config.highPass.hz,
				onChange: (v) => (this.config.highPass.hz = v),
			},
		);
		this.addStageWithSlider(
			contentEl,
			'Noise gate',
			'Silence the signal below the threshold (dBFS).',
			this.config.gate.enabled,
			(v) => (this.config.gate.enabled = v),
			{
				min: MIN_INPUT_GATE_THRESHOLD_DB,
				max: MAX_INPUT_GATE_THRESHOLD_DB,
				step: 1,
				value: this.config.gate.thresholdDb,
				onChange: (v) => (this.config.gate.thresholdDb = v),
			},
		);
		this.addStageWithSlider(
			contentEl,
			'Loudness leveling',
			'Even out quiet and loud passages; makeup gain (dB).',
			this.config.leveling.enabled,
			(v) => (this.config.leveling.enabled = v),
			{
				min: MIN_INPUT_LEVELING_MAKEUP_DB,
				max: MAX_INPUT_LEVELING_MAKEUP_DB,
				step: 1,
				value: this.config.leveling.makeupDb,
				onChange: (v) => (this.config.leveling.makeupDb = v),
			},
		);

		new Setting(contentEl)
			.setName('Delete source after processing')
			.addToggle((toggle) =>
				toggle.setValue(this.deleteSource).onChange((v) => {
					this.deleteSource = v;
				}),
			);

		const status = contentEl.createDiv({ cls: 'aar-modal-status' });
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Process')
					.setCta()
					.onClick(() => {
						void this.run(status, button);
					}),
			)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => this.close()),
			);
	}

	/**
	 * Adds a stage toggle with a parameter slider on the same row.
	 */
	private addStageWithSlider(
		container: HTMLElement,
		name: string,
		desc: string,
		enabled: boolean,
		onToggle: (value: boolean) => void,
		slider: {
			min: number;
			max: number;
			step: number;
			value: number;
			onChange: (value: number) => void;
		},
	): void {
		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addSlider((s) =>
				s
					.setLimits(slider.min, slider.max, slider.step)
					.setValue(slider.value)
					.setDynamicTooltip()
					.onChange(slider.onChange),
			)
			.addToggle((toggle) => toggle.setValue(enabled).onChange(onToggle));
	}

	/**
	 * Runs the processing pipeline and writes the cleaned file.
	 */
	private async run(
		status: HTMLElement,
		button: ButtonComponent,
	): Promise<void> {
		if (this.processing) {
			return;
		}
		if (!hasActiveStage(this.config)) {
			new Notice('Enable at least one processing stage.');
			return;
		}
		this.processing = true;
		button.setDisabled(true);
		status.setText('Processing...');
		// Yield once so the "Processing..." label paints before the
		// synchronous decode/gate work briefly occupies the main thread.
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		try {
			const service = new AudioProcessingService(this.app);
			const outputPath = await service.process(this.file, this.config);
			if (this.deleteSource) {
				try {
					await this.app.fileManager.trashFile(this.file);
				} catch (deleteError) {
					console.warn(
						`${PLUGIN_LOG_PREFIX} Failed to delete source after processing:`,
						deleteError,
					);
					new Notice(
						`Processed audio saved to ${outputPath}, but the source could not be deleted.`,
					);
					this.close();
					return;
				}
			}
			new Notice(`Processed audio saved to ${outputPath}`);
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Audio processing failed: ${message}`);
			status.setText(`Failed: ${message}`);
		} finally {
			this.processing = false;
			button.setDisabled(false);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
