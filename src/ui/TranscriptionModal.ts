/**
 * Modal that configures and runs transcription for a single audio file.
 * The per-run options (engine, language, diarization, destination, file
 * format, in-note toggles, and LLM post-processing) default from settings
 * and can be overridden here for this run only — the saved settings are
 * never mutated. Shows progress and allows cancellation; the detailed
 * in-note templates (heading, timestamp/speaker/line format) remain in the
 * settings tab and are applied as configured there.
 * @module ui/TranscriptionModal
 */

import { MarkdownView, Modal, Notice, Setting } from 'obsidian';
import type { App, ButtonComponent, TFile } from 'obsidian';
import {
	LLM_TASK_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
	type AudioRecorderSettings,
	type TranscriptionProviderId,
} from '../settings/Settings';
import type {
	TranscriptDestination,
	TranscriptFileFormat,
} from '../transcription/TranscriptTypes';
import type { LlmTask } from '../transcription/llmPostProcess';
import {
	addDropdown,
	addText,
	addToggle,
	type SettingsSectionContext,
} from '../settings/settingControls';
import { transcribeFile } from '../transcription/runTranscription';
import { effectiveTranscriptDestination } from '../transcription/transcriptOutput';
import {
	TranscriptionCancelledError,
	type CancellationToken,
} from '../transcription/TranscriptionService';
import type { SaveProgress } from '../types';

/**
 * Callbacks used when the modal is minimized while transcription continues.
 */
export type TranscriptionBackgroundProgressCallbacks = {
	/** Shows or updates the status-bar progress entry. */
	show: (progress: SaveProgress, restore: () => void) => void;
	/** Removes the status-bar progress entry owned by this modal. */
	clear: () => void;
};

/**
 * Options for a transcription modal instance.
 */
export type TranscriptionModalOptions = {
	autoStart?: boolean;
	notePath?: string;
	backgroundProgress?: TranscriptionBackgroundProgressCallbacks;
};

/**
 * Transcription dialog for a single audio file.
 */
export class TranscriptionModal extends Modal {
	private cancelled = false;
	private running = false;
	private statusEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private configEl: HTMLElement | null = null;
	private runButton: ButtonComponent | null = null;
	private minimizeButton: ButtonComponent | null = null;
	private secondaryButton: ButtonComponent | null = null;
	private rendered = false;
	private minimized = false;
	private lastProgress: SaveProgress = {
		percent: 0,
		description: 'Transcribing...',
	};
	/** Per-run settings copy: edited here, never persisted to plugin data. */
	private readonly runSettings: AudioRecorderSettings;
	/**
	 * Note the transcript is inserted into and timecode links are built
	 * against — resolved once at construction so the run targets the right
	 * note even if the active pane changes before it starts.
	 */
	private readonly notePath: string;

	constructor(
		app: App,
		private readonly file: TFile,
		getSettings: () => AudioRecorderSettings,
		private readonly options: TranscriptionModalOptions = {},
	) {
		super(app);
		// Shallow copy is enough: every option edited here is a primitive.
		this.runSettings = { ...getSettings() };
		// Prefer an explicit note (transcribe-on-save passes the note the
		// recording embed was inserted into); otherwise the active Markdown
		// note. When neither exists (e.g. the audio file itself is the active
		// pane, as with the command), in-note insertion cannot work, so an
		// in-note-only destination is downgraded to a file up front instead of
		// always falling back with a misleading "could not insert" notice.
		this.notePath =
			this.options.notePath ??
			app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ??
			'';
		this.runSettings.transcriptDestination = effectiveTranscriptDestination(
			this.runSettings.transcriptDestination,
			this.notePath !== '',
		);
	}

