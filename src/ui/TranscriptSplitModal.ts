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
 * {@link speakers/applyTranscriptSplit}. The time fields start from the word
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
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { TranscriptSelectionContext } from '../actions/PluginAction';
import {
	audioTimecodeRefs,
	timecodeLinkBuilder,
} from '../obsidian/timecodeRefs';
import { SpeakerPreviewPlayer } from '../player/SpeakerPreviewPlayer';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import {
	emptyTranscriptSection,
	type TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import {
	applyTranscriptSplit,
	describeTranscriptSplit,
	type TranscriptSplitSidecar,
} from '../speakers/applyTranscriptSplit';
import {
	afterSelection,
	buildSplitPieces,
	estimateSplitTimes,
	formatSplitTime,
	locateRowSegments,
	noteMarkdownOptions,
	resolveSplitSpeakers,
	rowTiming,
	splitLineText,
	splitSpeakerOptions,
	readSplitTimes,
	type RowSpan,
	type RowTiming,
	type SplitSpeakerChoice,
	type SplitSpeakerOption,
	type SplitSpeakerRequest,
	type SplitSpeakerSources,
	type SplitTexts,
} from '../speakers/transcriptSplit';
import {
	originalTranscriptOutputs,
	readRecordedTranscript,
	type RecordedTranscript,
} from '../transcription/recordedTranscript';
import {
	formatTranscriptMarkdown,
	parseTranscriptLine,
	restoreWikilinks,
	type TranscriptMarkdownOptions,
} from '../transcription/transcriptFormat';
import { collectSpeakers } from '../transcription/transcriptModel';
import { parseTimecode } from '../utils/TimeUtils';
import { PluginModal } from './PluginModal';

/** Longest excerpt of a part of the line the dialog quotes. */
const EXCERPT_MAX_CHARS = 160;

/** Preview id of the selection (the player plays one excerpt at a time). */
const SELECTION_PREVIEW_ID = 'selection';

/**
 * Class of the two time fields, which the stylesheet keeps as wide as a
 * timecode so the row's description is not squeezed beside them.
 */
const TIME_INPUT_CLASS = 'aar-split-time-input';

/**
 * The slice of the recording sidecar store the dialog needs: read the
 * transcript section, tell an unreadable sidecar from an empty one, and add
 * the speakers a split creates to the roster. Structural so tests can stub it.
 */
export interface TranscriptSplitSidecarAccess extends TranscriptSplitSidecar {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/** Whether the sidecar file exists but could not be read (after a read). */
	isSidecarCorrupt(path: string): boolean;
}

/** Collaborators the dialog needs, injected by the action registry. */
export interface TranscriptSplitModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Recording sidecar access: templates, outputs and the roster. */
	sidecar: TranscriptSplitSidecarAccess;
	/**
	 * Measures the recording, which is where the note's last line ends when no
	 * JSON transcript says so.
	 */
	probeDuration: (url: string) => Promise<number | null>;
}

/** Everything read and worked out before the dialog can offer a split. */
interface PreparedSplit {
	/** The recording's sidecar transcript section. */
	section: TranscriptSection;
	/** The templates the note's transcript was written with. */
	options: TranscriptMarkdownOptions;
	/** The recorded JSON transcript, when there is one. */
	recorded: RecordedTranscript | null;
	/** The line's segments in it, when they were found. */
	span: RowSpan | null;
	/** The line's text cut at the selection. */
	texts: SplitTexts;
	/** Where the line sits on the timeline. */
	timing: RowTiming;
	/** Speaker the line shows. */
	rowSpeaker: string | undefined;
	/** What is known about the recording's speakers. */
	sources: SplitSpeakerSources;
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

	constructor(
		app: App,
		private readonly context: TranscriptSelectionContext,
		private readonly options: TranscriptSplitModalOptions,
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
		const { audio } = this.context;
		const section = await this.loadSection();
		const prepared =
			section === null
				? // An unreadable sidecar is not an empty one: writing the roster
					// back would replace whatever is stored in it.
					'The sidecar file of this recording could not be read, so the speakers stored for it are unknown. Fix or remove the .markers.json file next to the recording and try again.'
				: await this.prepare(section);
		const { contentEl } = this;
		contentEl.empty();
		this.renderSource(audio);
		if (typeof prepared === 'string') {
			this.renderEmptyState(prepared);
			return;
		}
		this.renderForm(prepared);
	}

