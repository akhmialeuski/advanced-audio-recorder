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
import type { TranscriptSelectionContext } from '../actions/PluginAction';
import { lineTimecodeRef, timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import {
	applyTranscriptEdit,
	describeTranscriptMerge,
} from '../speakers/applyTranscriptEdit';
import {
	buildMergedSegment,
	locateMergedSegments,
	mergedLineText,
	mergedSpan,
	mergeConfirmationMessage,
	mergeNeedsConfirmation,
	mergeSelectionProblem,
	type SelectedLineKind,
} from '../speakers/transcriptMerge';
import {
	formatLineTime,
	lineSpeakerOptions,
	resolveLineSpeakers,
	rowTiming,
	type LineSpeakerOption,
	type LineSpeakerSources,
	type RowSpan,
	type RowTiming,
} from '../speakers/transcriptRows';
import {
	formatTranscriptMarkdown,
	restoreWikilinks,
} from '../transcription/transcriptFormat';
import { confirmAction } from './ConfirmModal';
import { PluginModal } from './PluginModal';
import {
	fillSpeakerDropdown,
	keptFilesReason,
	nextLineSeconds,
	NO_SPEAKER_OPTION,
	pickedChoice,
	quote,
	readTranscriptLine,
	readTranscriptSource,
	recordingDuration,
	speakerSources,
	speakerValue,
	type ReadLine,
	type TranscriptEditModalOptions,
	type TranscriptSource,
} from './transcriptLineDialog';

/** Preview id of the merged passage (the player plays one excerpt at a time). */
const MERGED_PREVIEW_ID = 'merged';

/** One selected transcript line, read back. */
interface MergedRow extends ReadLine {
	/** Whole seconds the line's timecode link points at. */
	seconds: number;
}

/** Everything read and worked out before the dialog can offer a merge. */
interface PreparedMerge {
	/** What the recording's sidecar and JSON transcript say. */
	source: TranscriptSource;
	/** The selected transcript lines, in note order. */
	rows: MergedRow[];
	/** The lines' segments in the JSON transcript, when they were found. */
	span: RowSpan | null;
	/** Where the merged lines sit on the timeline. */
	timing: RowTiming;
	/** What is known about the recording's speakers. */
	sources: LineSpeakerSources;
}

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
		const prepared = await this.prepare();
		const { contentEl } = this;
		contentEl.empty();
		this.renderSource(this.context.audio);
		if (typeof prepared === 'string') {
			this.renderEmptyState(prepared);
			return;
		}
		this.renderForm(prepared);
	}

	/**
	 * Reads the recording's sidecar and JSON transcript, reads every selected
	 * line back with the note's templates, checks that they are consecutive
	 * lines of this recording, finds their segments in the JSON transcript
	 * and works out where they sit.
	 * @returns What the merge works from, or why the lines cannot be merged
	 */
	private async prepare(): Promise<PreparedMerge | string> {
		const { editor, note, audio, lastLine, lineTexts } = this.context;
		const source = await readTranscriptSource(
			this.app,
			this.options,
			note,
			audio,
		);
		if (typeof source === 'string') {
			return source;
		}
		const kinds: SelectedLineKind[] = [];
		const rows: MergedRow[] = [];
		for (const text of lineTexts) {
			if (text.trim().length === 0) {
				kinds.push('blank');
				continue;
			}
			const ref = lineTimecodeRef(this.app, note, text);
			const read =
				ref?.file.path === audio.path
					? readTranscriptLine(source, text)
					: null;
			if (!ref || !read) {
				kinds.push('other');
				continue;
			}
			kinds.push('row');
			rows.push({ ...read, seconds: ref.seconds });
		}
		const problem = mergeSelectionProblem(kinds);
		if (problem) {
			return problem;
		}
		const lastNext = nextLineSeconds(
			this.app,
			editor,
			note,
			audio,
			lastLine,
		);
		const { recorded } = source;
		const span = recorded
			? locateMergedSegments(
					recorded.transcript,
					rows.map((row, index) => ({
						seconds: row.seconds,
						speaker: row.speaker,
						nextSeconds: rows[index + 1]?.seconds ?? lastNext,
						merge: source.options.mergeConsecutiveSpeaker,
						text: restoreWikilinks(row.text),
					})),
				)
			: null;
		const timing: RowTiming =
			recorded && span
				? rowTiming(recorded.transcript, span)
				: {
						// The first selected line is the one the selection
						// was resolved through, so its link is this one.
						start: this.context.seconds,
						end:
							lastNext ??
							(await recordingDuration(
								this.app,
								this.options,
								audio,
							)),
					};
		return {
			source,
			rows,
			span,
			timing,
			sources: speakerSources(
				source,
				rows.map((row) => row.speaker),
			),
		};
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
		const options = lineSpeakerOptions(prepared.sources);
		const speakerOptions: LineSpeakerOption[] = rows.some(
			(row) => row.speaker === undefined,
		)
			? [NO_SPEAKER_OPTION, ...options]
			: options;
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
	 * Merges the lines: confirms a merge of more than two, reads the
	 * transcript and the roster again, resolves the speaker, replaces the
	 * lines in the editor with the merged one, then writes the transcript
	 * files and the roster. What the form was built from is not written
	 * back: a background run may have rewritten the transcript or the roster
	 * since, and the old copy would undo it in every file.
	 */
	private async merge(): Promise<void> {
		await this.runExclusive(async () => {
			if (!(await this.confirmMerge())) {
				return;
			}
			const prepared = await this.prepare();
			if (typeof prepared === 'string') {
				throw new Error(prepared);
			}
			const { rows, timing, source } = prepared;
			const { names, added } = resolveLineSpeakers(prepared.sources, [
				{
					choice: pickedChoice(this.speaker.getValue()),
					times: mergedSpan(timing),
				},
			]);
			const merged = buildMergedSegment(
				timing,
				rows.map((row) => row.text),
				names[0],
			);
			this.replaceLines(
				formatTranscriptMarkdown(
					{ segments: [merged], speakers: [] },
					source.options,
					timecodeLinkBuilder(
						this.app,
						this.context.audio,
						this.context.note.path,
					),
				),
			);
			const outcome = await applyTranscriptEdit(
				this.app,
				this.options.sidecar,
				{
					audioPath: this.context.audio.path,
					section: source.section,
					recorded: source.recorded,
					span: prepared.span,
					pieces: [merged],
					added,
				},
			);
			new Notice(
				describeTranscriptMerge(
					rows.length,
					outcome,
					this.options.getSettings()
						.transcriptionSpeakerRenameEnabled,
				),
			);
			this.close();
		});
	}

	/**
	 * Replaces the selected lines with the merged one, through the editor so
	 * the merge is undone like any other edit. Refuses when any of them no
	 * longer reads as it did when the selection was made.
	 * @param rendered - The merged line as note Markdown
	 */
	private replaceLines(rendered: string): void {
		const { editor, line, lastLine, lineTexts } = this.context;
		const changed = lineTexts.some(
			(text, index) => editor.getLine(line + index) !== text,
		);
		if (changed) {
			throw new Error(
				'The lines changed while this dialog was open. Select them again.',
			);
		}
		editor.replaceRange(
			rendered,
			{ line, ch: 0 },
			{ line: lastLine, ch: editor.getLine(lastLine).length },
		);
	}
}
