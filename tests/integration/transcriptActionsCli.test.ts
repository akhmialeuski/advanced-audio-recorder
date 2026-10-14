/**
 * Tests for the transcript line edits as the command line runs them: the
 * note's lines named by number and the words by their text instead of a
 * selection, every name checked before anything is read further, the edit
 * the dialog would make written into the note itself, and an edit refused
 * when the lines moved in the meantime.
 * @jest-environment jsdom
 */

import type { CliData } from 'obsidian';
import {
	speakerChoiceNamed,
	TRANSCRIPT_ACTIONS,
	transcriptActionFamily,
} from 'src/actions/transcriptActions';
import type { TranscriptSelectionContext } from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import type { LineSpeakerOption } from 'src/speakers/transcriptRows';
import {
	AUDIO_PATH,
	createSut,
	FRAGMENTED,
	MIXED_TURN,
	NOTE_PATH,
	renderedNote,
	type Sut,
} from '../helpers/transcriptEditHarness';
import { asMockApp } from '../helpers/obsidianMock';
import { createMarkdownView } from '../helpers/createApp';
import { silenceConsole } from '../helpers/doubles';

jest.mock('src/utils/mediaDuration', () => ({
	...jest.requireActual<object>('src/utils/mediaDuration'),
	probeMediaDurationSeconds: jest.fn().mockResolvedValue(60),
}));

/**
 * The number the editor shows for the line holding the text.
 * @param text - Text on the line
 * @param transcript - The transcript the note was rendered from
 */
function lineOf(text: string, transcript?: Transcript): string {
	const index = renderedNote(transcript)
		.split('\n')
		.findIndex((line) => line.includes(text));
	if (index < 0) {
		throw new Error(`No line holds "${text}"`);
	}
	return String(index + 1);
}

/** How many lines the editor numbers in the rendered note. */
const LINE_COUNT = String(renderedNote().split('\n').length);

/** The lines the arguments name, or the refusal. */
function resolve(
	sut: Sut,
	args: CliData,
): Promise<readonly TranscriptSelectionContext[] | string> {
	return Promise.resolve(
		transcriptActionFamily(sut.services).cliTarget.resolve(args),
	);
}

/** The one selection the arguments name; fails the test on a refusal. */
async function selection(
	sut: Sut,
	args: CliData,
): Promise<TranscriptSelectionContext> {
	const resolved = await resolve(sut, { path: NOTE_PATH, ...args });
	if (typeof resolved === 'string' || !resolved[0]) {
		throw new Error(
			`Expected lines, got: ${typeof resolved === 'string' ? resolved : 'none'}`,
		);
	}
	return resolved[0];
}

/** The action of the given command id. */
function action(commandId: string): (typeof TRANSCRIPT_ACTIONS)[number] {
	const found = TRANSCRIPT_ACTIONS.find(
		(entry) => entry.commandId === commandId,
	);
	if (!found) {
		throw new Error(`No transcript action ${commandId}`);
	}
	return found;
}

/**
 * Runs an action on the lines the arguments name, the way the command line
 * runs it.
 */
async function execute(
	sut: Sut,
	commandId: string,
	args: CliData,
): Promise<string> {
	const context = await selection(sut, args);
	return Promise.resolve(action(commandId).cli.execute(context, args));
}

/** The note's text as the vault holds it now. */
const noteNow = (sut: Sut): Promise<string> => sut.app.vault.read(sut.note);

