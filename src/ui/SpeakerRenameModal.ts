/**
 * Manual dialog that replaces the diarized labels of one recording
 * ("Speaker 1" -> "Alex") with participant names. The speaker roster lives in
 * the recording's sidecar transcript section - labels with their assigned
 * names prefilled - and renames are applied to the outputs the sidecar
 * recorded, with the render templates each output was written with. A
 * recording without a stored roster (transcribed before the roster existed,
 * or never diarized) has nothing to rename until it is transcribed with
 * diarization. A participant profile feeds the input suggestions, applied
 * mappings are kept in the sidecar history so the last rename can be undone,
 * merging two speakers into one name is rejected for now, and a note without
 * timecode links is only touched after the user opts in.
 * @module ui/SpeakerRenameModal
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App, DropdownComponent, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	findSpeakerProfile,
} from '../settings/speakerProfiles';
import type {
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import {
	duplicateAssignedNames,
	type SpeakerNameEntry,
	type SpeakerRename,
} from '../speakers/speakerRename';
import {
	applySpeakerRenamesWithSidecar,
	hasUnscopableRecordedNote,
	type SpeakerRenameApplyResult,
} from '../speakers/applySpeakerRenames';
import { ParticipantSuggest } from './ParticipantSuggest';

/**
 * The slice of the recording sidecar store the dialog needs: read the
 * transcript section, write the roster's names back, and append to the
 * rename history. Structural so tests can stub it.
 */
export interface SpeakerRenameSidecarAccess {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/** Replaces the speaker roster for a recording path. */
	setSpeakers(path: string, entries: readonly SpeakerEntry[]): Promise<void>;
	/** Appends an applied name mapping to the rename history. */
	pushHistory(path: string, names: Record<string, string>): Promise<void>;
}

/** Collaborators the dialog needs, injected by the action registry. */
export interface SpeakerRenameModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Persists settings after a profile was created or extended. */
	saveSettings: () => Promise<void>;
	/** Recording sidecar access: the roster and outputs to rename. */
	sidecar: SpeakerRenameSidecarAccess;
}

/**
 * Speaker naming dialog for a single recording.
 */
