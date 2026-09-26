/**
 * Tests for merging consecutive transcript lines into one, driven the way a
 * user drives it: a selection over lines of a note rendered by the transcript
 * renderer is resolved into its lines and recording, the dialog is filled in
 * and Merge is pressed (and confirmed, for more than two lines), and the note,
 * the recorded transcript files and the speaker roster are read back. The
 * vault, the metadata cache and the editor are the shared Obsidian doubles;
 * only the sidecar store is a stub.
 * @jest-environment jsdom
 */

import type { TFile } from 'obsidian';
import { TRANSCRIPT_ACTIONS } from 'src/actions/transcriptActions';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { TranscriptMergeModal } from 'src/ui/TranscriptMergeModal';
import { modalInstances, noticeMessages } from '../mocks/obsidian';
import { silenceConsole } from '../helpers/doubles';
import { flushMicrotasks } from '../helpers/async';
import { installControlledAudio } from '../helpers/mediaMocks';
import { clickControl, control, maybeControl } from '../helpers/dom';
import { rowButton, rowSelect, settingRow } from '../helpers/settingRows';
import { at } from '../helpers/assertions';
import {
	AUDIO_PATH,
	contextOf,
	createSut,
	JSON_PATH,
	openLineDialog,
	pick,
	recordedSection,
	renderedNote,
	SRT_PATH,
	type Sut,
	type SutOptions,
	writtenJson,
} from '../helpers/transcriptEditHarness';
import { wordsOf } from '../helpers/transcriptFixtures';

/**
 * A meeting where diarization cut Speaker 1's turn in three and gave its
 * middle to Bob, so the note reads as three turns where there was one.
 */
const FRAGMENTED: Transcript = {
	segments: [
		{ start: 0, end: 4, text: 'Shall we start?', speaker: 'Bob' },
		{
			start: 5,
			end: 7,
			text: 'I think',
			speaker: 'Speaker 1',
			words: wordsOf('I think', 5),
		},
		{
			start: 7,
			end: 10,
			text: 'we should wait',
			speaker: 'Bob',
			words: wordsOf('we should wait', 7),
		},
		{
			start: 10,
			end: 12,
			text: 'for Carol.',
			speaker: 'Speaker 1',
			words: wordsOf('for Carol.', 10),
		},
		{ start: 14, end: 16, text: 'Fine.', speaker: 'Bob' },
	],
	speakers: ['Bob', 'Speaker 1'],
};

/** A recording of the fragmented meeting, varied as a test needs. */
function createMergeSut(options: SutOptions = {}): Sut {
	return createSut({ transcript: FRAGMENTED, ...options });
}

/**
 * Opens the dialog on a selection from one text to another and waits for it
 * to render.
 */
async function openDialog(
	sut: Sut,
	first: string,
	last: string,
): Promise<TranscriptMergeModal> {
	sut.editor.selectLines(first, last);
	return openLineDialog(sut, TranscriptMergeModal);
}

/**
 * Presses Merge and lets the writes settle, answering the confirmation with
 * the given button when one is asked.
 * @returns What the confirmation asked, or null when nothing was asked
 */
async function pressMerge(
	modal: TranscriptMergeModal,
	answer: 'Merge' | 'Cancel' = 'Merge',
): Promise<string | null> {
	const opened = modalInstances.length;
	rowButton(modal.contentEl, 'Merge').click();
	await flushMicrotasks(5);
	const confirmation =
		modalInstances.length > opened ? modalInstances.at(-1) : undefined;
	if (!confirmation) {
		await flushMicrotasks(20);
		return null;
	}
	const asked = confirmation.contentEl.textContent;
	rowButton(confirmation.contentEl, answer).click();
	await flushMicrotasks(20);
	return asked;
}

/** The segments of the JSON output, without their word timings. */
async function writtenSegments(sut: Sut): Promise<unknown[]> {
	return (await writtenJson(sut)).segments.map(
		({ start, end, text, speaker }) => ({ start, end, text, speaker }),
	);
}

/** What a setting row of the dialog says under its name. */
function rowText(modal: TranscriptMergeModal, name: string): string {
	return settingRow(modal.contentEl, name).textContent;
}