describe('the lines a command line names', () => {
	it('takes the whole line when no words are named', async () => {
		const context = await selection(createSut(), {
			line: lineOf(MIXED_TURN),
		});

		expect(context).toEqual(
			expect.objectContaining({
				line: Number(lineOf(MIXED_TURN)) - 1,
				lastLine: Number(lineOf(MIXED_TURN)) - 1,
				from: 0,
				to: context.lineText.length,
				seconds: 5,
			}),
		);
		expect(context.audio.path).toBe(AUDIO_PATH);
	});

	it('takes the words named on the line', async () => {
		const context = await selection(createSut(), {
			line: lineOf(MIXED_TURN),
			text: 'Wait, I have a question.',
		});

		expect(context.lineText.slice(context.from, context.to)).toBe(
			'Wait, I have a question.',
		);
	});

	it('takes a range of lines with to', async () => {
		const sut = createSut({ transcript: FRAGMENTED });

		const context = await selection(sut, {
			line: lineOf('I think', FRAGMENTED),
			to: lineOf('for Carol.', FRAGMENTED),
		});

		// The blank lines between them too, as a selection dragged over them
		// holds them.
		expect(context.lineTexts).toHaveLength(5);
		expect(context.lineTexts[4]).toContain('for Carol.');
		expect(transcriptActionFamily(sut.services).describe(context)).toBe(
			`line ${lineOf('I think', FRAGMENTED)} of ${NOTE_PATH}`,
		);
	});

	it('reads the active note when none is named', async () => {
		const sut = createSut();
		asMockApp(sut.app).workspace.seedActiveFile(sut.note);

		await expect(
			resolve(sut, { line: lineOf(MIXED_TURN) }),
		).resolves.toHaveLength(1);
	});

	it.each([
		{
			name: 'no note is named or open',
			args: { line: '3' },
			refusal:
				'Name the note of the transcript with file=<name> or path=<vault path>, or open it in Obsidian.',
		},
		{
			name: 'the file named is no note',
			args: { path: AUDIO_PATH, line: '3' },
			refusal:
				'Name the note of the transcript with file=<name> or path=<vault path>, or open it in Obsidian.',
		},
		{
			name: 'the file named is not there',
			args: { path: 'Notes/other.md', line: '3' },
			refusal: 'No file at "Notes/other.md" in this vault.',
		},
		{
			name: 'no line is named',
			args: { path: NOTE_PATH },
			refusal:
				'Name the line with line=<number>, as the editor numbers it.',
		},
		{
			name: 'the line is past the end',
			args: { path: NOTE_PATH, line: '999' },
			refusal: `line=999 is not a whole number from 1 to ${LINE_COUNT}.`,
		},
		{
			name: 'the range is past the end',
			args: { path: NOTE_PATH, line: '3', to: '999' },
			refusal: `to=999 is not a whole number from 1 to ${LINE_COUNT}.`,
		},
		{
			name: 'the range runs backwards',
			args: { path: NOTE_PATH, line: '5', to: '3' },
			refusal: 'to= comes before line=.',
		},
		{
			name: 'the line is not a transcript line',
			args: { path: NOTE_PATH, line: '1' },
			refusal: `Line 1 of ${NOTE_PATH} carries no timecode link to a recording.`,
		},
		{
			name: 'the words are not on the line',
			args: { path: NOTE_PATH, line: lineOf(MIXED_TURN), text: 'Hello' },
			refusal: 'The line does not hold "Hello".',
		},
		{
			name: 'the words are on the line twice',
			args: { path: NOTE_PATH, line: lineOf(MIXED_TURN), text: 'a' },
			refusal:
				'"a" appears more than once on the line; quote more of it.',
		},
	])('refuses when $name', async ({ args, refusal }) => {
		await expect(resolve(createSut(), args)).resolves.toBe(refusal);
	});
});

describe('the speaker a command line names', () => {
	const options: LineSpeakerOption[] = [
		{
			value: 'existing:Bob',
			title: 'Bob',
			choice: { kind: 'existing', name: 'Bob' },
		},
		{
			value: 'participant:Carol',
			title: 'Carol',
			choice: { kind: 'participant', name: 'Carol' },
		},
		{ value: 'new', title: 'New speaker', choice: { kind: 'new' } },
		{ value: 'none', title: 'No speaker', choice: { kind: 'none' } },
	];

	it.each([
		{ name: 'bob', choice: { kind: 'existing', name: 'Bob' } },
		{ name: 'Carol', choice: { kind: 'participant', name: 'Carol' } },
		{ name: 'new', choice: { kind: 'new' } },
		{ name: 'none', choice: { kind: 'none' } },
	])('picks $name', ({ name, choice }) => {
		expect(speakerChoiceNamed(options, name)).toEqual(choice);
	});

	it('names the speakers to choose from for one that is not there', () => {
		expect(speakerChoiceNamed(options, 'Dave')).toBe(
			'No speaker "Dave" to choose. Choose one of: Bob, Carol, new, none.',
		);
	});
});

