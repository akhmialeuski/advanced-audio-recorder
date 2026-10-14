/**
 * Tests for the two places a transcript line edit writes a note's lines: the
 * open editor and the note file. Both refuse to write over lines that no
 * longer read as they did, so an edit never lands on lines that moved.
 * @module tests/unit/transcriptLines.test
 */

import { App } from 'obsidian';
import type { Editor, EditorPosition, TFile } from 'obsidian';
import { editorLines, noteLines } from 'src/actions/transcriptLines';
import { asMockVault } from '../helpers/obsidianMock';

const NOTE = 'Notes/meeting.md';

/** An editor over some lines, replacing ranges the way CodeMirror does. */
function editorOver(text: string): {
	editor: Pick<Editor, 'getLine' | 'lineCount' | 'replaceRange'>;
	text: () => string;
} {
	let lines = text.split('\n');
	return {
		editor: {
			getLine: (line) => lines[line] ?? '',
			lineCount: () => lines.length,
			replaceRange: (
				replacement: string,
				from: EditorPosition,
				to: EditorPosition = from,
			) => {
				const head = (lines[from.line] ?? '').slice(0, from.ch);
				const tail = (lines[to.line] ?? '').slice(to.ch);
				lines = [
					...lines.slice(0, from.line),
					...`${head}${replacement}${tail}`.split('\n'),
					...lines.slice(to.line + 1),
				];
			},
		},
		text: () => lines.join('\n'),
	};
}

/** A vault holding the note, and its lines as read from it. */
async function noteOver(content: string): Promise<{
	app: App;
	note: TFile;
	lines: ReturnType<typeof noteLines>;
	read: () => Promise<string>;
}> {
	const app = new App();
	asMockVault(app.vault).seed([{ path: NOTE, content }]);
	const note = app.vault.getFileByPath(NOTE);
	if (!note) {
		throw new Error('The note was not seeded');
	}
	return {
		app,
		note,
		lines: noteLines(app, note, await app.vault.read(note)),
		read: () => app.vault.read(note),
	};
}

describe('the lines of an open editor', () => {
	it('reads them as the editor holds them', () => {
		const { editor } = editorOver('a\nb\nc');
		const lines = editorLines(editor);

		expect([lines.getLine(1), lines.lineCount()]).toEqual(['b', 3]);
	});

	it('replaces lines that still read as expected', async () => {
		const sut = editorOver('a\nb\nc\nd');

		await expect(
			editorLines(sut.editor).replaceLines(1, ['b', 'c'], 'bc'),
		).resolves.toBe(true);
		expect(sut.text()).toBe('a\nbc\nd');
	});

	it('leaves lines alone that changed', async () => {
		const sut = editorOver('a\nb2\nc');

		await expect(
			editorLines(sut.editor).replaceLines(1, ['b'], 'x'),
		).resolves.toBe(false);
		expect(sut.text()).toBe('a\nb2\nc');
	});
});

describe('the lines of a note file', () => {
	it('reads them as they were when read', async () => {
		const { lines } = await noteOver('# Title\n\nline');

		expect([lines.getLine(2), lines.getLine(9), lines.lineCount()]).toEqual(
			['line', '', 3],
		);
	});

	it('replaces lines in the file', async () => {
		const sut = await noteOver('a\nb\nc');

		await expect(sut.lines.replaceLines(1, ['b'], 'b1\nb2')).resolves.toBe(
			true,
		);
		await expect(sut.read()).resolves.toBe('a\nb1\nb2\nc');
	});

	it('keeps the line breaks of a note written on Windows', async () => {
		const sut = await noteOver('a\r\nb\r\nc');

		await sut.lines.replaceLines(1, ['b'], 'x');

		await expect(sut.read()).resolves.toBe('a\r\nx\r\nc');
	});

	it('refuses lines that changed in the file since they were read', async () => {
		const sut = await noteOver('a\nb\nc');
		await sut.app.vault.modify(sut.note, 'a\nedited\nc');

		await expect(sut.lines.replaceLines(1, ['b'], 'x')).resolves.toBe(
			false,
		);
		await expect(sut.read()).resolves.toBe('a\nedited\nc');
	});
});
