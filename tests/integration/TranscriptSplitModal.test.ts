/**
 * Tests for splitting a transcript line between speakers, driven the way a
 * user drives it: a selection in a note rendered by the transcript renderer is
 * resolved into its line and recording, the dialog is filled in and Split is
 * pressed, and the note, the recorded transcript files and the speaker roster
 * are read back. The vault, the metadata cache and the editor are the shared
 * Obsidian doubles; only the sidecar store is a stub.
 * @jest-environment jsdom
 */

import type { TFile } from 'obsidian';
import { transcriptSelectionIn } from 'src/actions/transcriptActions';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { TranscriptSplitModal } from 'src/ui/TranscriptSplitModal';
import { formatSplitTime } from 'src/speakers/transcriptSplit';
import { noticeMessages } from '../mocks/obsidian';
import { silenceConsole } from '../helpers/doubles';
import { flushMicrotasks } from '../helpers/async';
import { MODAL } from '../helpers/selectors';
import { installControlledAudio } from '../helpers/mediaMocks';
import { allEls, clickControl, control } from '../helpers/dom';
import { rowButton, settingNames, settingRow } from '../helpers/settingRows';
import {
	AUDIO_PATH,
	contextOf,
	JSON_PATH,
	openLineDialog,
	createSut,
	MIXED_TURN,
	pick,
	recordedSection,
	renderedNote,
	SRT_PATH,
	type Sut,
	TRANSCRIPT,
	writtenJson,
} from '../helpers/transcriptEditHarness';

/** Opens the dialog on a selection and waits for it to render. */
async function openDialog(
	sut: Sut,
	selected: string,
): Promise<TranscriptSplitModal> {
	sut.editor.select(selected);
	return openLineDialog(sut, TranscriptSplitModal);
}

/**
 * Types the selection's start and end into the time fields; live, the fields
 * also fire the input events a keyboard would.
 */
function typeTimes(
	modal: TranscriptSplitModal,
	start: string,
	end: string,
	{ live = false }: { live?: boolean } = {},
): void {
	const [startInput, endInput] = allEls<HTMLInputElement>(
		settingRow(modal.contentEl, 'Time span'),
		'input',
	);
	if (!startInput || !endInput) {
		throw new Error('The time span row has no inputs');
	}
	startInput.value = start;
	endInput.value = end;
	if (live) {
		startInput.dispatchEvent(new Event('input'));
		endInput.dispatchEvent(new Event('input'));
	}
}

/**
 * Opens the dialog on the last line of a transcript kept only in the note,
 * whose recording cannot be measured, so the line's end is unknown.
 */
async function openOnUnmeasuredLastLine(): Promise<TranscriptSplitModal> {
	const sut = createSut({
		section: recordedSection({ fileOutputs: [] }),
		duration: Promise.reject(new Error('no metadata')),
	});
	silenceConsole('warn');
	return openDialog(sut, 'Thanks.');
}

/** The slider over the line's span. */
function spanSlider(modal: TranscriptSplitModal): HTMLElement {
	const slider = modal.contentEl.querySelector<HTMLElement>(MODAL.timeSpan);
	if (!slider) {
		throw new Error('The dialog shows no time span slider');
	}
	return slider;
}

/** Moves a slider handle, firing the event a drag or its release fires. */
function moveHandle(
	modal: TranscriptSplitModal,
	label: string,
	seconds: number,
	event: 'input' | 'change',
): void {
	const handle = control<HTMLInputElement>(modal.contentEl, label);
	handle.value = String(seconds);
	handle.dispatchEvent(new Event(event));
}

/** What the time fields show. */
function timeFields(modal: TranscriptSplitModal): string[] {
	return allEls<HTMLInputElement>(
		settingRow(modal.contentEl, 'Time span'),
		'input',
	).map((input) => input.value);
}

/** Presses Split and lets the writes settle. */
async function pressSplit(modal: TranscriptSplitModal): Promise<void> {
	rowButton(modal.contentEl, 'Split').click();
	await flushMicrotasks(20);
}