describe('splitting a line from the command line', () => {
	const split = COMMAND_IDS.splitTranscriptSelection;

	it('gives the words named to the speaker named', async () => {
		const sut = createSut();

		await execute(sut, split, {
			line: lineOf(MIXED_TURN),
			text: 'Wait, I have a question.',
			speaker: 'carol',
			rest: 'new',
		});

		const note = await noteNow(sut);
		expect(note).toContain('**Speaker 1** Sure.');
		expect(note).toContain('**Carol** Wait, I have a question.');
		// A new speaker, numbered past every label and name in use.
		expect(note).toContain('**Speaker 4** Go ahead.');
		expect(note).not.toContain(MIXED_TURN);
	});

	it('gives the words to the speaker the dialog starts on when none is named', async () => {
		const sut = createSut();

		const answer = await execute(sut, split, {
			line: lineOf(MIXED_TURN),
			text: 'Wait, I have a question.',
		});

		// The first speaker other than the line's own, as the dialog starts.
		expect(answer).toBe(
			'Split the transcript line. Updated 2 transcript files.',
		);
		const note = await noteNow(sut);
		expect(note).toContain('**Speaker 1** Sure.');
		expect(note).toContain('**Bob** Wait, I have a question.');
		expect(note).toContain('**Speaker 1** Go ahead.');
	});

	it('refuses a speaker that is not one to choose', async () => {
		const sut = createSut();

		await expect(
			execute(sut, split, {
				line: lineOf(MIXED_TURN),
				text: 'Wait, I have a question.',
				speaker: 'Dave',
			}),
		).resolves.toMatch(/^No speaker "Dave" to choose\./);
		await expect(noteNow(sut)).resolves.toBe(renderedNote());
	});

	it('refuses a speaker for the rest that is not one to choose', async () => {
		await expect(
			execute(createSut(), split, {
				line: lineOf(MIXED_TURN),
				text: 'Wait, I have a question.',
				rest: 'Dave',
			}),
		).resolves.toMatch(/^No speaker "Dave" to choose\./);
	});

	it('picks no speaker for a rest when the words run to the end', async () => {
		const sut = createSut();

		await expect(
			execute(sut, split, {
				line: lineOf(MIXED_TURN),
				text: 'Go ahead.',
				speaker: 'Bob',
				rest: 'Dave',
			}),
		).resolves.toMatch(/^Split/);
	});

	it('writes nothing when the line changed after it was read', async () => {
		const sut = createSut();
		const context = await selection(sut, { line: lineOf(MIXED_TURN) });
		await sut.app.vault.modify(
			sut.note,
			renderedNote().replace(MIXED_TURN, 'Edited.'),
		);

		await expect(
			Promise.resolve(
				action(split).cli.execute(context, { speaker: 'Bob' }),
			),
		).rejects.toThrow(
			'The lines changed while the command ran. Run it again on the lines as they are now.',
		);
	});

	it('is not offered over several lines, saying why', async () => {
		const context = await selection(createSut({ transcript: FRAGMENTED }), {
			line: lineOf('I think', FRAGMENTED),
			to: lineOf('we should wait', FRAGMENTED),
		});

		expect(action(split).isAvailable(context)).toBe(false);
		expect(action(split).cli.unavailable?.(context)).toBe(
			'A split works on one line: leave out to.',
		);
	});
});