	/**
	 * Reads the recording's sidecar transcript section: an empty one when
	 * nothing is stored, null when the file exists but could not be read.
	 */
	private async loadSection(): Promise<TranscriptSection | null> {
		const path = this.context.audio.path;
		try {
			const section = await this.options.sidecar.getTranscript(path);
			return this.options.sidecar.isSidecarCorrupt(path) ? null : section;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to read the sidecar of ${path}:`,
				error,
			);
			return emptyTranscriptSection();
		}
	}

	/**
	 * Reads the line back with the note's templates, cuts it at the selection,
	 * finds its segments in the JSON transcript and works out where it sits.
	 * @param section - The recording's sidecar transcript section
	 * @returns What the form needs, or why the selection cannot be split
	 */
	private async prepare(
		section: TranscriptSection,
	): Promise<PreparedSplit | string> {
		const { note, lineText, from, to, seconds } = this.context;
		const output = section.noteOutputs.find(
			(candidate) => candidate.path === note.path,
		);
		const options = noteMarkdownOptions(
			output?.templates,
			this.options.getSettings(),
		);
		const recorded = await readRecordedTranscript(
			this.app,
			section.fileOutputs,
		);
		const shown = recorded
			? collectSpeakers(recorded.transcript.segments)
			: [];
		const known = [
			...section.speakers.map((entry) => entry.name ?? entry.label),
			...shown,
		];
		const parsed = parseTranscriptLine(lineText, options, known);
		if (!parsed) {
			return 'This line does not have the shape the transcript of this recording was written in, so it cannot be split. Select text inside a transcript line.';
		}
		const texts = splitLineText(lineText, parsed, from, to);
		if (!texts) {
			return 'The selection holds none of the spoken text of the line. Select the words that belong to another speaker.';
		}
		const rowSpeaker =
			parsed.speaker === undefined
				? undefined
				: restoreWikilinks(parsed.speaker);
		const nextSeconds = this.nextLineSeconds();
		const span = recorded
			? locateRowSegments(recorded.transcript, {
					seconds,
					speaker: rowSpeaker,
					nextSeconds,
					merge: options.mergeConsecutiveSpeaker,
					text: restoreWikilinks(
						lineText.slice(parsed.textStart, parsed.textEnd),
					),
				})
			: null;
		const timing: RowTiming =
			recorded && span
				? rowTiming(recorded.transcript, span)
				: {
						start: seconds,
						end: nextSeconds ?? (await this.recordingDuration()),
					};
		return {
			section,
			options,
			recorded,
			span,
			texts,
			timing,
			rowSpeaker,
			sources: {
				roster: section.speakers,
				participants: section.participants,
				shown:
					rowSpeaker === undefined ? shown : [...shown, rowSpeaker],
			},
		};
	}

	/**
	 * Where the next line of the same recording starts, which is where this
	 * line ends as far as the note can tell; null for the last line.
	 */
	private nextLineSeconds(): number | null {
		const { note, audio, line } = this.context;
		// The cache lists links in note order, so the first one below the line
		// starts the next line.
		const next = audioTimecodeRefs(this.app, note, audio.path).find(
			(ref) => ref.startLine > line && ref.seconds !== null,
		);
		return next?.seconds ?? null;
	}

	/** The recording's length, or null when it cannot be measured. */
	private async recordingDuration(): Promise<number | null> {
		try {
			return await this.options.probeDuration(
				this.app.vault.getResourcePath(this.context.audio),
			);
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not measure ${this.context.audio.path}:`,
				error,
			);
			return null;
		}
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
		const options = splitSpeakerOptions(prepared.sources);
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
		new Setting(contentEl)
			.setName('Time span')
			.setDesc(
				'Where the selection starts and ends, as 1:23 or 1:23.5. Play it to check.',
			)
			.addText((text) => {
				text.setPlaceholder('Start').setValue(
					formatSplitTime(times.start),
				);
				text.inputEl.addClass(TIME_INPUT_CLASS);
				this.startInput = text;
			})
			.addText((text) => {
				text.setPlaceholder('End').setValue(formatSplitTime(times.end));
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
		if (texts.after) {
			this.renderAfterSpeaker(options, texts.after, rowSpeaker);
		}
		const kept = keptFilesReason(prepared);
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
				onClick: () => this.split(prepared),
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
		options: readonly SplitSpeakerOption[],
		after: string,
		rowSpeaker: string | undefined,
	): void {
		const afterOptions: SplitSpeakerOption[] =
			rowSpeaker === undefined
				? [
						{
							value: 'none',
							title: 'No speaker',
							choice: { kind: 'none' },
						},
						...options,
					]
				: [...options];
		new Setting(this.contentEl)
			.setName('Rest of the line spoken by')
			.setDesc(
				`${quote(after)} It continues from the end of the selection.`,
			)
			.addDropdown((dropdown) => {
				fillSpeakerDropdown(dropdown, afterOptions);
				dropdown.setValue(
					rowSpeaker === undefined
						? 'none'
						: `existing:${rowSpeaker}`,
				);
				this.afterSpeaker = dropdown;
			});
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
			},
		);
		this.preview = player;
		return player;
	}

	/**
	 * Splits the line: validates the times, resolves the speakers, replaces
	 * the line in the editor with its pieces, then writes the transcript files
	 * and the roster.
	 * @param prepared - What the split works from
	 */
	private async split(prepared: PreparedSplit): Promise<void> {
		await this.runExclusive(async () => {
			const { texts, timing, options } = prepared;
			const times = readSplitTimes(
				this.startInput.getValue(),
				this.endInput.getValue(),
				timing,
				texts,
			);
			if (typeof times === 'string') {
				throw new Error(times);
			}
			const requests: SplitSpeakerRequest[] = [
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
			const { names, added } = resolveSplitSpeakers(
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
			const outcome = await applyTranscriptSplit(
				this.app,
				this.options.sidecar,
				{
					audioPath: this.context.audio.path,
					section: prepared.section,
					recorded: prepared.recorded,
					span: prepared.span,
					pieces,
					added,
				},
			);
			new Notice(describeTranscriptSplit(outcome));
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

/**
 * The choice a speaker dropdown value stands for (the values are the ones
 * {@link splitSpeakerOptions} gives, plus "none" for no speaker).
 * @param value - The dropdown's value
 */
function pickedChoice(value: string): SplitSpeakerChoice {
	if (value === 'new') {
		return { kind: 'new' };
	}
	if (value === 'none') {
		return { kind: 'none' };
	}
	const separator = value.indexOf(':');
	const name = value.slice(separator + 1);
	return value.startsWith('participant:')
		? { kind: 'participant', name }
		: { kind: 'existing', name };
}

/** Fills a speaker dropdown with the options, in order. */
function fillSpeakerDropdown(
	dropdown: DropdownComponent,
	options: readonly SplitSpeakerOption[],
): void {
	for (const option of options) {
		dropdown.addOption(option.value, option.title);
	}
}

/** Quotes a part of the line, shortened to a readable excerpt. */
function quote(text: string): string {
	const excerpt =
		text.length > EXCERPT_MAX_CHARS
			? `${text.slice(0, EXCERPT_MAX_CHARS).trimEnd()}...`
			: text;
	return `"${excerpt}"`;
}

/**
 * Why the transcript files will be kept as they are, or null when they will
 * be split along with the note (or there are none).
 * @param prepared - What the split works from
 */
function keptFilesReason(prepared: PreparedSplit): string | null {
	if (prepared.recorded && !prepared.span) {
		return 'Only the note is changed: the JSON transcript of this recording holds no segment matching this line, so its transcript files are kept as they are.';
	}
	if (
		!prepared.recorded &&
		originalTranscriptOutputs(prepared.section.fileOutputs).length > 0
	) {
		return 'Only the note is changed: the transcript files of this recording are kept as they are, because only a JSON transcript keeps the timings a split needs.';
	}
	return null;
}
