/**
 * Manual dialog that replaces the diarized labels of one recording
 * ("Speaker 1" -> "Alex") with participant names. It reads the current
 * speakers straight out of the recording's existing transcript outputs (no
 * stored state), offers a participant profile whose names feed the input
 * suggestions, and on apply rewrites only this recording's transcript: the
 * lines in referencing notes whose timecode link resolves to this audio, plus
 * the transcript sidecar files next to it. Merging two speakers into one name
 * is rejected for now, and a note without timecode links is only touched after
 * the user opts in.
 * @module ui/SpeakerRenameModal
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App, DropdownComponent, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	findSpeakerProfile,
} from '../settings/speakerProfiles';
import {
	buildSpeakerRenames,
	duplicateAssignedNames,
	type SpeakerNameEntry,
} from '../speakers/speakerRename';
import {
	applySpeakerRenamesToVault,
	inspectAudioTranscript,
	type AudioTranscriptInspection,
	type SpeakerRenameApplyResult,
} from '../speakers/applySpeakerRenames';
import { ParticipantSuggest } from './ParticipantSuggest';

/** Collaborators the dialog needs, injected by the action registry. */
export interface SpeakerRenameModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Persists settings after a profile was created or extended. */
	saveSettings: () => Promise<void>;
}

/**
 * Speaker naming dialog for a single recording.
 */
