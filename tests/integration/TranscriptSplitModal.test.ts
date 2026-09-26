/**
 * Tests for splitting a transcript line between speakers, driven the way a
 * user drives it: a selection in a note rendered by the transcript renderer is
 * resolved into its line and recording, the dialog is filled in and Split is
 * pressed, and the note, the recorded transcript files and the speaker roster
 * are read back. The vault, the metadata cache and the editor are the shared
 * Obsidian doubles; only the sidecar store is a stub.
 * @jest-environment jsdom
 */

import { App, TFile } from 'obsidian';
import type { Editor, EditorPosition } from 'obsidian';
import { transcriptSelectionIn } from 'src/actions/transcriptActions';
import type {
	ActionServices,
	TranscriptSelectionContext,
} from 'src/actions/PluginAction';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	emptyTranscriptSection,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
} from 'src/transcription/transcriptFormat';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { TranscriptSplitModal } from 'src/ui/TranscriptSplitModal';
import { noticeMessages } from '../mocks/obsidian';
import { partial, silenceConsole } from '../helpers/doubles';
import { asMockApp } from '../helpers/obsidianMock';
import { cachedLink, wordsOf } from '../helpers/transcriptFixtures';
import { flushMicrotasks } from '../helpers/async';
import { allEls, clickControl, control } from '../helpers/dom';
import {
	rowButton,
	rowSelect,
	settingNames,
	settingRow,
} from '../helpers/settingRows';

const NOTE_PATH = 'Notes/meeting.md';
const AUDIO_PATH = 'audio/rec.m4a';
const JSON_PATH = 'audio/rec.transcript.json';
const SRT_PATH = 'audio/rec.srt';

const MIXED_TURN = 'Sure. Wait, I have a question. Go ahead.';

/** A meeting whose middle turn diarization gave to one speaker only. */
const TRANSCRIPT: Transcript = {
	segments: [
		{ start: 0, end: 4, text: 'Shall we start?', speaker: 'Bob' },
		{
			start: 5,
			end: 13,
			text: MIXED_TURN,
			speaker: 'Speaker 1',
			words: wordsOf(MIXED_TURN, 5),
		},
		{ start: 14, end: 16, text: 'Thanks.', speaker: 'Bob' },
	],
	speakers: ['Bob', 'Speaker 1'],
};

const link = (seconds: number, label: string): string =>
	`[[rec.m4a#t=${String(Math.floor(seconds))}|${label}]]`;

/** The note as the transcription wrote it. */
function renderedNote(transcript: Transcript = TRANSCRIPT): string {
	return `# Meeting\n\n${formatTranscriptMarkdown(
		transcript,
		DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
		link,
	)}\n`;
}

/** A section recording the note and both transcript files. */
function recordedSection(
	overrides: Partial<TranscriptSection> = {},
): TranscriptSection {
	return {
		...emptyTranscriptSection(),
		speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2', name: 'Bob' }],
		participants: ['Carol'],
		noteOutputs: [
			{
				path: NOTE_PATH,
				templates: {
					lineFormat: DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS.lineFormat,
					speakerFormat:
						DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS.speakerFormat,
					timestampFormat:
						DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS.timestampFormat,
					includeTimestamps: true,
					timestampLinks: true,
					mergeConsecutiveSpeaker: true,
				},
				heading: '',
				writtenAt: '',
			},
		],
		fileOutputs: [
			{ path: JSON_PATH, format: 'json', writtenAt: '' },
			{ path: SRT_PATH, format: 'srt', writtenAt: '' },
		],
		...overrides,
	};
}

/** An editor over the note's text, holding one selection. */
class FakeEditor {
	private lines: string[];
	private selection: { line: number; from: number; to: number };

	constructor(content: string) {
		this.lines = content.split('\n');
		this.selection = { line: 0, from: 0, to: 0 };
	}

	/** Selects the given text on the first line that holds it. */
	select(text: string): void {
		const line = this.lines.findIndex((candidate) =>
			candidate.includes(text),
		);
		const from = this.lines[line]?.indexOf(text) ?? -1;
		if (line < 0 || from < 0) {
			throw new Error(`No line holds "${text}"`);
		}
		this.selection = { line, from, to: from + text.length };
	}

	get content(): string {
		return this.lines.join('\n');
	}

	/** The line holding the given text, as the note now shows it. */
	lineWith(text: string): string {
		return this.lines.find((line) => line.includes(text)) ?? '';
	}

	asEditor(): Editor {
		return partial<Editor>({
			somethingSelected: () => this.selection.from !== this.selection.to,
			getCursor: (which?: string): EditorPosition => ({
				line: this.selection.line,
				ch: which === 'to' ? this.selection.to : this.selection.from,
			}),
			getLine: (line: number) => this.lines[line] ?? '',
			replaceRange: (
				text: string,
				from: EditorPosition,
				to: EditorPosition,
			) => {
				const head = (this.lines[from.line] ?? '').slice(0, from.ch);
				const tail = (this.lines[to.line] ?? '').slice(to.ch);
				this.lines.splice(
					from.line,
					to.line - from.line + 1,
					...`${head}${text}${tail}`.split('\n'),
				);
			},
		});
	}