describe('TranscriptMergeModal', () => {
	describe('merging two lines', () => {
		it("writes one line of the first line's speaker in their place", async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(sut.editor.content).toContain(
				[
					'[[rec.m4a#t=0|0:00]] **Bob** Shall we start?',
					'[[rec.m4a#t=5|0:05]] **Speaker 1** I think we should wait',
					'[[rec.m4a#t=10|0:10]] **Speaker 1** for Carol.',
				].join('\n\n'),
			);
		});

		it('asks nothing before merging', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			expect(await pressMerge(modal)).toBeNull();
		});

		it('merges the segments of the JSON transcript over their span', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(await writtenSegments(sut)).toEqual([
				{ start: 0, end: 4, text: 'Shall we start?', speaker: 'Bob' },
				{
					start: 5,
					end: 10,
					text: 'I think we should wait',
					speaker: 'Speaker 1',
				},
				{
					start: 10,
					end: 12,
					text: 'for Carol.',
					speaker: 'Speaker 1',
				},
				{ start: 14, end: 16, text: 'Fine.', speaker: 'Bob' },
			]);
		});

		it('keeps the word timings of every merged line', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(
				at((await writtenJson(sut)).segments, 1).words?.map(
					(word) => word.text,
				),
			).toEqual(['I', 'think', 'we', 'should', 'wait']);
		});

		it('rewrites the subtitles from the merged transcript', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			const srt = sut.app.vault.getFileByPath(SRT_PATH) as TFile;
			expect(await sut.app.vault.read(srt)).toContain(
				'Speaker 1: I think we should wait',
			);
		});

		it('says what it merged and updated', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(noticeMessages()).toContain(
				'Merged 2 transcript lines into one. Updated 2 transcript files.',
			);
		});

		it('gives the merged line to the speaker picked for it', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			pick(modal, 'Spoken by', 'existing:Bob');

			await pressMerge(modal);

			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Bob** I think we should wait',
			);
		});

		it('merges lines selected whole, from the end of the line above to the start of the line below', async () => {
			const sut = createMergeSut();
			const lines = sut.editor.content.split('\n');
			const above = lines.findIndex((line) => line.includes('Shall'));
			const below = lines.findIndex((line) => line.includes('for Carol'));
			sut.editor.selectRange(
				{ line: above, ch: at(lines, above).length },
				{ line: below, ch: 0 },
			);
			const modal = await openLineDialog(sut, TranscriptMergeModal);

			await pressMerge(modal);

			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 1** I think we should wait',
			);
		});

		it('merges the two turns of one second an interruption left apart', async () => {
			// A timecode link carries whole seconds, so both lines point at
			// 0:45 and only their text tells which segments each one shows.
			const sut = createSut({
				transcript: {
					segments: [
						{
							start: 45.1,
							end: 45.3,
							text: 'Yeah.',
							speaker: 'Bob',
						},
						{
							start: 45.3,
							end: 45.5,
							text: 'What?',
							speaker: 'Speaker 1',
						},
						{ start: 46, end: 49, text: 'Hello.', speaker: 'Bob' },
					],
					speakers: ['Bob', 'Speaker 1'],
				},
			});
			const modal = await openDialog(sut, 'Yeah.', 'What?');

			await pressMerge(modal);

			expect(await writtenSegments(sut)).toEqual([
				{ start: 45.1, end: 45.5, text: 'Yeah. What?', speaker: 'Bob' },
				{ start: 46, end: 49, text: 'Hello.', speaker: 'Bob' },
			]);
		});
	});

	describe('merging more than two lines', () => {
		it('asks before merging, naming the lines and the speaker', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');

			expect(await pressMerge(modal, 'Cancel')).toContain(
				'3 transcript lines become one line spoken by Speaker 1',
			);
		});

		it("names the speaker picked, not the first line's, in the question", async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');
			pick(modal, 'Spoken by', 'new');

			expect(await pressMerge(modal, 'Cancel')).toContain(
				'3 transcript lines become one line spoken by a new speaker',
			);
		});

		it('merges lines of different speakers once confirmed', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');

			await pressMerge(modal, 'Merge');

			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 1** I think we should wait for Carol.',
			);
			expect(await writtenSegments(sut)).toEqual([
				{ start: 0, end: 4, text: 'Shall we start?', speaker: 'Bob' },
				{
					start: 5,
					end: 12,
					text: 'I think we should wait for Carol.',
					speaker: 'Speaker 1',
				},
				{ start: 14, end: 16, text: 'Fine.', speaker: 'Bob' },
			]);
		});

		it('writes nothing when the merge is not confirmed', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');

			await pressMerge(modal, 'Cancel');

			expect(sut.editor.content).toBe(renderedNote(FRAGMENTED));
			expect(await writtenJson(sut)).toEqual(FRAGMENTED);
			expect(sut.sidecar.addSpeakers).not.toHaveBeenCalled();
		});

		it('merges every line of the transcript', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'Shall we start?', 'Fine.');

			await pressMerge(modal, 'Merge');

			expect((await writtenJson(sut)).segments).toHaveLength(1);
			expect(noticeMessages()).toContainEqual(
				expect.stringContaining('Merged 5 transcript lines into one.'),
			);
		});
	});

	describe('the speaker of the merged line', () => {
		it("starts as the first line's speaker", async () => {
			const sut = createMergeSut();

			const modal = await openDialog(sut, 'we should wait', 'for Carol.');

			expect(
				rowSelect(settingRow(modal.contentEl, 'Spoken by')).value,
			).toBe('existing:Bob');
		});

		it('adds a new speaker to the roster with the merged span as its first turn', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			pick(modal, 'Spoken by', 'new');

			await pressMerge(modal);

			expect(sut.sidecar.addSpeakers).toHaveBeenCalledWith(AUDIO_PATH, [
				{ label: 'Speaker 3', firstStart: 5, firstEnd: 10 },
			]);
			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 3** I think we should wait',
			);
		});

		it('adds a participant nobody is named after to the roster, named', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			pick(modal, 'Spoken by', 'participant:Carol');

			await pressMerge(modal);

			expect(sut.sidecar.addSpeakers).toHaveBeenCalledWith(AUDIO_PATH, [
				{
					label: 'Speaker 3',
					name: 'Carol',
					firstStart: 5,
					firstEnd: 10,
				},
			]);
		});

		it('names the rename action in the notice for a new speaker', async () => {
			const sut = createMergeSut({
				settings: { transcriptionSpeakerRenameEnabled: true },
			});
			const modal = await openDialog(sut, 'I think', 'we should wait');
			pick(modal, 'Spoken by', 'new');

			await pressMerge(modal);

			expect(noticeMessages()).toContainEqual(
				expect.stringContaining('so "Rename speakers" can name it.'),
			);
		});

		it('merges the lines of a transcript that was never diarized without a speaker', async () => {
			const sut = createSut({
				transcript: {
					segments: [
						{ start: 0, end: 3, text: 'One sentence' },
						{ start: 3, end: 6, text: 'cut in two.' },
					],
					speakers: [],
				},
				section: recordedSection({ speakers: [], participants: [] }),
			});
			const modal = await openDialog(sut, 'One sentence', 'cut in two.');

			await pressMerge(modal);

			expect(sut.editor.lineWith('One sentence')).toBe(
				'[[rec.m4a#t=0|0:00]] One sentence cut in two.',
			);
			expect(await writtenSegments(sut)).toEqual([
				{
					start: 0,
					end: 6,
					text: 'One sentence cut in two.',
					speaker: undefined,
				},
			]);
		});
	});

	describe('what the dialog shows', () => {
		it('lists the lines by the speakers they show', async () => {
			const sut = createMergeSut();

			const modal = await openDialog(sut, 'I think', 'for Carol.');

			expect(rowText(modal, 'Lines')).toContain(
				'3 lines, shown as Speaker 1, Bob, Speaker 1.',
			);
		});

		it('quotes the merged text', async () => {
			const sut = createMergeSut();

			const modal = await openDialog(sut, 'I think', 'for Carol.');

			expect(rowText(modal, 'Merged text')).toContain(
				'"I think we should wait for Carol."',
			);
		});

		it('shows the span of the whole passage', async () => {
			const sut = createMergeSut();

			const modal = await openDialog(sut, 'I think', 'for Carol.');

			expect(rowText(modal, 'Time span')).toContain('0:05 to 0:12.');
		});

		it('ends a note-only passage where the editor shows the next line', async () => {
			const sut = createMergeSut({
				section: recordedSection({ fileOutputs: [] }),
			});

			const modal = await openDialog(sut, 'I think', 'for Carol.');

			expect(rowText(modal, 'Time span')).toContain('0:05 to 0:14.');
		});

		it('ends a note-only passage of the last lines at the end of the recording', async () => {
			const sut = createMergeSut({
				section: recordedSection({ fileOutputs: [] }),
			});

			const modal = await openDialog(sut, 'for Carol.', 'Fine.');

			expect(rowText(modal, 'Time span')).toContain('0:10 to 1:00.');
		});
	});

	describe('playing the merged passage', () => {
		it('plays the whole passage from its start', async () => {
			const audio = installControlledAudio({ duration: 60 });
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');

			clickControl(modal.contentEl, 'Play the merged passage');

			expect(audio.audio.currentTime).toBeCloseTo(5);
			expect(
				control(
					modal.contentEl,
					'Play the merged passage',
				).getAttribute('data-icon'),
			).toBe('square');
		});

		it('stops at the end of the passage', async () => {
			const audio = installControlledAudio({ duration: 60 });
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');
			clickControl(modal.contentEl, 'Play the merged passage');

			audio.advanceTo(12);

			expect(
				control(
					modal.contentEl,
					'Play the merged passage',
				).getAttribute('data-icon'),
			).toBe('play');
		});

		it('plays it again after it has played', async () => {
			const audio = installControlledAudio({ duration: 60 });
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');
			clickControl(modal.contentEl, 'Play the merged passage');
			audio.advanceTo(12);

			clickControl(modal.contentEl, 'Play the merged passage');

			expect(audio.audio.currentTime).toBeCloseTo(5);
			expect(audio.play).toHaveBeenCalledTimes(2);
		});

		it('stops the passage on a second press', async () => {
			installControlledAudio({ duration: 60 });
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'for Carol.');
			clickControl(modal.contentEl, 'Play the merged passage');

			clickControl(modal.contentEl, 'Play the merged passage');

			expect(
				control(
					modal.contentEl,
					'Play the merged passage',
				).getAttribute('data-icon'),
			).toBe('play');
		});

		it('offers nothing to play when the end of the last line is unknown', async () => {
			silenceConsole('warn');
			const sut = createMergeSut({
				section: recordedSection({ fileOutputs: [] }),
				duration: Promise.reject(new Error('no metadata')),
			});

			const modal = await openDialog(sut, 'for Carol.', 'Fine.');

			expect(
				maybeControl(modal.contentEl, 'Play the merged passage'),
			).toBeNull();
			expect(rowText(modal, 'Time span')).toContain(
				'the passage cannot be played',
			);
		});
	});

	describe('the transcript files', () => {
		it('merges only the note when no JSON transcript was recorded', async () => {
			const sut = createMergeSut({
				section: recordedSection({
					fileOutputs: [
						{ path: SRT_PATH, format: 'srt', writtenAt: '' },
					],
				}),
			});
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 1** I think we should wait',
			);
			expect(
				await sut.app.vault.read(
					sut.app.vault.getFileByPath(SRT_PATH) as TFile,
				),
			).toBe('original subtitles');
			expect(noticeMessages()).toContain(
				'Merged 2 transcript lines into one. 1 transcript file was kept as it was: only a JSON transcript holding these lines keeps the timings a merge needs.',
			);
		});

		it('says beforehand that only the note changes without a JSON transcript', async () => {
			const sut = createMergeSut({
				section: recordedSection({
					fileOutputs: [
						{ path: SRT_PATH, format: 'srt', writtenAt: '' },
					],
				}),
			});

			const modal = await openDialog(sut, 'I think', 'we should wait');

			expect(modal.contentEl.textContent).toContain(
				'only a JSON transcript keeps the timings a merge needs',
			);
		});

		it('keeps the files when the JSON holds a turn between the lines the note does not show', async () => {
			// A line deleted by hand: merging over the gap would fold a turn
			// nobody selected into the merged one.
			const sut = createMergeSut({
				json: {
					...FRAGMENTED,
					segments: [
						...FRAGMENTED.segments.slice(0, 2),
						{ start: 6.5, end: 6.9, text: 'Hm.', speaker: 'Anna' },
						...FRAGMENTED.segments.slice(2),
					],
				},
			});
			const modal = await openDialog(sut, 'I think', 'we should wait');

			expect(modal.contentEl.textContent).toContain(
				'holds no unbroken run of segments matching these lines',
			);

			await pressMerge(modal);

			expect(
				(await writtenJson(sut)).segments.map(
					(segment) => segment.text,
				),
			).toContain('Hm.');
		});

		it('keeps what a background run wrote to the transcript while the dialog was open', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			await sut.app.vault.modify(
				sut.app.vault.getFileByPath(JSON_PATH) as TFile,
				JSON.stringify({
					...FRAGMENTED,
					segments: [
						...FRAGMENTED.segments,
						{
							start: 20,
							end: 22,
							text: 'Recovered part.',
							speaker: 'Bob',
						},
					],
				}),
			);

			await pressMerge(modal);

			expect(
				(await writtenJson(sut)).segments.map(
					(segment) => segment.text,
				),
			).toEqual([
				'Shall we start?',
				'I think we should wait',
				'for Carol.',
				'Fine.',
				'Recovered part.',
			]);
		});

		it('writes the merged line with the templates the note was written with, not the current settings', async () => {
			const sut = createMergeSut({
				settings: {
					transcriptSpeakerFormat: '[{speaker}]:',
					transcriptLineFormat: '{speaker} {timestamp} {text}',
				},
			});
			const modal = await openDialog(sut, 'I think', 'we should wait');

			await pressMerge(modal);

			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 1** I think we should wait',
			);
		});
	});

	describe('refusing a merge', () => {
		it('refuses lines with a remark between them', async () => {
			const sut = createMergeSut();
			const lines = sut.editor.content.split('\n');
			const row = lines.findIndex((line) => line.includes('I think'));
			sut.editor
				.asEditor()
				.replaceRange(
					'\n\nA remark of mine.',
					{ line: row, ch: at(lines, row).length },
					{ line: row, ch: at(lines, row).length },
				);

			const modal = await openDialog(sut, 'I think', 'we should wait');

			expect(modal.contentEl.textContent).toContain(
				"The selection holds a line that is not a line of this recording's transcript",
			);
			expect(() => rowButton(modal.contentEl, 'Merge')).toThrow(
				'No button labelled "Merge"',
			);
		});

		it('refuses a line that only mentions the recording', async () => {
			const sut = createMergeSut({
				appended: '\nSee [[rec.m4a#t=5|0:05]] for how it started.\n',
			});

			const modal = await openDialog(sut, 'Fine.', 'for how it started');

			expect(modal.contentEl.textContent).toContain(
				"is not a line of this recording's transcript",
			);
		});

		it('refuses to merge over a sidecar that cannot be read', async () => {
			const sut = createMergeSut({ corrupt: true });

			const modal = await openDialog(sut, 'I think', 'we should wait');

			expect(modal.contentEl.textContent).toContain(
				'The sidecar file of this recording could not be read',
			);
		});

		it('refuses to merge when the sidecar became unreadable after the dialog opened', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			sut.sidecar.isSidecarCorrupt.mockReturnValue(true);

			await pressMerge(modal);

			expect(sut.editor.content).toBe(renderedNote(FRAGMENTED));
			expect(noticeMessages()).toContainEqual(
				expect.stringContaining('could not be read'),
			);
		});

		it('refuses to merge lines that changed while the dialog was open', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');
			const lines = sut.editor.content.split('\n');
			const row = lines.findIndex((line) => line.includes('should'));
			sut.editor
				.asEditor()
				.replaceRange(
					' really',
					{ line: row, ch: at(lines, row).length },
					{ line: row, ch: at(lines, row).length },
				);

			await pressMerge(modal);

			expect(noticeMessages()).toContain(
				'The lines changed while this dialog was open. Select them again.',
			);
			expect(sut.editor.lineWith('I think')).toBe(
				'[[rec.m4a#t=5|0:05]] **Speaker 1** I think',
			);
		});

		it('closes without touching the note on Cancel', async () => {
			const sut = createMergeSut();
			const modal = await openDialog(sut, 'I think', 'we should wait');

			rowButton(modal.contentEl, 'Cancel').click();

			expect(sut.editor.content).toBe(renderedNote(FRAGMENTED));
		});
	});

	describe('the action', () => {
		const [split, merge] = TRANSCRIPT_ACTIONS;

		it('is offered on a selection over consecutive lines, and the split is not', () => {
			const sut = createMergeSut();
			sut.editor.selectLines('I think', 'we should wait');
			const context = contextOf(sut);

			expect(merge?.isAvailable(context)).toBe(true);
			expect(split?.isAvailable(context)).toBe(false);
		});

		it('is not offered on a selection inside one line, where the split is', () => {
			const sut = createMergeSut();
			sut.editor.select('I think');
			const context = contextOf(sut);

			expect(merge?.isAvailable(context)).toBe(false);
			expect(split?.isAvailable(context)).toBe(true);
		});

		it('is not offered while transcription is disabled', () => {
			const sut = createMergeSut({
				settings: { transcriptionEnabled: false },
			});
			sut.editor.selectLines('I think', 'we should wait');

			expect(merge?.isAvailable(contextOf(sut))).toBe(false);
		});
	});
});