export class SpeakerRenameModal extends Modal {
	/** Transcript inspection loaded on open; null until the async load runs. */
	private inspection: AudioTranscriptInspection | null = null;
	/** Name input per detected speaker, in roster order. */
	private readonly inputs = new Map<string, HTMLInputElement>();
	/** Id of the participant profile feeding suggestions ('' means none). */
	private selectedProfileId = '';
	/** Whether to rewrite notes that carry no timecode links to scope by. */
	private allowBroad = false;
	private applying = false;
	private profileDropdown: DropdownComponent | null = null;
	private newProfileInput: HTMLInputElement | null = null;

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
	 * Reads the recording's current speakers and builds the dialog: a profile
	 * picker plus one name field per speaker, or an explanation when the
	 * recording has no diarized transcript to rename.
	 */
	private async render(): Promise<void> {
		const settings = this.options.getSettings();
		const inspection = await inspectAudioTranscript(this.app, this.file, {
			lineFormat: settings.transcriptLineFormat,
			speakerFormat: settings.transcriptSpeakerFormat,
			includeTimestamps: settings.transcriptIncludeTimestamps,
		});
		this.inspection = inspection;
		const { contentEl } = this;
		contentEl.empty();
		this.inputs.clear();
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${this.file.name}`,
		});

		if (inspection.roster.length === 0) {
			contentEl.createEl('p', {
				text:
					'No speakers were found in this recording transcript. ' +
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

		this.renderProfilePicker(settings);

		for (const label of inspection.roster) {
			new Setting(contentEl)
				.setName(label)
				.setDesc('Leave empty to keep the original label.')
				.addText((text) => {
					text.setPlaceholder(label);
					this.inputs.set(label, text.inputEl);
					new ParticipantSuggest(this.app, text.inputEl, () =>
						this.suggestionPool(),
					);
				});
		}

		if (inspection.hasUnscopableNote) {
			new Setting(contentEl)
				.setName('Rename in notes without timecodes')
				.setDesc(
					'A transcript here has no timecode links to identify this ' +
						'recording, so enabling this rewrites every matching ' +
						'label in those notes.',
				)
				.addToggle((toggle) => {
					toggle
						.setValue(this.allowBroad)
						.onChange((value) => (this.allowBroad = value));
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
	 * Renders the participant-profile picker and the inline profile creator.
	 * The chosen profile's names feed the per-speaker input suggestions.
	 * @param settings - Current plugin settings
	 */
	private renderProfilePicker(settings: AudioRecorderSettings): void {
		new Setting(this.contentEl)
			.setName('Participant profile')
			.setDesc(
				'Suggests names as you type; applied names are added to it.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'None');
				for (const profile of settings.transcriptionSpeakerProfiles) {
					dropdown.addOption(profile.id, profile.name);
				}
				dropdown.setValue(this.selectedProfileId);
				dropdown.onChange((value) => (this.selectedProfileId = value));
				this.profileDropdown = dropdown;
			});
		new Setting(this.contentEl)
			.setName('New profile')
			.addText((text) => {
				text.setPlaceholder('Profile name');
				this.newProfileInput = text.inputEl;
			})
			.addButton((button) => {
				button.setButtonText('Create').onClick(() => {
					void this.createProfile();
				});
			});
	}

	/**
	 * Names offered by the input suggestions: the participants of the selected
	 * profile, or none when "None" is picked.
	 */
	private suggestionPool(): string[] {
		const settings = this.options.getSettings();
		return (
			findSpeakerProfile(
				settings.transcriptionSpeakerProfiles,
				this.selectedProfileId,
			)?.participants ?? []
		);
	}

	/**
	 * Creates a participant profile from the inline name field, selects it, and
	 * adds it to the picker without rebuilding the dialog (so typed names are
	 * kept).
	 */
	private async createProfile(): Promise<void> {
		const name = this.newProfileInput?.value.trim() ?? '';
		if (!name) {
			return;
		}
		const settings = this.options.getSettings();
		const profiles = addSpeakerProfile(
			settings.transcriptionSpeakerProfiles,
			name,
		);
		const created = profiles[profiles.length - 1];
		if (!created) {
			return;
		}
		settings.transcriptionSpeakerProfiles = profiles;
		await this.options.saveSettings();
		this.selectedProfileId = created.id;
		this.profileDropdown?.addOption(created.id, created.name);
		this.profileDropdown?.setValue(created.id);
		if (this.newProfileInput) {
			this.newProfileInput.value = '';
		}
		new Notice(`Profile "${created.name}" created.`);
	}

	/**
	 * Validates the entered names, adds them to the selected profile, and
	 * rewrites the recording's existing outputs. Reports what changed.
	 */
	private async apply(): Promise<void> {
		if (!this.inspection || this.applying) {
			return;
		}
		this.applying = true;
		try {
			const entries: SpeakerNameEntry[] = [];
			for (const [label, input] of this.inputs) {
				entries.push({ label, name: input.value });
			}
			const duplicates = duplicateAssignedNames(entries);
			if (duplicates.length > 0) {
				new Notice(
					`Two speakers cannot share a name (${duplicates.join(
						', ',
					)}). Give each a distinct name.`,
				);
				return;
			}
			const renames = buildSpeakerRenames(entries);
			await this.rememberNames(entries);

			if (renames.length === 0) {
				new Notice('No speaker names to change.');
				this.close();
				return;
			}

			const settings = this.options.getSettings();
			const applied = await applySpeakerRenamesToVault(
				this.app,
				this.file,
				renames,
				settings.transcriptSpeakerFormat,
				{ allowBroad: this.allowBroad },
			);
			new Notice(this.describeOutcome(applied));
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
	 * Adds the entered names to the selected profile so they are suggested next
	 * time. A no-op when no profile is selected or nothing new was entered.
	 * @param entries - The dialog's per-speaker entries
	 */
	private async rememberNames(
		entries: readonly SpeakerNameEntry[],
	): Promise<void> {
		if (!this.selectedProfileId) {
			return;
		}
		const names = entries
			.map((entry) => entry.name.trim())
			.filter((name) => name.length > 0);
		if (names.length === 0) {
			return;
		}
		const settings = this.options.getSettings();
		const profiles = addParticipantsToProfile(
			settings.transcriptionSpeakerProfiles,
			this.selectedProfileId,
			names,
		);
		if (profiles !== settings.transcriptionSpeakerProfiles) {
			settings.transcriptionSpeakerProfiles = profiles;
			await this.options.saveSettings();
		}
	}

	/**
	 * Builds the outcome notice from what the rename actually touched.
	 * @param applied - Counts of rewritten notes and files
	 */
	private describeOutcome(applied: SpeakerRenameApplyResult): string {
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
		const failed =
			applied.failed > 0
				? ` ${String(applied.failed)} output${
						applied.failed > 1 ? 's' : ''
					} could not be updated.`
				: '';
		if (targets.length === 0) {
			return `No matching speaker labels were found to rename.${failed}`;
		}
		return `Renamed speakers in ${targets.join(' and ')}.${failed}`;
	}

	override onClose(): void {
		this.contentEl.empty();
		this.inputs.clear();
	}
}
