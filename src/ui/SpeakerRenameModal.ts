/**
 * Modal that assigns display names to the speakers of a diarized
 * recording ("Speaker 1" -> "Alex"). The roster comes from the recording's
 * speaker sidecar (written by the last diarized transcription), one text
 * input per speaker with suggestions from the per-vault participant
 * registry. Applying persists the mapping to the sidecar, rewrites the
 * transcript outputs that already exist (notes and JSON/SRT/VTT/TXT
 * sidecar files), and adds new names to the registry so they are
 * suggested for the next recording.
 * @module ui/SpeakerRenameModal
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { SpeakerNameStore } from '../speakers/SpeakerNameStore';
import {
	addParticipants,
	parseParticipants,
	speakerRenames,
	type SpeakerNames,
} from '../speakers/speakerNameModel';
import {
	applySpeakerRenamesToVault,
	type SpeakerRenameApplyResult,
} from '../speakers/applySpeakerRenames';
import { ParticipantSuggest } from './ParticipantSuggest';

/** Collaborators the dialog needs, injected by the action registry. */
export interface SpeakerRenameModalOptions {
	/** Speaker-name persistence shared with transcription and the player. */
	store: SpeakerNameStore;
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Persists settings after the participant registry gained new names. */
	saveSettings: () => Promise<void>;
}

/**
 * Speaker naming dialog for a single recording.
 */
export class SpeakerRenameModal extends Modal {
	/** Sidecar state loaded on open; null until the async load finishes. */
	private stored: SpeakerNames | null = null;
	/** Name input per original speaker label, in roster order. */
	private readonly inputs = new Map<string, HTMLInputElement>();
	private applying = false;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly options: SpeakerRenameModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle('Rename speakers');
		void this.render();
	}

	/**
	 * Loads the sidecar and builds the dialog: one name field per detected
	 * speaker, or an explanation when the recording has no speaker roster
	 * yet.
	 */
	private async render(): Promise<void> {
		const stored = await this.options.store.get(this.file.path);
		this.stored = stored;
		const { contentEl } = this;
		contentEl.empty();
		this.inputs.clear();
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${this.file.name}`,
		});

		if (stored.speakers.length === 0) {
			contentEl.createEl('p', {
				text:
					'No speakers are recorded for this audio file yet. ' +
					'Transcribe it with speaker diarization first.',
			});
			const actions = contentEl.createDiv({
				cls: 'modal-button-container',
			});
			const closeButton = actions.createEl('button', { text: 'Close' });
			closeButton.addEventListener('click', () => {
				this.close();
			});
			return;
		}

		for (const label of stored.speakers) {
			new Setting(contentEl)
				.setName(label)
				.setDesc('Leave empty to keep the original label.')
				.addText((text) => {
					text.setValue(stored.names[label] ?? '').setPlaceholder(
						label,
					);
					this.inputs.set(label, text.inputEl);
					new ParticipantSuggest(this.app, text.inputEl, () =>
						this.participantPool(),
					);
				});
		}

		const actions = contentEl.createDiv({ cls: 'modal-button-container' });
		const applyButton = actions.createEl('button', {
			cls: 'mod-cta',
			text: 'Apply',
		});
		applyButton.addEventListener('click', () => {
			void this.apply();
		});
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	/**
	 * Names offered by the input suggestions: the per-vault participant
	 * registry plus any names already stored for this recording.
	 */
	private participantPool(): string[] {
		const settings = this.options.getSettings();
		const pool = parseParticipants(settings.transcriptionParticipants);
		const known = new Set(pool);
		for (const name of Object.values(this.stored?.names ?? {})) {
			if (!known.has(name)) {
				known.add(name);
				pool.push(name);
			}
		}
		return pool;
	}

	/**
	 * Persists the entered names, rewrites existing outputs (notes and
	 * transcript sidecar files), and records new names in the participant
	 * registry. Reports what was updated in a notice.
	 */
	private async apply(): Promise<void> {
		const stored = this.stored;
		if (!stored || this.applying) {
			return;
		}
		this.applying = true;
		try {
			const names: Record<string, string> = {};
			for (const [label, input] of this.inputs) {
				const value = input.value.trim();
				// An empty or identity value reverts to the original label.
				if (value && value !== label) {
					names[label] = value;
				}
			}
			const next: SpeakerNames = { speakers: stored.speakers, names };
			const renames = speakerRenames(stored, next);
			await this.options.store.set(this.file.path, next);

			const settings = this.options.getSettings();
			let applied: SpeakerRenameApplyResult = {
				updatedNotes: 0,
				updatedTranscriptFiles: 0,
			};
			if (renames.length > 0) {
				applied = await applySpeakerRenamesToVault(
					this.app,
					this.file,
					renames,
					settings.transcriptSpeakerFormat,
				);
			}

			// Names applied here become suggestions for the next recording.
			const registry = addParticipants(
				settings.transcriptionParticipants,
				Object.values(names),
			);
			if (registry !== settings.transcriptionParticipants) {
				settings.transcriptionParticipants = registry;
				await this.options.saveSettings();
			}

			new Notice(this.describeOutcome(renames.length, applied));
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Failed to rename speakers: ${message}`);
		} finally {
			this.applying = false;
		}
	}

	/**
	 * Builds the outcome notice: what was saved and how many existing
	 * outputs were rewritten.
	 * @param renameCount - Number of display-name changes
	 * @param applied - Counts of rewritten notes and transcript files
	 */
	private describeOutcome(
		renameCount: number,
		applied: SpeakerRenameApplyResult,
	): string {
		if (renameCount === 0) {
			return 'Speaker names saved.';
		}
		const targets: string[] = [];
		if (applied.updatedNotes > 0) {
			const plural = applied.updatedNotes > 1 ? 's' : '';
			targets.push(`${String(applied.updatedNotes)} note${plural}`);
		}
		if (applied.updatedTranscriptFiles > 0) {
			const plural = applied.updatedTranscriptFiles > 1 ? 's' : '';
			targets.push(
				`${String(applied.updatedTranscriptFiles)} transcript file${plural}`,
			);
		}
		if (targets.length === 0) {
			return 'Speaker names saved. They will apply to the next transcription.';
		}
		return `Speaker names saved; updated ${targets.join(' and ')}.`;
	}

	override onClose(): void {
		this.contentEl.empty();
		this.inputs.clear();
	}
}
