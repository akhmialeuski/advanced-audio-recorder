/**
 * Tests for writing a recording's markers out: which representation goes
 * where, and what the user is told when the place it was headed refuses it.
 * @jest-environment jsdom
 */

import { App, TFile } from 'obsidian';
import { ChapterExportModal } from 'src/ui/ChapterExportModal';
import type { PlayerMarker } from 'src/markers/markerModel';
import { createMockApp } from '../helpers/createApp';
import { noticeMessages } from '../mocks/obsidian';
import { tick } from '../helpers/async';
import { at } from '../helpers/assertions';
import { internalsOf, silenceConsole } from '../helpers/doubles';

jest.mock('src/transcription/transcriptOutput', () => ({
	insertTranscriptIntoNote: jest.fn(() => true),
}));

const { insertTranscriptIntoNote } = jest.requireMock<{
	insertTranscriptIntoNote: jest.Mock;
}>('src/transcription/transcriptOutput');

const MARKERS: PlayerMarker[] = [
	{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
	{ id: 'b', time: 125, label: 'Middle', kind: 'chapter' },
];

interface Sut {
	modal: ChapterExportModal;
	created: Map<string, string>;
	clipboard: jest.Mock;
}

/** Opens the dialog over a recording with the given markers. */
function createSut(
	markers: PlayerMarker[] = MARKERS,
	notePath = 'note.md',
): Sut {
	const created = new Map<string, string>();
	const clipboard = jest.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: clipboard },
	});
	const app = createMockApp({
		vault: {
			create: (path: string, data: string) => {
				created.set(path, data);
				return Promise.resolve({ path });
			},
			adapter: { exists: () => Promise.resolve(false) },
		},
	}).app;
	const modal = new ChapterExportModal(app, {
		file: Object.assign(Object.create(TFile.prototype), {
			path: 'Recordings/talk.webm',
			name: 'talk.webm',
			basename: 'talk',
		}) as TFile,
		markers,
		notePath,
		linkBuilder: (seconds, label) =>
			`[[talk#t=${String(Math.floor(seconds))}|${label}]]`,
	});
	modal.onOpen();
	return { modal, created, clipboard };
}

/** Chooses a value in the dialog's nth dropdown. */
function choose(modal: ChapterExportModal, index: number, value: string): void {
	const select = at(
		Array.from(modal.contentEl.querySelectorAll('select')),
		index,
	);
	select.value = value;
	select.dispatchEvent(new Event('change'));
}

/** Presses the dialog button with the given label. */
function press(modal: ChapterExportModal, text: string): void {
	const button = Array.from(modal.contentEl.querySelectorAll('button')).find(
		(candidate) => candidate.textContent === text,
	);
	if (!button) {
		throw new Error(`The dialog offers no ${text} button`);
	}
	button.click();
}

describe('what the export dialog offers', () => {
	it('says how many markers it is about to write', () => {
		const { modal } = createSut();

		expect(modal.contentEl.textContent).toContain(
			'2 markers from talk.webm',
		);
	});

	it('counts one marker in the singular', () => {
		const { modal } = createSut([at(MARKERS, 0)]);

		expect(modal.contentEl.textContent).toContain('1 marker from');
	});

	it('asks where to send only the outline, which is the only one with a choice', () => {
		const { modal } = createSut();
		const settings = Array.from(
			modal.contentEl.querySelectorAll<HTMLElement>('.setting-item'),
		);
		const target = at(settings, 1);

		expect(target.style.display).toBe('none');

		choose(modal, 0, 'outline');
		expect(target.style.display).not.toBe('none');
	});
});

describe('writing a file beside the recording', () => {
	it('writes the timecoded list as a text file', async () => {
		const { modal, created } = createSut();

		press(modal, 'Export');
		await tick();

		expect(created.get('Recordings/talk.chapters.txt')).toBe(
			'0:00 Intro\n2:05 Middle',
		);
		expect(noticeMessages().join(' ')).toContain('talk.chapters.txt');
	});

	it('writes the cue sheet as a cue file naming the recording', async () => {
		const { modal, created } = createSut();
		choose(modal, 0, 'cue');

		press(modal, 'Export');
		await tick();

		const sheet = created.get('Recordings/talk.cue') ?? '';
		expect(sheet).toContain('TITLE "talk"');
		// The fixture is a WebM, and the cue format has no name for that
		// container, so it is declared BINARY. This read WAVE while every
		// sheet claimed WAVE whatever it pointed at, which told a reader to
		// seek through a header the file does not have.
		expect(sheet).toContain('FILE "talk.webm" BINARY');
		expect(sheet).toContain('TRACK 02 AUDIO');
	});

	it('reports a write that failed instead of claiming it worked', async () => {
		const error = silenceConsole('error');
		const { modal } = createSut();
		const app = internalsOf<{ app: App }>(modal).app;
		jest.spyOn(app.vault, 'create').mockRejectedValue(
			new Error('the folder is read-only'),
		);

		press(modal, 'Export');
		await tick();

		expect(noticeMessages().join(' ')).toContain('the folder is read-only');
		error.mockRestore();
	});
});

describe('writing the outline', () => {
	it('inserts it into the open note', async () => {
		const { modal } = createSut();
		choose(modal, 0, 'outline');

		press(modal, 'Export');
		await tick();

		expect(insertTranscriptIntoNote).toHaveBeenCalledWith(
			expect.anything(),
			'note.md',
			'- [[talk#t=0|0:00]] Intro\n- [[talk#t=125|2:05]] Middle',
			'',
		);
	});

	it('puts it on the clipboard when asked to', async () => {
		const { modal, clipboard } = createSut();
		choose(modal, 0, 'outline');
		choose(modal, 1, 'clipboard');

		press(modal, 'Export');
		await tick();

		expect(clipboard).toHaveBeenCalledWith(
			'- [[talk#t=0|0:00]] Intro\n- [[talk#t=125|2:05]] Middle',
		);
	});

	it('says what to do instead when no note is open', async () => {
		const error = silenceConsole('error');
		const { modal } = createSut(MARKERS, '');
		choose(modal, 0, 'outline');

		press(modal, 'Export');
		await tick();

		expect(noticeMessages().join(' ')).toContain('clipboard');
		error.mockRestore();
	});

	it('says what to do instead when the note refused the insert', async () => {
		const error = silenceConsole('error');
		insertTranscriptIntoNote.mockReturnValueOnce(false);
		const { modal } = createSut();
		choose(modal, 0, 'outline');

		press(modal, 'Export');
		await tick();

		expect(noticeMessages().join(' ')).toContain('editing mode');
		error.mockRestore();
	});
});