	onOpen(): void {
		if (this.rendered) {
			this.minimized = false;
			this.clearBackgroundProgress();
			return;
		}

		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Transcribe audio').setHeading();
		contentEl.createEl('p', {
			cls: 'aar-transcribe-config',
			text: `Source: ${this.file.name}`,
		});

		this.configEl = contentEl.createDiv({ cls: 'aar-transcribe-options' });
		this.renderConfig();

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
				this.runButton = button;
				button
					.setButtonText('Transcribe')
					.setCta()
					.onClick(() => {
						void this.startRun();
					});
			})
			.addButton((button) => {
				this.minimizeButton = button;
				button
					.setButtonText('Minimize')
					.setDisabled(true)
					.onClick(() => {
						this.minimize();
					});
			})
			.addButton((button) => {
				this.secondaryButton = button;
				button.setButtonText('Close').onClick(() => {
					if (this.running) {
						this.cancelled = true;
					} else {
						this.close();
					}
				});
			});

		this.rendered = true;

		if (this.options.autoStart) {
			// Auto-run for the transcribe-on-save hook: the modal still shows
			// progress and offers cancel, so an automatic run stays visible and
			// interruptible instead of being a silent background job.
			void this.startRun();
		}
	}

	/**
	 * Renders the editable per-run option controls into the config container.
	 * Re-invoked when an option that reveals or hides others changes.
	 */
	private renderConfig(): void {
		const container = this.configEl;
		if (!container) {
			return;
		}
		container.empty();
		const s = this.runSettings;
		const ctx: SettingsSectionContext = {
			containerEl: container,
			settings: s,
			// Per-run dialog: options are not persisted to plugin data.
			save: () => Promise.resolve(),
			rerender: () => {
				this.renderConfig();
			},
			saveDebounced: () => {
				/* no debounced persistence in the dialog */
			},
		};

		addDropdown(ctx, {
			name: 'Engine',
			options: TRANSCRIPTION_PROVIDER_OPTIONS,
			get: () => s.transcriptionProvider,
			set: (v) =>
				(s.transcriptionProvider = v as TranscriptionProviderId),
		});
		addText(ctx, {
			name: 'Language',
			desc: 'ISO code (e.g. en, ru, es) or "auto" to detect.',
			get: () => s.transcriptionLanguage,
			set: (v) => (s.transcriptionLanguage = v.trim() || 'auto'),
		});
		addToggle(ctx, {
			name: 'Speaker diarization',
			desc: 'Request speaker labels (providers detect the speaker count automatically).',
			get: () => s.transcriptionDiarize,
			set: (v) => (s.transcriptionDiarize = v),
		});
		addToggle(ctx, {
			name: 'Word-level timestamps',
			desc: 'Request per-word timing (recorded in JSON file output only).',
			get: () => s.transcriptionWordTimestamps,
			set: (v) => (s.transcriptionWordTimestamps = v),
		});

		addDropdown(ctx, {
			name: 'Destination',
			options: TRANSCRIPT_DESTINATION_OPTIONS,
			get: () => s.transcriptDestination,
			set: (v) => (s.transcriptDestination = v as TranscriptDestination),
			rerender: true,
		});
		if (s.transcriptDestination !== 'note') {
			addDropdown(ctx, {
				name: 'File format',
				options: TRANSCRIPT_FILE_FORMAT_OPTIONS,
				get: () => s.transcriptFileFormat,
				set: (v) =>
					(s.transcriptFileFormat = v as TranscriptFileFormat),
			});
		}
		// In-note formatting applies only when the transcript Markdown is
		// rendered into the note (note/both). For file/link only the sidecar
		// file is produced, so these toggles would have no effect.
		if (
			s.transcriptDestination === 'note' ||
			s.transcriptDestination === 'both'
		) {
			addToggle(ctx, {
				name: 'Include timestamps',
				get: () => s.transcriptIncludeTimestamps,
				set: (v) => (s.transcriptIncludeTimestamps = v),
			});
			addToggle(ctx, {
				name: 'Include speakers',
				get: () => s.transcriptIncludeSpeakers,
				set: (v) => (s.transcriptIncludeSpeakers = v),
			});
		}

		addToggle(ctx, {
			name: 'LLM post-processing',
			desc: 'Clean up, summarize, or apply a custom instruction with an LLM.',
			get: () => s.llmPostProcessEnabled,
			set: (v) => (s.llmPostProcessEnabled = v),
			rerender: true,
		});
		if (s.llmPostProcessEnabled) {
			// Only the task is per-run here; the LLM provider, endpoint, key,
			// and model stay in settings (a key cannot be entered safely in a
			// transient dialog), so switching providers belongs in the tab.
			addDropdown(ctx, {
				name: 'LLM task',
				options: LLM_TASK_OPTIONS,
				get: () => s.llmPostProcessTask,
				set: (v) => (s.llmPostProcessTask = v as LlmTask),
			});
		}
	}

	/**
	 * Runs the transcription, updating progress and handling errors.
	 */
	private async startRun(): Promise<void> {
		if (this.running) {
			return;
		}
		this.setRunning(true);
		this.updateProgress(0, 'Transcribing...');
		// Snapshot the options so a control toggled mid-run cannot change an
		// in-flight job; edits only affect the next attempt after a failure.
		const settings = { ...this.runSettings };
		const token: CancellationToken = { isCancelled: () => this.cancelled };
		try {
			await transcribeFile(this.app, () => settings, this.file, {
				notePathForLinks: this.notePath,
				token,
				onProgress: (fraction, label) => {
					this.updateProgress(fraction, label);
				},
			});
			this.setRunning(false);
			this.clearBackgroundProgress();
			if (this.minimized) {
				this.minimized = false;
				this.contentEl.empty();
				this.rendered = false;
			} else {
				this.close();
			}
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
			if (this.minimized) {
				this.restore();
			}
		} finally {
			if (this.running) {
				this.setRunning(false);
			}
			this.clearBackgroundProgress();
		}
	}

	/**
	 * Toggles the running state: disables the config and run button while a
	 * job is in flight and switches the secondary button between cancel and
	 * close.
	 * @param running - Whether a transcription is in progress
	 */
	private setRunning(running: boolean): void {
		this.running = running;
		if (running) {
			this.cancelled = false;
		}
		this.runButton?.setDisabled(running);
		this.minimizeButton?.setDisabled(!running);
		this.secondaryButton?.setButtonText(running ? 'Cancel' : 'Close');
		this.configEl?.toggleClass('aar-transcribe-options-disabled', running);
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
			this.lastProgress = { percent, description: label };
			this.progressFillEl.setCssProps({
				'--aar-transcribe-progress': `${String(percent)}%`,
			});
			this.reportBackgroundProgress();
		}
	}

	/**
	 * Minimizes the modal while keeping the current transcription running.
	 */
	private minimize(): void {
		if (!this.running || this.minimized) {
			return;
		}
		this.minimized = true;
		this.reportBackgroundProgress();
		this.close();
	}

	/**
	 * Restores a minimized modal.
	 */
	private restore(): void {
		if (!this.minimized) {
			return;
		}
		this.minimized = false;
		this.clearBackgroundProgress();
		this.open();
	}

	/**
	 * Publishes the latest progress to the status bar while minimized.
	 */
	private reportBackgroundProgress(): void {
		if (!this.minimized) {
			return;
		}
		this.options.backgroundProgress?.show(this.lastProgress, () => {
			this.restore();
		});
	}

	/**
	 * Clears this modal's background progress entry.
	 */
	private clearBackgroundProgress(): void {
		this.options.backgroundProgress?.clear();
	}

	onClose(): void {
		if (this.minimized && this.running) {
			return;
		}
		if (this.running) {
			this.cancelled = true;
		}
		this.clearBackgroundProgress();
		this.contentEl.empty();
		this.rendered = false;
	}
}