describe('merging lines from the command line', () => {
	const merge = COMMAND_IDS.mergeTranscriptLines;

	it("merges two lines under the first one's speaker", async () => {
		const sut = createSut({ transcript: FRAGMENTED });

		const answer = await execute(sut, merge, {
			line: lineOf('I think', FRAGMENTED),
			to: lineOf('we should wait', FRAGMENTED),
		});

		expect(answer).toMatch(/^Merged 2/);
		await expect(noteNow(sut)).resolves.toContain('I think we should wait');
	});

	it('asks for confirm before merging more than two', async () => {
		const sut = createSut({ transcript: FRAGMENTED });
		const args = {
			line: lineOf('I think', FRAGMENTED),
			to: lineOf('for Carol.', FRAGMENTED),
		};

		await expect(execute(sut, merge, args)).resolves.toMatch(
			/^3 transcript lines become one line spoken by .*Add confirm to merge them\.$/,
		);
		await expect(noteNow(sut)).resolves.toBe(renderedNote(FRAGMENTED));
	});

	it('merges more than two with confirm, under the speaker named', async () => {
		const sut = createSut({ transcript: FRAGMENTED });

		const answer = await execute(sut, merge, {
			line: lineOf('I think', FRAGMENTED),
			to: lineOf('for Carol.', FRAGMENTED),
			speaker: 'Carol',
			confirm: 'true',
		});

		expect(answer).toMatch(/^Merged 3/);
		await expect(noteNow(sut)).resolves.toContain(
			'I think we should wait for Carol.',
		);
	});

	it('refuses a speaker that is not one to choose', async () => {
		await expect(
			execute(createSut({ transcript: FRAGMENTED }), merge, {
				line: lineOf('I think', FRAGMENTED),
				to: lineOf('we should wait', FRAGMENTED),
				speaker: 'Dave',
			}),
		).resolves.toMatch(/^No speaker "Dave" to choose\./);
	});

	it('is not offered over one line, saying how to name more', async () => {
		const context = await selection(createSut(), {
			line: lineOf(MIXED_TURN),
		});

		expect(action(merge).isAvailable(context)).toBe(false);
		expect(action(merge).cli.unavailable?.(context)).toBe(
			'A merge needs two lines or more: name the last one with to=<line>.',
		);
	});
});

describe('with transcription switched off', () => {
	it.each([
		COMMAND_IDS.splitTranscriptSelection,
		COMMAND_IDS.mergeTranscriptLines,
	])('%s says so', async (commandId) => {
		const context = await selection(
			createSut({ settings: { transcriptionEnabled: false } }),
			{ line: lineOf(MIXED_TURN) },
		);

		expect(action(commandId).cli.unavailable?.(context)).toBe(
			'Transcription is switched off in settings.',
		);
	});
});

describe('the lines the palette acts on', () => {
	it('is the selection of the active editor', () => {
		const sut = createSut();
		sut.editor.select('Wait, I have a question.');
		const view = createMarkdownView({ file: sut.note });
		Object.assign(view, { editor: sut.editor.asEditor() });
		asMockApp(sut.app).workspace.seedActiveView(view);

		const [target] = transcriptActionFamily(sut.services).activeTargets();

		expect(target?.lineText.slice(target.from, target.to)).toBe(
			'Wait, I have a question.',
		);
	});

	it('is none without an editor', () => {
		expect(
			transcriptActionFamily(createSut().services).activeTargets(),
		).toEqual([]);
	});
});

describe('lines whose recording cannot be edited', () => {
	it.each([
		COMMAND_IDS.splitTranscriptSelection,
		COMMAND_IDS.mergeTranscriptLines,
	])('%s answers why, writing nothing', async (commandId) => {
		silenceConsole('warn');
		const transcript =
			commandId === COMMAND_IDS.mergeTranscriptLines
				? FRAGMENTED
				: undefined;
		const sut = createSut({
			corrupt: true,
			...(transcript ? { transcript } : {}),
		});
		const args =
			commandId === COMMAND_IDS.mergeTranscriptLines
				? {
						line: lineOf('I think', FRAGMENTED),
						to: lineOf('we should wait', FRAGMENTED),
					}
				: { line: lineOf(MIXED_TURN) };

		await expect(execute(sut, commandId, args)).resolves.toMatch(
			/sidecar/i,
		);
		await expect(noteNow(sut)).resolves.toBe(renderedNote(transcript));
	});
});
