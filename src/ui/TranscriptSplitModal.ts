/**
 * Dialog that splits one rendered transcript line between speakers, opened on
 * a selection inside that line. Diarization sometimes gives two people's words
 * to one speaker, and the timestamps of such a turn are off with it; the user
 * selects the words that belong to someone else and says here who spoke them
 * and when, and - when the selection sits in the middle of the line - who the
 * rest of the line belongs to.
 *
 * The line is read back with the render templates the recording's sidecar
 * recorded for this note, and its pieces are written with the same renderer
 * that wrote the transcript, replacing the line in the editor (so the edit is
 * undone like any other). The recorded transcript files are rewritten from the
 * JSON transcript and the speakers the split creates join the roster; see
 * {@link speakers/applyTranscriptEdit}. The time fields start from the word
 * timings when the JSON transcript has them, and a play button plays the
 * entered span, so the times can be checked by ear rather than guessed.
 * @module ui/TranscriptSplitModal
 */

import { Notice, Setting } from 'obsidian';
import type {
	App,
	DropdownComponent,
	ExtraButtonComponent,
	TextComponent,
} from 'obsidian';
import type { TranscriptSelectionContext } from '../actions/PluginAction';
import { timecodeLinkBuilder } from '../obsidian/timecodeRefs';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import type { SpeakerPreviewRange } from '../speakers/speakerPreview';
import {
	applyTranscriptEdit,
	describeTranscriptSplit,
} from '../speakers/applyTranscriptEdit';
import {
	formatLineTime,
	lineSpeakerOptions,
	locateRowSegments,
	resolveLineSpeakers,
	rowTiming,
	type LineSpeakerOption,
	type LineSpeakerRequest,
	type LineSpeakerSources,
	type RowSpan,
	type RowTiming,
} from '../speakers/transcriptRows';
import {
	afterSelection,
	buildSplitPieces,
	estimateSplitTimes,
	readSplitTimes,
	splitLineText,
	type SplitTexts,
} from '../speakers/transcriptSplit';
import {
	formatTranscriptMarkdown,
	restoreWikilinks,
} from '../transcription/transcriptFormat';
import { parseTimecode } from '../utils/TimeUtils';
import { PluginModal } from './PluginModal';
import { TimeSpanSlider } from './TimeSpanSlider';
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
	type TranscriptEditModalOptions,
	type TranscriptSource,
} from './transcriptLineDialog';

/** Preview id of the selection (the player plays one excerpt at a time). */
const SELECTION_PREVIEW_ID = 'selection';

/**
 * Class of the two time fields, which the stylesheet keeps as wide as a
 * timecode so the row's description is not squeezed beside them.
 */
const TIME_INPUT_CLASS = 'aar-split-time-input';

/** Everything read and worked out before the dialog can offer a split. */
interface PreparedSplit {
	/** What the recording's sidecar and JSON transcript say. */
	source: TranscriptSource;
	/** The line's segments in the JSON transcript, when they were found. */
	span: RowSpan | null;
	/** The line's text cut at the selection. */
	texts: SplitTexts;
	/** Where the line sits on the timeline. */
	timing: RowTiming;
	/** Speaker the line shows. */
	rowSpeaker: string | undefined;
	/** What is known about the recording's speakers. */
	sources: LineSpeakerSources;
}

/**
 * Split dialog for one selection in one transcript line.
 */
export class TranscriptSplitModal extends PluginModal {
	/** Plays the entered span; created on the first press. */
	private preview: SpeakerPreviewPlayer | null = null;
	// The controls below are built together by renderForm, the only place
	// that offers the actions reading them.
	private previewButton!: ExtraButtonComponent;
	private startInput!: TextComponent;
	private endInput!: TextComponent;
	private selectedSpeaker!: DropdownComponent;
	/** Speaker of the rest of the line; null when the selection ends it. */
	private afterSpeaker: DropdownComponent | null = null;
	/** Handles over the line's span; null when the line's end is unknown. */
	private spanSlider: TimeSpanSlider | null = null;

	constructor(
		app: App,
		private readonly context: TranscriptSelectionContext,
		private readonly options: TranscriptEditModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Split selection into another speaker');
		void this.render();
	}

	override onClose(): void {
		this.preview?.dispose();
		this.preview = null;
		super.onClose();
	}