	/** The links of the note as the metadata cache reports them. */
	linkCache(): { links: unknown[] } {
		const links: unknown[] = [];
		this.lines.forEach((line, index) => {
			for (const match of line.matchAll(
				/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
			)) {
				links.push(
					cachedLink(
						String(match[1]),
						index,
						match.index,
						match.index + match[0].length,
					),
				);
			}
		});
		return { links };
	}
}

/** Everything a test drives and reads back. */
interface Sut {
	app: App;
	editor: FakeEditor;
	note: TFile;
	sidecar: {
		getTranscript: jest.Mock;
		isSidecarCorrupt: jest.Mock;
		setSpeakers: jest.Mock;
	};
	services: ActionServices;
	probeDuration: jest.Mock;
}

/** What a test varies about the recording it splits a line of. */
interface SutOptions {
	/** The recording's sidecar transcript section. */
	section?: TranscriptSection;
	/** The transcript the note was rendered from. */
	transcript?: Transcript;
	/** What the JSON output holds, when it differs from the note. */
	json?: Transcript;
	/** Whether the sidecar file exists but cannot be read. */
	corrupt?: boolean;
	/** What measuring the recording answers. */
	duration?: Promise<number | null>;
	/** Text appended to the note after the transcript. */
	appended?: string;
}

function createSut(options: SutOptions = {}): Sut {
	const transcript = options.transcript ?? TRANSCRIPT;
	const app = new App();
	const mock = asMockApp(app);
	mock.vault.seed([
		{ path: AUDIO_PATH, data: new ArrayBuffer(8) },
		{ path: NOTE_PATH, content: renderedNote(transcript) },
		{
			path: JSON_PATH,
			content: JSON.stringify(options.json ?? transcript, null, 2),
		},
		{ path: SRT_PATH, content: 'original subtitles' },
	]);
	const audio = app.vault.getFileByPath(AUDIO_PATH);
	const note = app.vault.getFileByPath(NOTE_PATH);
	const editor = new FakeEditor(
		`${renderedNote(transcript)}${options.appended ?? ''}`,
	);
	mock.metadataCache.getFileCache.mockImplementation(() =>
		editor.linkCache(),
	);
	mock.metadataCache.getFirstLinkpathDest.mockImplementation(
		(path: string) => (path === 'rec.m4a' ? audio : null),
	);
	const sidecar = {
		getTranscript: jest
			.fn()
			.mockResolvedValue(options.section ?? recordedSection()),
		isSidecarCorrupt: jest.fn().mockReturnValue(options.corrupt ?? false),
		setSpeakers: jest.fn().mockResolvedValue(undefined),
	};
	const settings = mergeSettings({ transcriptionEnabled: true });
	const services = partial<ActionServices>({
		app,
		getSettings: () => settings,
		recordingSidecar: sidecar,
	});
	if (!note) {
		throw new Error('The note was not seeded');
	}
	const probeDuration = jest
		.fn()
		.mockReturnValue(options.duration ?? Promise.resolve(60));
	return { app, editor, note, sidecar, services, probeDuration };
}

/** Resolves the current selection the way the editor menu does. */
function contextOf(sut: Sut): TranscriptSelectionContext {
	const context = transcriptSelectionIn(
		sut.services,
		sut.editor.asEditor(),
		sut.note,
	);
	if (!context) {
		throw new Error('The selection did not resolve to a transcript line');
	}
	return context;
}

/** Opens the dialog on a selection and waits for it to render. */
async function openDialog(
	sut: Sut,
	selected: string,
): Promise<TranscriptSplitModal> {
	sut.editor.select(selected);
	const modal = new TranscriptSplitModal(sut.app, contextOf(sut), {
		getSettings: sut.services.getSettings,
		sidecar: sut.sidecar,
		probeDuration: sut.probeDuration,
	});
	modal.open();
	await flushMicrotasks(20);
	return modal;
}

/** Picks a dropdown option by value in the named row. */
function pick(modal: TranscriptSplitModal, row: string, value: string): void {
	rowSelect(settingRow(modal.contentEl, row)).value = value;
}

/** Types the selection's start and end into the time fields. */
function typeTimes(
	modal: TranscriptSplitModal,
	start: string,
	end: string,
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

/** The transcript the JSON output holds now. */
async function writtenJson(sut: Sut): Promise<Transcript> {
	const file = sut.app.vault.getFileByPath(JSON_PATH);
	return JSON.parse(await sut.app.vault.read(file as TFile)) as Transcript;
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

		expect(sut.sidecar.setSpeakers).toHaveBeenCalledWith(AUDIO_PATH, [
			{ label: 'Speaker 1' },
			{ label: 'Speaker 2', name: 'Bob' },
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

	it('splits the note on the current templates when the sidecar read fails', async () => {
		const sut = createSut();
		sut.sidecar.getTranscript.mockRejectedValue(new Error('disk'));
		silenceConsole('warn');
		const modal = await openDialog(sut, 'Go ahead.');

		await pressSplit(modal);

		// Nothing but the line itself names a speaker, so the new one is the
		// first label it leaves free.
		expect(sut.editor.lineWith('Go ahead.')).toBe(
			'[[rec.m4a#t=11|0:11]] **Speaker 2** Go ahead.',
		);
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
		const sut = createSut({
			section: recordedSection({ fileOutputs: [] }),
			duration: Promise.reject(new Error('no metadata')),
		});
		silenceConsole('warn');

		const modal = await openDialog(sut, 'Thanks.');

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
