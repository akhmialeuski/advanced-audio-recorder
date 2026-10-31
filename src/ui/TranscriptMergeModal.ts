/**
 * Dialog that merges consecutive rendered transcript lines into one line of
 * one speaker - the reverse of {@link ui/TranscriptSplitModal}. Diarization
 * sometimes cuts one person's turn into several lines, or gives a stretch of
 * it to another speaker, and the note reads more fragmented than the
 * conversation was; the user selects the lines and says here who the merged
 * line belongs to, after listening to the whole passage if need be.
 *
 * Every line is read back with the render templates the recording's sidecar
 * recorded for this note, exactly as the split reads its line, and the merged
 * line is written with the same renderer that wrote the transcript, replacing
 * the lines in the editor (so the merge is undone like any other edit). The
 * recorded transcript files are rewritten from the JSON transcript and a
 * speaker the merge creates joins the roster, by the split's own write; see
 * {@link speakers/applyTranscriptEdit}. Merging more than two lines - which
 * folds several turns into one - is confirmed first.
 * @module ui/TranscriptMergeModal
 */

import { Notice, Setting } from 'obsidian';
import type { App, DropdownComponent, ExtraButtonComponent } from 'obsidian';
import type { TranscriptSelectionContext } from '../actions/transcript/transcriptContext';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import {
	mergedLineText,
	mergeConfirmationMessage,
	mergeNeedsConfirmation,
} from '../speakers/transcriptMerge';
import { formatLineTime, type RowTiming } from '../speakers/transcriptRows';
import { confirmAction } from './ConfirmModal';
import { PluginModal } from './PluginModal';
import {
	fillSpeakerDropdown,
	keptFilesReason,
	pickedChoice,
	quote,
	speakerValue,
	type TranscriptEditModalOptions,
} from './transcriptLineDialog';
import {
	mergeSpeakerOptions,
	performMerge,
	prepareMerge,
	type PreparedMerge,
} from './transcriptLineEdits';
import { isRefusal } from '../utils/refusal';

/** Preview id of the merged passage (the player plays one excerpt at a time). */
const MERGED_PREVIEW_ID = 'merged';

/**
 * Merge dialog for one selection over consecutive transcript lines.
 */
export class TranscriptMergeModal extends PluginModal {
	/** Plays the merged passage; created on the first press. */
	private preview: SpeakerPreviewPlayer | null = null;
	/** The play button; null when the passage's end is unknown. */
	private previewButton: ExtraButtonComponent | null = null;
	// Built by renderForm, the only place that offers the action reading it.
	private speaker!: DropdownComponent;
	/** How many transcript lines the form offered to merge. */
	private lineCount = 0;

	constructor(
		app: App,
		private readonly context: TranscriptSelectionContext,
		private readonly options: TranscriptEditModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Merge selected lines into one');
		void this.render();
	}

	override onClose(): void {
		this.preview?.dispose();
		this.preview = null;
		super.onClose();
	}

	/**
	 * Reads what the merge needs and builds the dialog, or explains why this
	 * selection cannot be merged.
	 */
	private async render(): Promise<void> {
		const prepared = await prepareMerge(
			this.app,
			this.options,
			this.context,
		);
		const { contentEl } = this;
		contentEl.empty();
		this.renderSource(this.context.audio);
		if (isRefusal(prepared)) {
			this.renderEmptyState(prepared.refusal);
			return;
		}
		this.renderForm(prepared.value);
	}

	/**
	 * Builds the form: the lines and their merged text, the speaker of the
	 * merged line, the passage it spans with a play button, what happens to
	 * the transcript files, and the actions.
	 * @param prepared - What the merge works from
	 */
	private renderForm(prepared: PreparedMerge): void {
		const { contentEl } = this;
		const { rows, timing } = prepared;
		const [first] = rows;
		this.lineCount = rows.length;

		new Setting(contentEl)
			.setName('Lines')
			.setDesc(
				`${String(rows.length)} lines, shown as ${rows
					.map((row) => row.speaker ?? 'no speaker')
					.join(', ')}.`,
			);
		new Setting(contentEl)
			.setName('Merged text')
			.setDesc(quote(mergedLineText(rows.map((row) => row.text))));
		const speakerOptions = mergeSpeakerOptions(prepared);
		new Setting(contentEl)
			.setName('Spoken by')
			.setDesc(
				'Who the merged line belongs to. It starts as the speaker of the first line.',
			)
			.addDropdown((dropdown) => {
				fillSpeakerDropdown(dropdown, speakerOptions);
				dropdown.setValue(speakerValue(first?.speaker));
				this.speaker = dropdown;
			});
		this.renderPassage(timing);
		const kept = keptFilesReason(
			prepared.source,
			prepared.span,
			'no unbroken run of segments matching these lines',
			'a merge',
		);
		if (kept) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: kept,
			});
		}
		this.renderActions(
			{
				text: 'Merge',
				cta: true,
				onClick: () => this.merge(),
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
	 * The passage the merged line spans, with a button that plays all of it,
	 * so the merge is checked by ear before it is written. A passage whose end
	 * is unknown - the note's last line of a recording that could not be
	 * measured - has nothing to stop at, and offers no button.
	 * @param timing - Where the merged lines sit
	 */
	private renderPassage(timing: RowTiming): void {
		const row = new Setting(this.contentEl).setName('Time span');
		if (timing.end === null || timing.end <= timing.start) {
			row.setDesc(
				`Starts at ${formatLineTime(timing.start)}. Where the last line ends is unknown, so the passage cannot be played.`,
			);
			return;
		}
		const span = { start: timing.start, end: timing.end };
		row.setDesc(
			`${formatLineTime(span.start)} to ${formatLineTime(span.end)}. Play the whole passage to check that one speaker says it.`,
		).addExtraButton((button) => {
			button
				.setIcon('play')
				.setTooltip('Play the merged passage')
				.onClick(() => {
					this.previewPlayer().toggle(MERGED_PREVIEW_ID, span);
				});
			this.previewButton = button;
		});
	}

	/**
	 * The preview player, created on the first press so a dialog nobody
	 * previews never resolves a media URL.
	 */
	private previewPlayer(): SpeakerPreviewPlayer {
		const existing = this.preview;
		if (existing) {
			return existing;
		}
		const player = new SpeakerPreviewPlayer(
			() => this.app.vault.getResourcePath(this.context.audio),
			(playingId) => {
				this.previewButton?.setIcon(playingId ? 'square' : 'play');
			},
		);
		this.preview = player;
		return player;
	}

	/**
	 * Asks before more than two lines are merged: that folds several turns,
	 * often of several speakers, into one, and the transcript files it
	 * rewrites are not restored by the editor's undo.
	 * @returns True when the merge may go ahead
	 */
	private confirmMerge(): Promise<boolean> {
		if (!mergeNeedsConfirmation(this.lineCount)) {
			return Promise.resolve(true);
		}
		return confirmAction(this.app, {
			title: `Merge ${String(this.lineCount)} lines?`,
			message: mergeConfirmationMessage(
				this.lineCount,
				pickedChoice(this.speaker.getValue()),
			),
			confirmText: 'Merge',
		});
	}

	/**
	 * Merges the lines, after confirming a merge of more than two, through the
	 * editor so the merge is undone like any other edit.
	 */
	private async merge(): Promise<void> {
		await this.runExclusive(async () => {
			if (!(await this.confirmMerge())) {
				return;
			}
			new Notice(
				await performMerge(
					this.app,
					this.options,
					this.context,
					pickedChoice(this.speaker.getValue()),
					'The lines changed while this dialog was open. Select them again.',
				),
			);
			this.close();
		});
	}
}
