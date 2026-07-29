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

import { Notice, Setting } from 'obsidian';
import type { App, DropdownComponent, TFile } from 'obsidian';
import { PluginModal } from './PluginModal';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	participantsOf,
} from '../settings/speakerProfiles';
import type {
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import {
	duplicateAssignedNames,
	planSpeakerRename,
	type SpeakerNameEntry,
} from '../speakers/speakerRename';
import {
	applySpeakerRenamesWithSidecar,
	hasUnscopableRecordedNote,
	type SpeakerRenameApplyResult,
} from '../speakers/applySpeakerRenames';
import { TextInputSuggest } from './TextInputSuggest';

/**
 * The slice of the recording sidecar store the dialog needs: read the
 * transcript section, write the roster's names back, and append to the
 * rename history. Structural so tests can stub it.
 */
export interface SpeakerRenameSidecarAccess {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/** Whether the sidecar file exists but could not be read (after a read). */
	isSidecarCorrupt(path: string): boolean;
	/**
	 * Commits an applied rename atomically: roster and history entry in one
	 * write, so neither can ever be persisted without the other.
	 */
	commitRename(
		path: string,
		entries: readonly SpeakerEntry[],
		names: Record<string, string>,
	): Promise<void>;
	/** Replaces the speaker roster for a recording path (undo). */
	setSpeakers(path: string, entries: readonly SpeakerEntry[]): Promise<void>;
	/** Removes the newest history entry (an undo consumed it). */
	popHistory(path: string): Promise<void>;
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
export class SpeakerRenameModal extends PluginModal {
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
		this.setDialogTitle('Rename speakers');
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
		const section = this.section;
		const { contentEl } = this;
		contentEl.empty();
		this.inputs.clear();
		this.renderSource(this.file);

		// An unreadable sidecar is not an empty one: the stored names may be
		// intact on disk, so do not tell the user to re-transcribe.
		if (this.options.sidecar.isSidecarCorrupt(this.file.path)) {
			this.renderEmptyState(
				'The sidecar file of this recording could not be read, ' +
					'so its stored speaker data is unreachable. Restore or ' +
					'remove the .markers.json file next to the recording ' +
					'(writes to it are paused to protect it), then reopen ' +
					'this dialog.',
			);
			return;
		}

		if (!section || section.speakers.length === 0) {
			this.renderEmptyState(
				'No speakers are stored for this recording. Transcribe ' +
					'it with speaker diarization first; a recording ' +
					'transcribed before speaker names were stored needs one ' +
					'new transcription.',
			);
			return;
		}

		this.renderProfilePicker(settings);

		for (const { label, name } of section.speakers) {
			new Setting(contentEl)
				.setName(label)
				.setDesc('Leave empty to keep the original label.')
				.addText((text) => {
					text.setPlaceholder(label);
					if (name) {
						text.setValue(name);
					}
					this.inputs.set(label, text.inputEl);
					new TextInputSuggest(this.app, text.inputEl, () =>
						this.suggestionPool(),
					);
				});
		}

		if (hasUnscopableRecordedNote(this.app, this.file, section)) {
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

		this.renderActions(
			{ text: 'Apply', cta: true, onClick: () => this.apply() },
			...(section.history.length > 0
				? [{ text: 'Undo last rename', onClick: () => this.undo() }]
				: []),
			{
				text: 'Cancel',
				onClick: () => {
					this.close();
				},
			},
		);
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
		return participantsOf(
			this.options.getSettings(),
			this.selectedProfileId,
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
	 * Validates the entered names, plans the rename against the stored
	 * roster, rewrites the recorded outputs, and only then commits the new
	 * roster and history - so the sidecar never asserts names the outputs
	 * were not even attempted with. The plan's replacements also target the
	 * original engine labels, healing outputs an earlier rewrite missed.
	 */
	private async apply(): Promise<void> {
		const section = this.section;
		if (!section) {
			return;
		}
		await this.runExclusive(async () => {
			try {
				const entries: SpeakerNameEntry[] = [];
				for (const [label, input] of this.inputs) {
					entries.push({ label, name: input.value });
				}
				const duplicates = duplicateAssignedNames(entries);
				if (duplicates.length > 0) {
					// Naming a speaker after another speaker's engine label is a
					// distinct mistake (it would make their lines textually
					// indistinguishable forever), so it gets its own explanation
					// instead of the generic shared-name message.
					const labels = new Set(entries.map((entry) => entry.label));
					const labelCollisions = duplicates.filter((name) =>
						labels.has(name),
					);
					new Notice(
						labelCollisions.length > 0
							? `A name cannot equal another speaker's label ` +
									`(${labelCollisions.join(', ')}): their lines ` +
									'would become indistinguishable in the outputs. ' +
									'Give the speakers real, distinct names instead.'
							: `Two speakers cannot share a name (${duplicates.join(
									', ',
								)}). Give each a distinct name.`,
					);
					return;
				}
				const typed = new Map(
					entries.map((entry) => [entry.label, entry.name]),
				);
				const plan = planSpeakerRename(
					section.speakers,
					(label) => typed.get(label) ?? '',
				);
				if (!plan.changed) {
					new Notice('No speaker names to change.');
					this.close();
					return;
				}
				await this.rememberNames(entries);
				const applied = await applySpeakerRenamesWithSidecar(
					this.app,
					this.file,
					section,
					plan.renames,
					{ allowBroad: this.allowBroad },
				);
				// One atomic commit: the roster and its history entry can never
				// be persisted without each other, so the undo baseline always
				// matches what was actually applied.
				await this.options.sidecar.commitRename(
					this.file.path,
					plan.nextEntries,
					plan.nextNames,
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
			}
		});
	}

	/**
	 * Reverts the last applied rename: the roster returns to the assignment
	 * before it (the second-newest history entry, or the bare engine labels
	 * when the history holds a single apply), the outputs are rewritten
	 * through the same plan/apply path, and the undone entry is removed from
	 * the history - so each press walks one step further back and the button
	 * disappears once the history is exhausted, instead of ping-ponging.
	 */
	private async undo(): Promise<void> {
		const section = this.section;
		if (!section) {
			return;
		}
		await this.runExclusive(async () => {
			try {
				const previous =
					section.history.length >= 2
						? (section.history[section.history.length - 2]?.names ??
							{})
						: {};
				const plan = planSpeakerRename(section.speakers, (label) =>
					Object.hasOwn(previous, label)
						? (previous[label] ?? '')
						: '',
				);
				if (plan.changed) {
					const applied = await applySpeakerRenamesWithSidecar(
						this.app,
						this.file,
						section,
						plan.renames,
						{ allowBroad: this.allowBroad },
					);
					await this.options.sidecar.setSpeakers(
						this.file.path,
						plan.nextEntries,
					);
					new Notice(this.describeOutcome(applied));
				} else {
					new Notice(
						'Nothing to undo: the names are already the same.',
					);
				}
				// The undone entry is consumed either way, so the next undo steps
				// further back instead of replaying this one. Unlike apply, the
				// two writes need no atomic commit: if this pop fails after the
				// roster reverted, the next undo finds the roster already equal
				// to the entry's state, plans no change, and only pops - the
				// tear heals itself instead of corrupting the baseline.
				await this.options.sidecar.popHistory(this.file.path);
				this.close();
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				new Notice(`Failed to undo the rename: ${message}`);
			}
		});
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
		// A recorded output whose path no longer resolves (the note or file
		// was renamed or deleted) is skipped; say so instead of reporting an
		// unqualified success, since the next transcription is what re-records
		// the current outputs.
		const missing =
			applied.missingOutputs > 0
				? ` ${String(applied.missingOutputs)} recorded output(s) no ` +
					'longer exist and were skipped; transcribe again to ' +
					'refresh them.'
				: '';
		if (targets.length === 0) {
			return `No speaker labels were rewritten.${llmSkipped}${missing}${failed}`;
		}
		return `Renamed speakers in ${targets.join(' and ')}.${llmSkipped}${missing}${failed}`;
	}

	override onClose(): void {
		super.onClose();
		this.inputs.clear();
	}
}