export class SpeakerRenameModal extends Modal {
	/**
	 * The recording's sidecar transcript section, loaded on open; null until
	 * the async load runs (or after it failed).
	 */
	private section: TranscriptSection | null = null;
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
	 * Loads the stored roster and builds the dialog: a profile picker plus one
	 * name field per speaker (prefilled with the stored name, when any), or an
	 * explanation when no roster is stored - the recording has to be
	 * transcribed with diarization first (recordings transcribed before the
	 * roster existed need one new transcription).
	 */
	private async render(): Promise<void> {
		const settings = this.options.getSettings();
		this.section = await this.loadSection();
		const roster = this.section?.speakers ?? [];
		const { contentEl } = this;
		contentEl.empty();
		this.inputs.clear();
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${this.file.name}`,
		});

		if (roster.length === 0) {
			contentEl.createEl('p', {
				text:
					'No speakers are stored for this recording. Transcribe ' +
					'it with speaker diarization first; a recording ' +
					'transcribed before speaker names were stored needs one ' +
					'new transcription.',
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

		for (const { label, name } of roster) {
			new Setting(contentEl)
				.setName(label)
				.setDesc('Leave empty to keep the original label.')
				.addText((text) => {
					text.setPlaceholder(label);
					if (name) {
						text.setValue(name);
					}
					this.inputs.set(label, text.inputEl);
					new ParticipantSuggest(this.app, text.inputEl, () =>
						this.suggestionPool(),
					);
				});
		}

		if (
			this.section &&
			hasUnscopableRecordedNote(this.app, this.file, this.section)
		) {
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
		if (this.section && this.section.history.length > 0) {
			const undoButton = actions.createEl('button', {
				text: 'Undo last rename',
			});
			undoButton.addEventListener('click', () => {
				void this.undo();
			});
		}
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	/**
	 * Reads the recording's sidecar transcript section. Any failure logs and
	 * degrades to the empty state rather than crashing the dialog.
	 */
	private async loadSection(): Promise<TranscriptSection | null> {
		try {
			return await this.options.sidecar.getTranscript(this.file.path);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the sidecar roster for ${this.file.path}:`,
				error,
			);
			return null;
		}
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
	 * Validates the entered names, adds them to the selected profile, persists
	 * the new mapping (roster + history) in the sidecar, and rewrites the
	 * recorded outputs. Reports what changed.
	 */
	private async apply(): Promise<void> {
		const section = this.section;
		if (!section || this.applying) {
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
			await this.rememberNames(entries);

			const storedNames = new Map(
				section.speakers
					.filter((entry) => entry.name)
					.map((entry) => [entry.label, entry.name ?? '']),
			);
			const renames: SpeakerRename[] = [];
			const nextEntries: SpeakerEntry[] = [];
			const nextNames: Record<string, string> = {};
			for (const entry of entries) {
				const typed = entry.name.trim();
				const name = typed && typed !== entry.label ? typed : '';
				nextEntries.push(
					name
						? { label: entry.label, name }
						: { label: entry.label },
				);
				if (name) {
					nextNames[entry.label] = name;
				}
				// The rename goes from what the outputs currently show (the
				// stored name, or the label while unnamed) to the new effective
				// name; a cleared field reverts the speaker to its label.
				const from = storedNames.get(entry.label) ?? entry.label;
				const to = name || entry.label;
				if (from !== to) {
					renames.push({ from, to });
				}
			}
			if (renames.length === 0) {
				new Notice('No speaker names to change.');
				this.close();
				return;
			}
			await this.options.sidecar.setSpeakers(this.file.path, nextEntries);
			await this.options.sidecar.pushHistory(this.file.path, nextNames);
			const applied = await applySpeakerRenamesWithSidecar(
				this.app,
				this.file,
				section,
				renames,
				{ allowBroad: this.allowBroad },
			);
			console.debug(
				`${PLUGIN_LOG_PREFIX} Renamed speakers: ` +
					this.describeCounts(applied),
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
	 * Reverts the last applied rename: the roster returns to the mapping
	 * before it (the second-newest history entry, or no names at all when the
	 * history holds a single apply), the outputs are rewritten through the
	 * same sidecar path, and the reverted state is recorded as a new history
	 * entry.
	 */
	private async undo(): Promise<void> {
		const section = this.section;
		if (!section || this.applying) {
			return;
		}
		this.applying = true;
		try {
			const previous =
				section.history.length >= 2
					? (section.history[section.history.length - 2]?.names ?? {})
					: {};
			const renames: SpeakerRename[] = [];
			const nextEntries: SpeakerEntry[] = [];
			const nextNames: Record<string, string> = {};
			for (const entry of section.speakers) {
				const target = previous[entry.label];
				const name = target && target !== entry.label ? target : '';
				nextEntries.push(
					name
						? { label: entry.label, name }
						: { label: entry.label },
				);
				if (name) {
					nextNames[entry.label] = name;
				}
				const from = entry.name ?? entry.label;
				const to = name || entry.label;
				if (from !== to) {
					renames.push({ from, to });
				}
			}
			if (renames.length === 0) {
				new Notice('Nothing to undo: the names are already the same.');
				return;
			}
			await this.options.sidecar.setSpeakers(this.file.path, nextEntries);
			await this.options.sidecar.pushHistory(this.file.path, nextNames);
			const applied = await applySpeakerRenamesWithSidecar(
				this.app,
				this.file,
				section,
				renames,
				{ allowBroad: this.allowBroad },
			);
			new Notice(this.describeOutcome(applied));
			this.close();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			new Notice(`Failed to undo the rename: ${message}`);
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

	/** One-line count summary for the debug log. */
	private describeCounts(applied: SpeakerRenameApplyResult): string {
		return (
			`${String(applied.updatedNotes)} note(s) and ` +
			`${String(applied.updatedTranscriptFiles)} transcript file(s) ` +
			`updated, ${String(applied.skippedLlmNotes)} LLM-processed ` +
			`note(s) skipped, ${String(applied.missingOutputs)} recorded ` +
			`output(s) missing, ${String(applied.failed)} failed`
		);
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
		const llmSkipped =
			applied.skippedLlmNotes > 0
				? ` ${String(applied.skippedLlmNotes)} note(s) were ` +
					'post-processed by an LLM and were not updated.'
				: '';
		if (targets.length === 0) {
			return `No matching speaker labels were found to rename.${llmSkipped}${failed}`;
		}
		return `Renamed speakers in ${targets.join(' and ')}.${llmSkipped}${failed}`;
	}

	override onClose(): void {
		this.contentEl.empty();
		this.inputs.clear();
	}
}
