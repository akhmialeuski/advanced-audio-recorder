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
 * kept in the sidecar history so the last rename can be undone, giving two
 * speakers the same name merges them (diarization routinely splits one person
 * into two labels) behind one confirmation, since already-written text cannot
 * be split again afterwards, and a note without timecode links is only touched
 * after the user opts in.
 * @module ui/SpeakerRenameModal
 */

import { Notice, Setting } from 'obsidian';
import type { App, ButtonComponent, DropdownComponent, TFile } from 'obsidian';
import { confirmAction } from './ConfirmModal';
import { PluginModal } from './PluginModal';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import {
	addProfile,
	createProfile,
	effectiveProfileId,
	findProfile,
	profileNameRejection,
	ProfileKindId,
	profilesOfKind,
} from '../settings/profiles';
import {
	readProfileNotes,
	type ProfileNotesRead,
} from '../settings/ProfileNoteStore';
import { ProfileTextSource } from '../settings/ProfileTextSource';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { participantsOf } from '../settings/profileResolution';
import type {
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import { mergeParticipantNames } from '../speakers/participantRoster';
import { speakerPreviewRange } from '../speakers/speakerPreview';
import type { SpeakerMerge, SpeakerNameEntry } from '../speakers/speakerRename';
import { hasUnscopableRecordedNote } from '../speakers/applySpeakerRenames';
import {
	applySpeakerNames,
	describeMerges,
	readSpeakerSection,
	undoSpeakerRename,
	type SpeakerRenameDeps,
	type SpeakerRenameSidecarAccess,
} from '../speakers/speakerRenameFlow';
import { showNotice } from '../utils/notify';
import { formatTimecode } from '../utils/TimeUtils';
import { TextInputSuggest } from './TextInputSuggest';
import { errorMessage } from '../errors';

/** Value the profile dropdown uses for "the recording's own roster". */
const RECORDING_ROSTER_OPTION = '';

export type { SpeakerRenameSidecarAccess } from '../speakers/speakerRenameFlow';

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
	/**
	 * The settings the suggestions read participant profiles from, with every
	 * roster kept in a note read as the dialog is drawn, so a name added to the
	 * note a moment ago is suggested, and the rosters whose note could not be
	 * read, which the picker names. The settings the dialog was built with,
	 * with nothing unread, until the first draw reads them.
	 */
	private rosterNotes: ProfileNotesRead;
	/** Whether to rewrite notes that carry no timecode links to scope by. */
	private allowBroad = false;
	private profileDropdown: DropdownComponent | null = null;
	/**
	 * Rewrites the picker's description for the profile now picked. Held so a
	 * profile created in the dialog is described without rebuilding it.
	 */
	private describeProfilePick: (() => void) | null = null;
	private newProfileInput: HTMLInputElement | null = null;
	/** Plays a speaker's first turn; created lazily on the first preview. */
	private preview: SpeakerPreviewPlayer | null = null;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly options: SpeakerRenameModalOptions,
	) {
		super(app);
		this.rosterNotes = {
			settings: options.getSettings(),
			unread: new Set(),
		};
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
		const read = await readSpeakerSection(
			this.options.sidecar,
			this.file.path,
		);
		this.section = typeof read === 'string' ? null : read;
		this.rosterNotes = await readProfileNotes(
			this.app,
			settings,
			profilesOfKind(settings.profiles, ProfileKindId.Participants).map(
				(profile) => profile.id,
			),
		);
		const section = this.section;
		const { contentEl } = this;
		contentEl.empty();
		this.stopPreview();
		this.inputs.clear();
		this.previewButtons.clear();
		this.renderSource(this.file);

		// An unreadable sidecar is not an empty one: the stored names may be
		// intact on disk, so do not tell the user to re-transcribe.
		if (read === 'unreadable') {
			this.renderEmptyState(
				'The sidecar file of this recording could not be read, ' +
					'so its stored speaker data is unreachable. Restore or ' +
					'remove the .markers.json file next to the recording ' +
					'(writes to it are paused to protect it), then reopen ' +
					'this dialog.',
			);
			return;
		}

		if (!section) {
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
			profilesOfKind(settings.profiles, ProfileKindId.Participants),
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
		const suggests = `This recording suggests ${
			stored > 0
				? `${String(stored)} stored name${stored > 1 ? 's' : ''}`
				: 'no names yet'
		}. Pick a profile to add its names to the suggestions; every name you apply is saved to both.`;
		const picker = new Setting(this.contentEl)
			.setName('Participant profile')
			.addDropdown((dropdown) => {
				dropdown.addOption(RECORDING_ROSTER_OPTION, 'This recording');
				for (const profile of profilesOfKind(
					settings.profiles,
					ProfileKindId.Participants,
				)) {
					dropdown.addOption(profile.id, profile.name);
				}
				dropdown.setValue(this.selectedProfileId);
				dropdown.onChange((value) => {
					this.selectedProfileId = value;
					this.describeProfilePick?.();
				});
				this.profileDropdown = dropdown;
			});
		// Rewritten in place on every pick: rebuilding the dialog would drop
		// the names already typed into it.
		const profileText = new ProfileTextSource(
			this.app.vault,
			this.rosterNotes.unread,
		);
		this.describeProfilePick = (): void => {
			picker.setDesc(
				profileText.describe(
					suggests,
					findProfile(
						profilesOfKind(
							this.options.getSettings().profiles,
							ProfileKindId.Participants,
						),
						this.selectedProfileId,
					),
				),
			);
		};
		this.describeProfilePick();
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
			participantsOf(this.rosterNotes.settings, this.selectedProfileId),
		);
	}

	/**
	 * Creates a participant profile from the inline name field, selects it, and
	 * adds it to the picker without rebuilding the dialog (so typed names are
	 * kept).
	 */
	private async createProfile(): Promise<void> {
		const name = this.newProfileInput?.value.trim() ?? '';
		const settings = this.options.getSettings();
		// The same rule the settings catalogue applies: a profile is a page
		// addressed by its name, so a roster created here may no more repeat a
		// name than one created there.
		const rejection = profileNameRejection(
			settings.profiles,
			ProfileKindId.Participants,
			'',
			name,
		);
		if (rejection) {
			// A blank field is someone who has not typed yet, not a mistake to
			// report; a name already taken is.
			if (name !== '') {
				new Notice(rejection);
			}
			return;
		}
		const created = createProfile(ProfileKindId.Participants, name);
		settings.profiles = addProfile(settings.profiles, created);
		await this.options.saveSettings();
		this.selectedProfileId = created.id;
		this.profileDropdown?.addOption(created.id, created.name);
		this.profileDropdown?.setValue(created.id);
		this.describeProfilePick?.();
		if (this.newProfileInput) {
			this.newProfileInput.value = '';
		}
		new Notice(`Profile "${created.name}" created.`);
	}

	/** What a rename reaches, as the flow takes it. */
	private renameDeps(): SpeakerRenameDeps {
		return {
			app: this.app,
			file: this.file,
			sidecar: this.options.sidecar,
			getSettings: this.options.getSettings,
			saveSettings: this.options.saveSettings,
			notify: showNotice,
		};
	}

	/**
	 * Applies the names typed into the rows, asking before a merge. A refusal
	 * leaves the dialog open on the names typed, so they can be corrected.
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
				const outcome = await applySpeakerNames(
					this.renameDeps(),
					section,
					{
						entries,
						allowBroad: this.allowBroad,
						profileId: this.selectedProfileId,
						confirmMerges: (merges) => this.confirmMerge(merges),
						broadOptInHint:
							'turn on "Rename in notes without timecodes" and ' +
							'apply again to rewrite them.',
					},
				);
				if (outcome.kind === 'declined') {
					return;
				}
				new Notice(outcome.message);
				if (outcome.kind === 'refused') {
					return;
				}
				if (outcome.kind === 'applied') {
					console.debug(
						`${PLUGIN_LOG_PREFIX} Renamed speakers: ${outcome.counts}`,
					);
				}
				this.close();
			} catch (error) {
				const message = errorMessage(error);
				new Notice(`Failed to rename speakers: ${message}`);
			}
		});
	}

	/** Reverts the last applied rename and closes. */
	private async undo(): Promise<void> {
		const section = this.section;
		if (!section) {
			return;
		}
		await this.runExclusive(async () => {
			try {
				new Notice(
					await undoSpeakerRename(
						this.renameDeps(),
						section,
						this.allowBroad,
					),
				);
				this.close();
			} catch (error) {
				const message = errorMessage(error);
				new Notice(`Failed to undo the rename: ${message}`);
			}
		});
	}

	/**
	 * Asks before a merge is written into the outputs. Giving two diarized
	 * labels one name is a supported and often necessary fix - engines split
	 * one person across labels - but it is the single step this dialog cannot
	 * walk back: once both speakers render as the same text, nothing in a note
	 * or a transcript file says which of them a line belonged to, so undo and
	 * every later rename can only leave those lines alone. Only a merge the
	 * stored roster does not already carry is asked about, so re-applying or
	 * healing an existing one never nags.
	 * @param merges - The merges this apply would newly create
	 * @returns True when the user confirmed, false when they backed out
	 */
	private confirmMerge(merges: readonly SpeakerMerge[]): Promise<boolean> {
		return confirmAction(this.app, {
			title: 'Merge speakers?',
			message:
				`${describeMerges(merges)}. Their lines become one speaker in every ` +
				'output. This cannot be undone: merged lines are the same ' +
				'text afterwards, so nothing can tell them apart again - ' +
				'only a new transcription restores separate labels.',
			confirmText: 'Merge',
		});
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