	/**
	 * Reads what the split needs and builds the dialog, or explains why this
	 * selection cannot be split.
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
	 * Reads the recording's sidecar and JSON transcript, reads the line back
	 * with the note's templates, cuts it at the selection, finds its segments
	 * in the JSON transcript and works out where it sits.
	 * @returns What the split works from, or why the selection cannot be split
	 */
	private async prepare(): Promise<PreparedSplit | string> {
		const { editor, note, audio, line, lineText, from, to, seconds } =
			this.context;
		const source = await readTranscriptSource(
			this.app,
			this.options,
			note,
			audio,
		);
		if (typeof source === 'string') {
			return source;
		}
		const read = readTranscriptLine(source, lineText);
		if (!read) {
			return 'This line does not have the shape the transcript of this recording was written in, so it cannot be split. Select text inside a transcript line.';
		}
		const texts = splitLineText(lineText, read.parsed, from, to);
		if (!texts) {
			return 'The selection holds none of the spoken text of the line. Select the words that belong to another speaker.';
		}
		const nextSeconds = nextLineSeconds(
			this.app,
			editor,
			note,
			audio,
			line,
		);
		const { recorded } = source;
		const span = recorded
			? locateRowSegments(recorded.transcript, {
					seconds,
					speaker: read.speaker,
					nextSeconds,
					merge: source.options.mergeConsecutiveSpeaker,
					text: restoreWikilinks(read.text),
				})
			: null;
		const timing: RowTiming =
			recorded && span
				? rowTiming(recorded.transcript, span)
				: {
						start: seconds,
						end:
							nextSeconds ??
							(await recordingDuration(
								this.app,
								this.options,
								audio,
							)),
					};
		return {
			source,
			span,
			texts,
			timing,
			rowSpeaker: read.speaker,
			sources: speakerSources(source, [read.speaker]),
		};
	}

