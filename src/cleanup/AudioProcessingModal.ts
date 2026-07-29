/**
 * On-demand audio cleanup dialog: pick which DSP stages to apply
 * (high-pass, noise gate, loudness leveling) and process the file into a
 * cleaned WAV copy. Defaults come from settings; each run can override
 * them. Opened from the context menu.
 * @module cleanup/AudioProcessingModal
 */

import { App, ButtonComponent, Notice, Setting, TFile } from 'obsidian';
import { PluginModal } from '../ui/PluginModal';
import { addStageRowTo } from '../settings/settingControls';
import {
	MIN_CLEANUP_HIGHPASS_HZ,
	MAX_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_GATE_THRESHOLD_DB,
	MAX_CLEANUP_GATE_THRESHOLD_DB,
	MIN_CLEANUP_LEVELING_MAKEUP_DB,
	MAX_CLEANUP_LEVELING_MAKEUP_DB,
	CLEANUP_HIGHPASS_STEP_HZ,
	CLEANUP_GATE_STEP_DB,
	CLEANUP_LEVELING_STEP_DB,
	PLUGIN_LOG_PREFIX,
} from '../constants';
import { AudioProcessingService } from './AudioProcessingService';
import {
	hasActiveChange,
	resolveAudioDspConfig,
	type AudioDspConfig,
} from './audioDsp';
import {
	CHANNEL_MODES,
	normalizeChannelMode,
	type ChannelMode,
} from '../audio/downmix';
import type { AudioRecorderSettings } from '../settings/settingsSchema';

/**
 * Audio-cleanup dialog for a single file.
 */
export class AudioProcessingModal extends PluginModal {
	private readonly config: AudioDspConfig;
	private deleteSource = false;

	/**
	 * @param app - Obsidian app handle
	 * @param file - Source audio file to clean up
	 * @param getSettings - Returns plugin settings (seed the default stage
	 *   config). A live accessor rather than a snapshot, so every dialog reads
	 *   settings the same way.
	 * @param onProcessed - Called after a successful write, before the source is
	 *   trashed, so a caller can link the result into the note while the source
	 *   embed still resolves. `replaceSource` mirrors the delete-source choice.
	 */
	constructor(
		app: App,
		private readonly file: TFile,
		getSettings: () => AudioRecorderSettings,
		private readonly onProcessed?: (result: {
			outputPath: string;
			replaceSource: boolean;
		}) => void | Promise<void>,
	) {
		super(app);
		this.config = resolveAudioDspConfig(getSettings());
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setDialogTitle('Clean up audio');
		this.renderSource(this.file);
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: 'Produces a processed WAV copy next to the source.',
		});

		addStageRowTo(contentEl, {
			name: 'High-pass filter',
			desc: 'Remove low-frequency rumble below the cutoff (Hz).',
			getEnabled: () => this.config.highPass.enabled,
			setEnabled: (v) => {
				this.config.highPass.enabled = v;
			},
			value: {
				min: MIN_CLEANUP_HIGHPASS_HZ,
				max: MAX_CLEANUP_HIGHPASS_HZ,
				step: CLEANUP_HIGHPASS_STEP_HZ,
				get: () => this.config.highPass.hz,
				set: (v) => {
					this.config.highPass.hz = v;
				},
			},
		});
		addStageRowTo(contentEl, {
			name: 'Noise gate',
			desc: 'Silence the signal below the threshold (dBFS).',
			getEnabled: () => this.config.gate.enabled,
			setEnabled: (v) => {
				this.config.gate.enabled = v;
			},
			value: {
				min: MIN_CLEANUP_GATE_THRESHOLD_DB,
				max: MAX_CLEANUP_GATE_THRESHOLD_DB,
				step: CLEANUP_GATE_STEP_DB,
				get: () => this.config.gate.thresholdDb,
				set: (v) => {
					this.config.gate.thresholdDb = v;
				},
			},
		});
		addStageRowTo(contentEl, {
			name: 'Loudness leveling',
			desc: 'Even out quiet and loud passages; makeup gain (dB).',
			getEnabled: () => this.config.leveling.enabled,
			setEnabled: (v) => {
				this.config.leveling.enabled = v;
			},
			value: {
				min: MIN_CLEANUP_LEVELING_MAKEUP_DB,
				max: MAX_CLEANUP_LEVELING_MAKEUP_DB,
				step: CLEANUP_LEVELING_STEP_DB,
				get: () => this.config.leveling.makeupDb,
				set: (v) => {
					this.config.leveling.makeupDb = v;
				},
			},
		});

		new Setting(contentEl)
			.setName('Channels')
			.setDesc(
				'Keep the source channel layout, or downmix the cleaned copy to mono. The left/right options keep one channel at full level - useful when only one channel carries audio.',
			)
			.addDropdown((dropdown) => {
				const labels: Record<ChannelMode, string> = {
					source: 'Same as source',
					'mono-mix': 'Mono (mix all channels)',
					'mono-left': 'Mono (left channel)',
					'mono-right': 'Mono (right channel)',
				};
				CHANNEL_MODES.forEach((mode) => {
					dropdown.addOption(mode, labels[mode]);
				});
				dropdown.setValue(this.config.channelMode);
				dropdown.onChange((value) => {
					this.config.channelMode = normalizeChannelMode(value);
				});
			});

		new Setting(contentEl)
			.setName('Delete source after processing')
			.addToggle((toggle) =>
				toggle.setValue(this.deleteSource).onChange((v) => {
					this.deleteSource = v;
				}),
			);

		const status = contentEl.createDiv({ cls: 'aar-modal-status' });
		let processButton: ButtonComponent | null = null;
		this.renderActions(
			{
				text: 'Process',
				cta: true,
				ref: (button) => {
					processButton = button;
				},
				onClick: async () => {
					// The ref runs while the row is built, so the button always
					// exists by the time a click can reach this.
					if (processButton) {
						await this.run(status, processButton);
					}
				},
			},
			{
				text: 'Cancel',
				onClick: () => {
					this.close();
				},
			},
		);
	}

	/**
	 * Runs the processing pipeline and writes the cleaned file.
	 */
	private async run(
		status: HTMLElement,
		button: ButtonComponent,
	): Promise<void> {
		if (!hasActiveChange(this.config)) {
			new Notice(
				'Enable at least one processing stage, or choose a mono channel option.',
			);
			return;
		}
		await this.runExclusive(async () => {
			button.setDisabled(true);
			status.setText('Processing...');
			// Yield once so the "Processing..." label paints before the
			// synchronous decode/gate work briefly occupies the main thread.
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			try {
				const service = new AudioProcessingService(this.app);
				const outputPath = await service.process(
					this.file,
					this.config,
				);
				// Link the result into the note before the source is trashed, so the
				// source embed still resolves when it is matched and replaced. A
				// failure here is non-fatal: the processed file is already written.
				if (this.onProcessed) {
					try {
						await this.onProcessed({
							outputPath,
							replaceSource: this.deleteSource,
						});
					} catch (linkError) {
						console.warn(
							`${PLUGIN_LOG_PREFIX} Failed to link the processed file into the note:`,
							linkError,
						);
					}
				}
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
				button.setDisabled(false);
			}
		});
	}
}
