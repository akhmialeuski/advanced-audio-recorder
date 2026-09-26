/**
 * The vault, note, editor and sidecar a transcript line edit - a split of a
 * line between speakers, or a merge of consecutive lines - is driven over: a
 * note rendered by the transcript renderer, an editor over it holding a
 * selection, the recorded JSON and subtitle files, and a stubbed sidecar
 * store. The vault, the metadata cache and the editor are the shared Obsidian
 * doubles.
 * @module tests/helpers/transcriptEditHarness
 */

import { App, TFile } from 'obsidian';
import type { Editor, EditorPosition } from 'obsidian';
import { transcriptSelectionIn } from 'src/actions/transcriptActions';
import type {
	ActionServices,
	TranscriptSelectionContext,
} from 'src/actions/PluginAction';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
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
import type { TranscriptEditModalOptions } from 'src/ui/transcriptLineDialog';
import { flushMicrotasks } from './async';
import { partial } from './doubles';
import { asMockApp } from './obsidianMock';
import { rowSelect, settingRow } from './settingRows';
import { cachedLink, wordsOf } from './transcriptFixtures';

export const NOTE_PATH = 'Notes/meeting.md';
export const AUDIO_PATH = 'audio/rec.m4a';
export const JSON_PATH = 'audio/rec.transcript.json';
export const SRT_PATH = 'audio/rec.srt';

export const MIXED_TURN = 'Sure. Wait, I have a question. Go ahead.';

/** A meeting whose middle turn diarization gave to one speaker only. */
export const TRANSCRIPT: Transcript = {
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

/** A timecode link as the note's transcript writes it. */
export const link = (seconds: number, label: string): string =>
	`[[rec.m4a#t=${String(Math.floor(seconds))}|${label}]]`;

/** The note as the transcription wrote it. */
export function renderedNote(transcript: Transcript = TRANSCRIPT): string {
	return `# Meeting\n\n${formatTranscriptMarkdown(
		transcript,
		DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
		link,
	)}\n`;
}

/** A section recording the note and both transcript files. */
export function recordedSection(
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
export class FakeEditor {
	private lines: string[];
	private selection: { from: EditorPosition; to: EditorPosition };

	constructor(content: string) {
		this.lines = content.split('\n');
		const start = { line: 0, ch: 0 };
		this.selection = { from: start, to: start };
	}

	/** Selects the given text on the first line that holds it. */
	select(text: string): void {
		const from = this.find(text);
		this.selection = {
			from,
			to: { line: from.line, ch: from.ch + text.length },
		};
	}

	/**
	 * Selects from the start of one text to the end of another, each found on
	 * the first line that holds it, the way a drag over several lines does.
	 */
	selectLines(first: string, last: string): void {
		const end = this.find(last);
		this.selection = {
			from: this.find(first),
			to: { line: end.line, ch: end.ch + last.length },
		};
	}

	/** Selects between two positions exactly as given. */
	selectRange(from: EditorPosition, to: EditorPosition): void {
		this.selection = { from, to };
	}

	/** Where the given text starts on the first line that holds it. */
	private find(text: string): EditorPosition {
		const line = this.lines.findIndex((candidate) =>
			candidate.includes(text),
		);
		const ch = this.lines[line]?.indexOf(text) ?? -1;
		if (line < 0 || ch < 0) {
			throw new Error(`No line holds "${text}"`);
		}
		return { line, ch };
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
			somethingSelected: () =>
				this.selection.from.line !== this.selection.to.line ||
				this.selection.from.ch !== this.selection.to.ch,
			getCursor: (which?: string): EditorPosition => ({
				...(which === 'to' ? this.selection.to : this.selection.from),
			}),
			getLine: (line: number) => this.lines[line] ?? '',
			lineCount: () => this.lines.length,
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
export interface Sut {
	app: App;
	editor: FakeEditor;
	note: TFile;
	sidecar: {
		getTranscript: jest.Mock;
		isSidecarCorrupt: jest.Mock;
		addSpeakers: jest.Mock;
	};
	services: ActionServices;
	probeDuration: jest.Mock;
}

/** What a test varies about the recording it splits a line of. */
export interface SutOptions {
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
	/** Plugin settings on top of transcription being enabled. */
	settings?: Partial<AudioRecorderSettings>;
	/**
	 * Whether the metadata cache keeps reporting the note as first seeded,
	 * the way it trails the editor until the note is saved and parsed again.
	 */
	staleCache?: boolean;
}

export function createSut(options: SutOptions = {}): Sut {
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
	const seededCache = editor.linkCache();
	mock.metadataCache.getFileCache.mockImplementation(() =>
		options.staleCache ? seededCache : editor.linkCache(),
	);
	mock.metadataCache.getFirstLinkpathDest.mockImplementation(
		(path: string) => (path === 'rec.m4a' ? audio : null),
	);
	const sidecar = {
		getTranscript: jest
			.fn()
			.mockResolvedValue(options.section ?? recordedSection()),
		isSidecarCorrupt: jest.fn().mockReturnValue(options.corrupt ?? false),
		addSpeakers: jest.fn().mockResolvedValue(undefined),
	};
	const settings = mergeSettings({
		transcriptionEnabled: true,
		...options.settings,
	});
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
export function contextOf(sut: Sut): TranscriptSelectionContext {
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

/** The transcript the JSON output holds now. */
export async function writtenJson(sut: Sut): Promise<Transcript> {
	const file = sut.app.vault.getFileByPath(JSON_PATH);
	return JSON.parse(await sut.app.vault.read(file as TFile)) as Transcript;
}

/** Picks a dropdown option by value in the named row of a dialog. */
export function pick(
	modal: { contentEl: HTMLElement },
	row: string,
	value: string,
): void {
	rowSelect(settingRow(modal.contentEl, row)).value = value;
}

/** A dialog that edits transcript lines, as its action constructs it. */
type LineDialog<M> = new (
	app: App,
	context: TranscriptSelectionContext,
	options: TranscriptEditModalOptions,
) => M;

/**
 * Opens a transcript line dialog on the editor's selection, with the
 * collaborators the action gives it, and waits for it to render.
 * @param sut - The recording and note the dialog works on
 * @param Dialog - The dialog class
 * @returns The open dialog
 */
export async function openLineDialog<M extends { open(): void }>(
	sut: Sut,
	Dialog: LineDialog<M>,
): Promise<M> {
	const modal = new Dialog(sut.app, contextOf(sut), {
		getSettings: sut.services.getSettings,
		sidecar: sut.sidecar,
		probeDuration: sut.probeDuration,
	});
	modal.open();
	await flushMicrotasks(20);
	return modal;
}