	/**
	 * Builds the form: the selection with its speaker and time span, the
	 * speaker of the rest of the line when the selection leaves some, what
	 * happens to the transcript files, and the actions.
	 * @param prepared - What the split works from
	 */
	private renderForm(prepared: PreparedSplit): void {
		const { contentEl } = this;
		const { texts, rowSpeaker } = prepared;
		const options = lineSpeakerOptions(prepared.sources);
		const times = estimateSplitTimes(prepared.timing, texts);

		new Setting(contentEl)
			.setName('Selection')
			.setDesc(quote(texts.selected));
		new Setting(contentEl)
			.setName('Spoken by')
			.setDesc(
				rowSpeaker === undefined
					? 'Who the selected words belong to.'
					: `Who the selected words belong to instead of ${rowSpeaker}.`,
			)
			.addDropdown((dropdown) => {
				fillSpeakerDropdown(dropdown, options);
				const other = options.find(
					(option) =>
						option.choice.kind === 'existing' &&
						option.choice.name !== rowSpeaker,
				);
				dropdown.setValue(other?.value ?? 'new');
				this.selectedSpeaker = dropdown;
			});
		// The bar needs both ends of the line; a last line whose recording
		// could not be measured has only its start, and keeps the fields alone.
		const { timing } = prepared;
		const bounds =
			timing.end !== null && timing.end > timing.start
				? { start: timing.start, end: timing.end }
				: null;
		new Setting(contentEl)
			.setName('Time span')
			.setDesc(
				bounds
					? 'Where the selection starts and ends: drag the handles on the line below, or type 1:23 or 1:23.5. Play it to check.'
					: 'Where the selection starts and ends, as 1:23 or 1:23.5. Play it to check.',
			)
			.addText((text) => {
				text.setPlaceholder('Start')
					.setValue(formatLineTime(times.start))
					.onChange(() => {
						this.showTypedSpan();
					});
				text.inputEl.addClass(TIME_INPUT_CLASS);
				this.startInput = text;
			})
			.addText((text) => {
				text.setPlaceholder('End')
					.setValue(formatLineTime(times.end))
					.onChange(() => {
						this.showTypedSpan();
					});
				text.inputEl.addClass(TIME_INPUT_CLASS);
				this.endInput = text;
			})
			.addExtraButton((button) => {
				button
					.setIcon('play')
					.setTooltip('Play the selection')
					.onClick(() => {
						this.togglePreview();
					});
				this.previewButton = button;
			});
		if (bounds) {
			this.spanSlider = new TimeSpanSlider(contentEl, {
				bounds,
				value: times,
				onInput: (span) => {
					this.startInput.setValue(formatLineTime(span.start));
					this.endInput.setValue(formatLineTime(span.end));
				},
				onChange: (span) => {
					this.replayMovedSpan(span);
				},
			});
		}
		if (texts.after) {
			this.renderAfterSpeaker(options, texts.after, rowSpeaker);
		}
		const kept = keptFilesReason(
			prepared.source,
			prepared.span,
			'no segment matching this line',
			'a split',
		);
		if (kept) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: kept,
			});
		}
		this.renderActions(
			{
				text: 'Split',
				cta: true,
				onClick: () => this.split(),
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
	 * The speaker of the text after the selection, which stays with the line's
	 * own speaker unless the user says otherwise.
	 * @param options - Speaker options of the recording
	 * @param after - The text after the selection
	 * @param rowSpeaker - Speaker the line shows
	 */
	private renderAfterSpeaker(
		options: readonly LineSpeakerOption[],
		after: string,
		rowSpeaker: string | undefined,
	): void {
		const afterOptions: LineSpeakerOption[] =
			rowSpeaker === undefined
				? [NO_SPEAKER_OPTION, ...options]
				: [...options];
		new Setting(this.contentEl)
			.setName('Rest of the line spoken by')
			.setDesc(
				`${quote(after)} It continues from the end of the selection.`,
			)
			.addDropdown((dropdown) => {
				fillSpeakerDropdown(dropdown, afterOptions);
				dropdown.setValue(speakerValue(rowSpeaker));
				this.afterSpeaker = dropdown;
			});
	}

	/** Moves the handles to the span typed into the fields, once it reads. */
	private showTypedSpan(): void {
		const start = parseTimecode(this.startInput.getValue());
		const end = parseTimecode(this.endInput.getValue());
		if (start !== null && end !== null && end >= start) {
			this.spanSlider?.setSpan({ start, end });
		}
	}

	/**
	 * Plays the span again from its new start when a handle is let go while
	 * it plays, so a boundary is placed by ear without pressing play again.
	 * @param span - The span the handles were left at
	 */
	private replayMovedSpan(span: SpeakerPreviewRange): void {
		const preview = this.preview;
		if (
			preview?.playingId !== SELECTION_PREVIEW_ID ||
			span.end <= span.start
		) {
			return;
		}
		preview.stop();
		preview.toggle(SELECTION_PREVIEW_ID, span);
	}

	/** Plays the entered span, or stops it when it is playing. */
	private togglePreview(): void {
		const start = parseTimecode(this.startInput.getValue());
		const end = parseTimecode(this.endInput.getValue());
		if (start === null || end === null || end <= start) {
			new Notice('Enter a start and a later end to play the selection.');
			return;
		}
		this.previewPlayer().toggle(SELECTION_PREVIEW_ID, { start, end });
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
				this.previewButton.setIcon(playingId ? 'square' : 'play');
				if (playingId === null) {
					this.spanSlider?.setPlayhead(null);
				}
			},
			(seconds) => {
				this.spanSlider?.setPlayhead(seconds);
			},
		);
		this.preview = player;
		return player;
	}

	/**
	 * Splits the line: reads the transcript and the roster again, validates
	 * the times, resolves the speakers, replaces the line in the editor with
	 * its pieces, then writes the transcript files and the roster. What the
	 * form was built from is not written back: a background run may have
	 * rewritten the transcript or the roster since, and the old copy would
	 * undo it in every file.
	 */
	private async split(): Promise<void> {
		await this.runExclusive(async () => {
			const prepared = await this.prepare();
			if (typeof prepared === 'string') {
				throw new Error(prepared);
			}
			const { texts, timing } = prepared;
			const { options } = prepared.source;
			const times = readSplitTimes(
				this.startInput.getValue(),
				this.endInput.getValue(),
				timing,
				texts,
			);
			if (typeof times === 'string') {
				throw new Error(times);
			}
			const requests: LineSpeakerRequest[] = [
				{
					choice: pickedChoice(this.selectedSpeaker.getValue()),
					times,
				},
			];
			if (this.afterSpeaker) {
				requests.push({
					choice: pickedChoice(this.afterSpeaker.getValue()),
					times: afterSelection(timing, times),
				});
			}
			const { names, added } = resolveLineSpeakers(
				prepared.sources,
				requests,
			);
			const pieces = buildSplitPieces(timing, texts, times, {
				row: prepared.rowSpeaker,
				selected: names[0],
				after: names[1],
			});
			this.replaceLine(
				formatTranscriptMarkdown(
					{ segments: pieces, speakers: [] },
					options,
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
					section: prepared.source.section,
					recorded: prepared.source.recorded,
					span: prepared.span,
					pieces,
					added,
				},
			);
			new Notice(
				describeTranscriptSplit(
					outcome,
					this.options.getSettings()
						.transcriptionSpeakerRenameEnabled,
				),
			);
			this.close();
		});
	}

	/**
	 * Replaces the selected line with the rendered pieces, through the editor
	 * so the split is undone like any other edit. Refuses when the line no
	 * longer reads as it did when the selection was made.
	 * @param rendered - The pieces as note Markdown
	 */
	private replaceLine(rendered: string): void {
		const { editor, line, lineText } = this.context;
		if (editor.getLine(line) !== lineText) {
			throw new Error(
				'The line changed while this dialog was open. Select the text again.',
			);
		}
		editor.replaceRange(
			rendered,
			{ line, ch: 0 },
			{ line, ch: lineText.length },
		);
	}
}
