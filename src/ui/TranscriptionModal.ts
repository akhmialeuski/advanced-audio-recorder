/**
 * Modal that runs transcription for an audio file, showing progress and
 * allowing cancellation. Output destination, provider, and formatting are
 * taken from settings (configured in the settings tab).
 * @module ui/TranscriptionModal
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import {
	TRANSCRIPTION_PROVIDER_LABELS,
	type AudioRecorderSettings,
} from '../settings/Settings';
import { transcribeFile } from '../transcription/runTranscription';
import {
	TranscriptionCancelledError,
	type CancellationToken,
} from '../transcription/TranscriptionService';

/**
 * Transcription dialog for a single audio file.
 */
export class TranscriptionModal extends Modal {
	private cancelled = false;
	private running = false;
	private statusEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private runButton: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly getSettings: () => AudioRecorderSettings,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Transcribe audio').setHeading();
		contentEl.createEl('p', {
			text: `Source: ${this.file.name}`,
		});

		const settings = this.getSettings();
		contentEl.createEl('p', {
			cls: 'aar-transcribe-config',
			text:
				`Engine: ${TRANSCRIPTION_PROVIDER_LABELS[settings.transcriptionProvider]}` +
				` · Language: ${settings.transcriptionLanguage}` +
				` · Output: ${settings.transcriptDestination}` +
				(settings.llmPostProcessEnabled
					? ` · LLM: ${settings.llmPostProcessTask}`
					: ''),
		});

		this.statusEl = contentEl.createDiv({ cls: 'aar-transcribe-status' });
		this.statusEl.setText('Ready.');
		const progress = contentEl.createDiv({
			cls: 'aar-transcribe-progress',
		});
		this.progressFillEl = progress.createDiv({
			cls: 'aar-transcribe-progress-bar',
		});

		new Setting(contentEl)
			.addButton((button) => {
				this.runButton = button.buttonEl;
				button
					.setButtonText('Transcribe')
					.setCta()
					.onClick(() => {
						void this.startRun();
					});
			})
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					if (this.running) {
						this.cancelled = true;
					} else {
						this.close();
					}
				}),
			);
	}

	/**
	 * Runs the transcription, updating progress and handling errors.
	 */
	private async startRun(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		this.cancelled = false;
		this.runButton?.setAttr('disabled', 'true');
		const token: CancellationToken = { isCancelled: () => this.cancelled };
		const notePath = this.app.workspace.getActiveFile()?.path ?? '';
		try {
			await transcribeFile(this.app, this.getSettings, this.file, {
				notePathForLinks: notePath,
				token,
				onProgress: (fraction, label) => {
					this.updateProgress(fraction, label);
				},
			});
			this.close();
		} catch (error) {
			if (error instanceof TranscriptionCancelledError) {
				new Notice('Transcription cancelled.');
				this.statusEl?.setText('Cancelled.');
			} else {
				const message =
					error instanceof Error ? error.message : String(error);
				new Notice(`Transcription failed: ${message}`);
				this.statusEl?.setText(`Failed: ${message}`);
			}
		} finally {
			this.running = false;
			this.runButton?.removeAttribute('disabled');
		}
	}

	/**
	 * Updates the progress bar and status label.
	 */
	private updateProgress(fraction: number, label: string): void {
		this.statusEl?.setText(label);
		if (this.progressFillEl) {
			const percent = Math.round(
				Math.max(0, Math.min(1, fraction)) * 100,
			);
			this.progressFillEl.style.width = `${String(percent)}%`;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
