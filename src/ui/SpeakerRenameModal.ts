/**
 * Manual dialog that replaces the diarized labels of one recording
 * ("Speaker 1" -> "Alex") with participant names. The speaker roster lives in
 * the recording's sidecar transcript section - labels with their assigned
 * names prefilled - and renames are applied to the outputs the sidecar
 * recorded, with the render templates each output was written with. A
 * recording without a stored roster (transcribed before the roster existed,
 * or never diarized) has nothing to rename until it is transcribed with
 * diarization.
 *
 * Each speaker is one row of three: its label, the name field, and a preview
 * button that plays the stretch where that speaker first talks - the dialog
 * covers the note it was opened over, so identifying a speaker cannot depend on
 * reading the transcript behind it. Name suggestions come from the recording's
 * own participant roster (stored in the same sidecar), optionally widened by a
 * settings profile, and every applied name joins both. Applied mappings are
 * kept in the sidecar history so the last rename can be undone, merging two
 * speakers into one name is rejected for now, and a note without timecode links
 * is only touched after the user opts in.
 * @module ui/SpeakerRenameModal
 */

import { Notice, Setting } from 'obsidian';
import type { App, ButtonComponent, DropdownComponent, TFile } from 'obsidian';
import { PluginModal } from './PluginModal';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import { effectiveProfileId } from '../settings/profiles';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	addParticipantsToProfile,
	addSpeakerProfile,
	participantsOf,
} from '../settings/speakerProfiles';
import type {
	ParticipantUpdate,
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import { mergeParticipantNames } from '../speakers/participantRoster';
import { speakerPreviewRange } from '../speakers/speakerPreview';
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
import { formatTimecode } from '../utils/TimeUtils';
import { TextInputSuggest } from './TextInputSuggest';

/** Value the profile dropdown uses for "the recording's own roster". */
const RECORDING_ROSTER_OPTION = '';

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
	 * Commits an applied rename atomically: roster, history entry, and the
	 * names it added to the recording's participant roster in one write, so
	 * none can ever be persisted without the others.
	 */
	commitRename(
		path: string,
		entries: readonly SpeakerEntry[],
		names: Record<string, string>,
		participants?: ParticipantUpdate,
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
	/** Preview button per detected speaker, so its icon can be flipped. */
	private readonly previewButtons = new Map<string, ButtonComponent>();
	/**
	 * Id of the settings profile widening the suggestions ('' means the
	 * recording's own roster only). Seeded from the sidecar on the first
	 * render, so the profile a transcription ran with re-selects itself.
	 */
	private selectedProfileId = '';
	/** Whether to rewrite notes that carry no timecode links to scope by. */
	private allowBroad = false;
	private profileDropdown: DropdownComponent | null = null;
	private newProfileInput: HTMLInputElement | null = null;
	/** Plays a speaker's first turn; created lazily on the first preview. */
	private preview: SpeakerPreviewPlayer | null = null;

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
	 * row per speaker (its label, the name field prefilled with the stored
	 * name, and the preview button), or an explanation when no roster is stored
	 * - the recording has to be transcribed with diarization first (recordings
	 * transcribed before the roster existed need one new transcription).
	 */
	private async render(): Promise<void> {
		const settings = this.options.getSettings();
		this.section = await this.loadSection();
		const section = this.section;
		const { contentEl } = this;
		contentEl.empty();
		this.stopPreview();
		this.inputs.clear();
		this.previewButtons.clear();
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

		// The profile a transcription recorded re-selects itself, so the names
		// of that meeting are suggested without the user picking anything. A
		// profile deleted since resolves to the recording's own roster.
		this.selectedProfileId = effectiveProfileId(
			settings.transcriptionSpeakerProfiles,
			section.participantProfileId ?? '',
		);
		this.renderProfilePicker(settings, section);

		for (const entry of section.speakers) {
			this.renderSpeakerRow(entry);
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
	 * Renders one speaker's row: the engine label, the name field with its
	 * suggestions, and the preview button. The three sit in one setting row, so
	 * the labels, the fields, and the buttons line up as three columns.
	 * @param entry - The stored roster entry for this speaker
	 */
	private renderSpeakerRow(entry: SpeakerEntry): void {
		const { label, name } = entry;
		const range = speakerPreviewRange(entry);
		new Setting(this.contentEl)
			.setName(label)
			.setDesc(this.rowDescription(entry))
			.addText((text) => {
				text.setPlaceholder(label);
				if (name) {
					text.setValue(name);
				}
				this.inputs.set(label, text.inputEl);
				new TextInputSuggest(this.app, text.inputEl, () =>
					this.suggestionPool(),
				);
			})
			.addButton((button) => {
				button.setIcon('play').setTooltip(
					range
						? `Play where ${label} first speaks`
						: // Rosters written before the offsets existed carry no
							// timings; say what fixes it instead of a dead button.
							'No sample stored for this speaker. Transcribe the ' +
								'recording again with diarization to enable the preview.',
				);
				button.buttonEl.addClass('aar-speaker-preview');
				if (!range) {
					button.setDisabled(true);
					return;
				}
				this.previewButtons.set(label, button);
				button.onClick(() => {
					this.previewPlayer().toggle(label, range);
				});
			});
	}

	/**
	 * The row's help text: where the speaker first talks when the roster stores
	 * it (so the preview button's target is visible without pressing it), plus
	 * the reminder that a blank field keeps the engine label.
	 * @param entry - The stored roster entry for this speaker
	 */
	private rowDescription(entry: SpeakerEntry): string {
		const blank = 'Leave empty to keep the original label.';
		return entry.firstStart === undefined
			? blank
			: `First speaks at ${formatTimecode(entry.firstStart)}. ${blank}`;
	}

	/**
	 * The preview player, created on the first press so a dialog nobody
	 * previews never resolves a media URL or builds an audio element.
	 */
	private previewPlayer(): SpeakerPreviewPlayer {
		const existing = this.preview;
		if (existing) {
			return existing;
		}
		const player = new SpeakerPreviewPlayer(
			() => this.app.vault.getResourcePath(this.file),
			(playingId) => {
				this.refreshPreviewButtons(playingId);
			},
		);
		this.preview = player;
		return player;
	}

	/**
	 * Flips every preview button to match what is playing: the playing row
	 * offers stop, every other row offers play. Driven by the player rather
	 * than by the click, so an excerpt that ends on its own (or is cut short by
	 * a blocked autoplay) leaves no button stuck showing stop.
	 * @param playingId - Label of the speaker being previewed, or null
	 */
	private refreshPreviewButtons(playingId: string | null): void {
		for (const [label, button] of this.previewButtons) {
			const playing = label === playingId;
			button.setIcon(playing ? 'square' : 'play');
			button.setTooltip(
				playing
					? `Stop the ${label} sample`
					: `Play where ${label} first speaks`,
			);
		}
	}

	/** Stops any excerpt in flight (a re-render or a close). */
	private stopPreview(): void {
		this.preview?.stop();
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
	 * The recording's own roster always suggests; a profile picked here widens
	 * the suggestions with its names, and both grow with what is applied.
	 * @param settings - Current plugin settings
	 * @param section - The recording's stored transcript section
	 */
	private renderProfilePicker(
		settings: AudioRecorderSettings,
		section: TranscriptSection,
	): void {
		const stored = section.participants.length;
		new Setting(this.contentEl)
			.setName('Participant profile')
			.setDesc(
				`This recording suggests ${
					stored > 0
						? `${String(stored)} stored name${stored > 1 ? 's' : ''}`
						: 'no names yet'
				}. Pick a profile to add its names to the suggestions; every name you apply is saved to both.`,
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(RECORDING_ROSTER_OPTION, 'This recording');
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
	 * Names offered by the input suggestions: the roster this recording
	 * carries, widened by the selected profile's names. The recording's own
	 * names always come first, so the people actually in this meeting are
	 * suggested ahead of everyone in a broad profile.
	 */
	private suggestionPool(): string[] {
		return mergeParticipantNames(
			this.section?.participants ?? [],
			participantsOf(this.options.getSettings(), this.selectedProfileId),
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
				// One atomic commit: the roster, its history entry, and the
				// names this apply introduced can never be persisted without
				// each other, so the undo baseline always matches what was
				// actually applied. A name that was in neither the recording's
				// roster nor the picked profile joins the recording here (and
				// the profile in rememberNames above), so it is suggested next
				// time from the recording itself.
				await this.options.sidecar.commitRename(
					this.file.path,
					plan.nextEntries,
					plan.nextNames,
					{
						names: Object.values(plan.nextNames),
						profileId: this.selectedProfileId,
					},
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
	 * Adds the entered names to the selected settings profile, so they are
	 * suggested for the next recording that picks it. A no-op when no profile
	 * is selected or nothing new was entered - the recording's own roster grows
	 * either way, in the atomic commit below.
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
		// Released before the maps are dropped, so no excerpt can outlive the
		// dialog that started it.
		this.preview?.dispose();
		this.preview = null;
		this.inputs.clear();
		this.previewButtons.clear();
	}
}