describe('TranscriptSplitModal', () => {
	it('splits the middle of a line into three lines of the note', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		await pressSplit(modal);

		expect(sut.editor.content).toContain(
			[
				'[[rec.m4a#t=5|0:05]] **Speaker 1** Sure.',
				'[[rec.m4a#t=6|0:06]] **Bob** Wait, I have a question.',
				'[[rec.m4a#t=11|0:11]] **Speaker 1** Go ahead.',
			].join('\n\n'),
		);
	});

	it('splits the segments of the JSON transcript with their times', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		await pressSplit(modal);

		expect(
			(await writtenJson(sut)).segments.map(
				({ start, end, text, speaker }) => ({
					start,
					end,
					text,
					speaker,
				}),
			),
		).toEqual([
			{ start: 0, end: 4, text: 'Shall we start?', speaker: 'Bob' },
			{ start: 5, end: 6, text: 'Sure.', speaker: 'Speaker 1' },
			{
				start: 6,
				end: 11,
				text: 'Wait, I have a question.',
				speaker: 'Bob',
			},
			{ start: 11, end: 13, text: 'Go ahead.', speaker: 'Speaker 1' },
			{ start: 14, end: 16, text: 'Thanks.', speaker: 'Bob' },
		]);
	});

	it('splits the turn after an interruption in the same second, not the one before it', async () => {
		// A timecode link carries whole seconds, so both Bob lines point at 0:45
		// and only their text tells which segments the selection lies in.
		const sut = createSut({
			transcript: {
				segments: [
					{ start: 45.1, end: 45.3, text: 'Yeah.', speaker: 'Bob' },
					{
						start: 45.3,
						end: 45.5,
						text: 'What?',
						speaker: 'Speaker 1',
					},
					{
						start: 45.6,
						end: 49,
						text: 'I said hello there.',
						speaker: 'Bob',
					},
				],
				speakers: ['Bob', 'Speaker 1'],
			},
		});
		const modal = await openDialog(sut, 'hello');

		await pressSplit(modal);

		expect(
			(await writtenJson(sut)).segments.map(({ text }) => text),
		).toEqual(['Yeah.', 'What?', 'I said', 'hello', 'there.']);
	});

	it('writes the pieces with the templates the note was written with, not the current settings', async () => {
		const sut = createSut({
			settings: {
				transcriptSpeakerFormat: '[{speaker}]:',
				transcriptLineFormat: '{speaker} {timestamp} {text}',
				transcriptTimestampFormat: '({time})',
			},
		});
		const modal = await openDialog(sut, 'Wait, I have a question.');

		await pressSplit(modal);

		expect(sut.editor.lineWith('Go ahead.')).toBe(
			'[[rec.m4a#t=11|0:11]] **Speaker 1** Go ahead.',
		);
	});

	it('keeps the time fields as narrow as a timecode', async () => {
		const sut = createSut();

		const modal = await openDialog(sut, 'Go ahead.');

		expect(
			allEls<HTMLInputElement>(
				settingRow(modal.contentEl, 'Time span'),
				'input',
			).map((input) => input.classList.contains('aar-split-time-input')),
		).toEqual([true, true]);
	});

	it('rewrites the subtitles from the split transcript', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		await pressSplit(modal);

		const srt = sut.app.vault.getFileByPath(SRT_PATH) as TFile;
		expect(await sut.app.vault.read(srt)).toContain(
			'Bob: Wait, I have a question.',
		);
	});

	it('adds a new speaker to the roster with the selection as its first turn', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		pick(modal, 'Spoken by', 'new');

		await pressSplit(modal);

		expect(sut.sidecar.addSpeakers).toHaveBeenCalledWith(AUDIO_PATH, [
			{ label: 'Speaker 3', firstStart: 6, firstEnd: 11 },
		]);
	});

	it('gives the rest of the line to the speaker picked for it', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		pick(modal, 'Rest of the line spoken by', 'participant:Carol');

		await pressSplit(modal);

		expect(sut.editor.lineWith('Go ahead.')).toBe(
			'[[rec.m4a#t=11|0:11]] **Carol** Go ahead.',
		);
	});

	it('asks nothing about the rest when the selection ends the line', async () => {
		const sut = createSut();

		const modal = await openDialog(sut, 'Go ahead.');

		expect(settingNames(modal.contentEl)).not.toContain(
			'Rest of the line spoken by',
		);
	});

	it('moves the start of a line to the speaker picked for it', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Sure.');

		await pressSplit(modal);

		expect(sut.editor.lineWith('Sure.')).toBe(
			'[[rec.m4a#t=5|0:05]] **Bob** Sure.',
		);
	});

	it('refuses a start that leaves the text before the selection no time', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		typeTimes(modal, '0:05', '0:11');

		await pressSplit(modal);

		expect(noticeMessages()).toContainEqual(
			expect.stringContaining('has to start after the line does'),
		);
	});

	it('leaves the note alone when the times are refused', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		typeTimes(modal, '0:05', '0:11');

		await pressSplit(modal);

		expect(sut.editor.content).toBe(renderedNote());
	});

	it('splits only the note when no JSON transcript was recorded', async () => {
		const sut = createSut({
			section: recordedSection({
				fileOutputs: [{ path: SRT_PATH, format: 'srt', writtenAt: '' }],
			}),
		});
		const modal = await openDialog(sut, 'Wait, I have a question.');

		await pressSplit(modal);

		expect(noticeMessages()).toContainEqual(
			expect.stringContaining('1 transcript file was kept as it was'),
		);
	});

	it('explains a selection that holds no spoken text', async () => {
		const sut = createSut();

		const modal = await openDialog(sut, 'Speaker 1');

		expect(modal.contentEl.textContent).toContain(
			'The selection holds none of the spoken text of the line.',
		);
	});

	it('refuses to split over a sidecar that cannot be read', async () => {
		const sut = createSut({ corrupt: true });

		const modal = await openDialog(sut, 'Go ahead.');

		expect(modal.contentEl.textContent).toContain(
			'The sidecar file of this recording could not be read',
		);
	});

	it('refuses to split when reading the sidecar fails', async () => {
		// A failed read leaves the stored roster unknown, and a new speaker
		// numbered without it could take a label already stored there.
		const sut = createSut();
		sut.sidecar.getTranscript.mockRejectedValue(new Error('disk'));
		silenceConsole('warn');

		const modal = await openDialog(sut, 'Go ahead.');

		expect(modal.contentEl.textContent).toContain(
			'The sidecar file of this recording could not be read',
		);
	});

	it('refuses to split when the sidecar became unreadable after the dialog opened', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');
		sut.sidecar.isSidecarCorrupt.mockReturnValue(true);

		await pressSplit(modal);

		expect(noticeMessages()).toContainEqual(
			expect.stringContaining(
				'The sidecar file of this recording could not be read',
			),
		);
		expect(sut.editor.content).toBe(renderedNote());
	});

	it('numbers a new speaker after the roster as it stands when Split is pressed', async () => {
		// Another split, or a transcription, may add a speaker while the
		// dialog is open; the label is taken from what is stored by then.
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		pick(modal, 'Spoken by', 'new');
		sut.sidecar.getTranscript.mockResolvedValue(
			recordedSection({
				speakers: [
					{ label: 'Speaker 1' },
					{ label: 'Speaker 2', name: 'Bob' },
					{ label: 'Speaker 3', name: 'Dana' },
				],
			}),
		);

		await pressSplit(modal);

		expect(sut.sidecar.addSpeakers).toHaveBeenCalledWith(AUDIO_PATH, [
			{ label: 'Speaker 4', firstStart: 6, firstEnd: 11 },
		]);
	});

	it('keeps what a background run wrote to the transcript while the dialog was open', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		const json = sut.app.vault.getFileByPath(JSON_PATH) as TFile;
		await sut.app.vault.modify(
			json,
			JSON.stringify({
				...TRANSCRIPT,
				segments: [
					...TRANSCRIPT.segments,
					{
						start: 20,
						end: 22,
						text: 'Recovered part.',
						speaker: 'Bob',
					},
				],
			}),
		);

		await pressSplit(modal);

		expect((await writtenJson(sut)).segments.map((s) => s.text)).toContain(
			'Recovered part.',
		);
	});

	it('resolves a line moved by an edit the metadata cache has not caught up with', () => {
		const sut = createSut({ staleCache: true });
		// Deleting the heading moves every transcript line up by two.
		sut.editor
			.asEditor()
			.replaceRange('', { line: 0, ch: 0 }, { line: 2, ch: 0 });
		sut.editor.select('Go ahead.');

		expect(contextOf(sut)).toMatchObject({
			seconds: 5,
			lineText: expect.stringContaining('#t=5') as unknown,
		});
	});

	it('ends a note-only line where the editor shows the next line, not the metadata cache', async () => {
		const sut = createSut({
			section: recordedSection({ fileOutputs: [] }),
			staleCache: true,
		});
		const line = sut.editor.lineWith('Go ahead.');
		const row = sut.editor.content.split('\n').indexOf(line);
		sut.editor
			.asEditor()
			.replaceRange(
				'\n\n[[rec.m4a#t=9|0:09]] **Carol** Hm.',
				{ line: row, ch: line.length },
				{ line: row, ch: line.length },
			);

		const modal = await openDialog(sut, 'Sure.');

		// The line runs from 0:05 to the inserted 0:09 line, shared by length.
		expect(timeFields(modal)).toEqual([
			'0:05',
			formatSplitTime(5 + (4 * 'Sure.'.length) / (MIXED_TURN.length - 1)),
		]);
	});

	it('reads no speaker off a line of a transcript that was never diarized', async () => {
		const undiarized: Transcript = {
			segments: [
				{ start: 0, end: 4, text: 'Shall we start?' },
				{ start: 5, end: 13, text: '**Note** buy milk and bread.' },
				{ start: 14, end: 16, text: 'Thanks.' },
			],
			speakers: [],
		};
		const sut = createSut({
			transcript: undiarized,
			section: recordedSection({ speakers: [], participants: [] }),
		});
		const modal = await openDialog(sut, 'bread.');

		await pressSplit(modal);

		expect((await writtenJson(sut)).segments.map((s) => s.text)).toEqual([
			'Shall we start?',
			'**Note** buy milk and',
			'bread.',
			'Thanks.',
		]);
	});

	it('keeps the rest of an undiarized line without a speaker', async () => {
		const sut = createSut({
			transcript: {
				segments: [{ start: 20, end: 26, text: 'one two three' }],
				speakers: [],
			},
		});
		const modal = await openDialog(sut, 'two');

		await pressSplit(modal);

		expect(sut.editor.lineWith('three')).toBe(
			'[[rec.m4a#t=23|0:23]] three',
		);
	});

	it('ends the last line of a note-only transcript at the end of the recording', async () => {
		const sut = createSut({
			section: recordedSection({ fileOutputs: [] }),
		});

		const modal = await openDialog(sut, 'Thanks.');

		expect(timeFields(modal)).toEqual(['0:14', '1:00']);
	});

	it('offers only the start of a last line when the recording cannot be measured', async () => {
		const modal = await openOnUnmeasuredLastLine();

		expect(timeFields(modal)).toEqual(['0:14', '0:14']);
	});

	it('refuses to split a line that changed while the dialog was open', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');
		sut.editor
			.asEditor()
			.replaceRange('Sorry, ', { line: 4, ch: 36 }, { line: 4, ch: 36 });

		await pressSplit(modal);

		expect(noticeMessages()).toContainEqual(
			expect.stringContaining(
				'The line changed while this dialog was open',
			),
		);
	});

	it('says the files stay as they are when the JSON holds no such line', async () => {
		const sut = createSut({
			json: {
				segments: [{ start: 30, end: 31, text: 'Other' }],
				speakers: [],
			},
		});

		const modal = await openDialog(sut, 'Go ahead.');

		expect(modal.contentEl.textContent).toContain(
			'holds no segment matching this line',
		);
	});

	it('plays the entered span', async () => {
		installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');

		clickControl(modal.contentEl, 'Play the selection');

		expect(
			control(modal.contentEl, 'Play the selection').getAttribute(
				'data-icon',
			),
		).toBe('square');
	});

	it('asks for a forward span before playing it', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');
		typeTimes(modal, '0:12', '0:11');

		clickControl(modal.contentEl, 'Play the selection');

		expect(noticeMessages()).toContain(
			'Enter a start and a later end to play the selection.',
		);
	});

	it('stops the span on a second press', async () => {
		installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');
		clickControl(modal.contentEl, 'Play the selection');

		clickControl(modal.contentEl, 'Play the selection');

		expect(
			control(modal.contentEl, 'Play the selection').getAttribute(
				'data-icon',
			),
		).toBe('play');
	});

	it('moves the time fields when a handle is dragged', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		moveHandle(modal, 'Selection start', 7.5, 'input');

		expect(timeFields(modal)).toEqual(['0:07.5', '0:11']);
	});

	it('keeps the start handle from passing the end handle', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		moveHandle(modal, 'Selection start', 12.5, 'input');

		expect(timeFields(modal)).toEqual(['0:11', '0:11']);
	});

	it('keeps the end handle from passing the start handle', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		moveHandle(modal, 'Selection end', 5.5, 'input');

		expect(timeFields(modal)).toEqual(['0:06', '0:06']);
	});

	it('leaves the handles in place while a typed time does not read', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		typeTimes(modal, '0:07', 'soon', { live: true });

		// Still the prefilled 0:06 of the line's 0:05 to 0:13.
		expect(
			spanSlider(modal).style.getPropertyValue('--aar-time-span-start'),
		).toBe('12.5%');
	});

	it('raises the start handle past the middle so handles pushed to the end come apart', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		moveHandle(modal, 'Selection start', 10, 'input');

		expect(
			control(modal.contentEl, 'Selection start').classList.contains(
				'is-raised',
			),
		).toBe(true);
	});

	it('moves the handles to a span typed into the fields', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');

		typeTimes(modal, '0:07', '0:09', { live: true });

		// The bar covers the line, 0:05 to 0:13.
		expect(
			spanSlider(modal).style.getPropertyValue('--aar-time-span-start'),
		).toBe('25%');
		expect(
			spanSlider(modal).style.getPropertyValue('--aar-time-span-end'),
		).toBe('50%');
	});

	it('draws no handles when the end of the line is unknown', async () => {
		const modal = await openOnUnmeasuredLastLine();

		expect(modal.contentEl.querySelector(MODAL.timeSpan)).toBeNull();
	});

	it('follows the playing span with a playhead', async () => {
		const audio = installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		clickControl(modal.contentEl, 'Play the selection');

		audio.advanceTo(9);

		expect(spanSlider(modal).classList.contains('is-playing')).toBe(true);
		expect(
			spanSlider(modal).style.getPropertyValue(
				'--aar-time-span-playhead',
			),
		).toBe('50%');
	});

	it('takes the playhead away once the span has played', async () => {
		const audio = installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		clickControl(modal.contentEl, 'Play the selection');

		audio.advanceTo(11);

		expect(spanSlider(modal).classList.contains('is-playing')).toBe(false);
	});

	it('plays again from where a handle is let go while the span plays', async () => {
		const audio = installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		clickControl(modal.contentEl, 'Play the selection');

		moveHandle(modal, 'Selection start', 8, 'change');

		expect(audio.audio.currentTime).toBeCloseTo(8);
		expect(
			control(modal.contentEl, 'Play the selection').getAttribute(
				'data-icon',
			),
		).toBe('square');
	});

	it('starts nothing when a handle is let go after the span was stopped', async () => {
		const audio = installControlledAudio({ duration: 60 });
		const sut = createSut();
		const modal = await openDialog(sut, 'Wait, I have a question.');
		clickControl(modal.contentEl, 'Play the selection');
		clickControl(modal.contentEl, 'Play the selection');

		moveHandle(modal, 'Selection start', 8, 'change');

		expect(audio.play).toHaveBeenCalledTimes(1);
	});

	it('refuses a line that only mentions the recording', async () => {
		const sut = createSut({
			appended: '\nSee [[rec.m4a#t=5|0:05]] for how it started.\n',
		});

		const modal = await openDialog(sut, 'for how it started');

		expect(modal.contentEl.textContent).toContain(
			'This line does not have the shape the transcript',
		);
	});

	it('quotes a long selection shortened', async () => {
		const long = Array.from(
			{ length: 40 },
			(_, index) => `word${String(index)}`,
		).join(' ');
		const sut = createSut({
			transcript: {
				segments: [{ start: 20, end: 60, text: long, speaker: 'Bob' }],
				speakers: ['Bob'],
			},
		});

		const modal = await openDialog(sut, long);

		expect(settingRow(modal.contentEl, 'Selection').textContent).toContain(
			'...',
		);
	});

	it('closes without touching the note on Cancel', async () => {
		const sut = createSut();
		const modal = await openDialog(sut, 'Go ahead.');

		rowButton(modal.contentEl, 'Cancel').click();

		expect(sut.editor.content).toBe(renderedNote());
	});

	it('does not resolve a selection outside a transcript line', () => {
		const sut = createSut();
		sut.editor.select('Meeting');

		expect(
			transcriptSelectionIn(
				sut.services,
				sut.editor.asEditor(),
				sut.note,
			),
		).toBeNull();
	});
});
