/**
 * Unit tests for LinkUpdater module.
 * @module tests/unit/LinkUpdater.test
 */

import {
	buildLinkPattern,
	buildReplacementLinks,
	updateLinksInOpenEditors,
	updateLinksInVault,
} from '../../src/utils/LinkUpdater';
import { App, MarkdownView, TFile } from 'obsidian';

jest.mock('obsidian', () => ({
	MarkdownView: class {
		editor: unknown = null;
	},
	TFile: class {
		path = '';
		name = '';
	},
}));

/**
 * Minimal editor double exposing the methods LinkUpdater relies on.
 */
interface EditorDouble {
	getValue: jest.Mock;
	offsetToPos: jest.Mock;
	replaceRange: jest.Mock;
}

function createEditor(content: string): EditorDouble {
	return {
		getValue: jest.fn().mockReturnValue(content),
		offsetToPos: jest.fn((offset: number) => ({ line: 0, ch: offset })),
		replaceRange: jest.fn(),
	};
}

function createLeafWithEditor(editor: EditorDouble): { view: MarkdownView } {
	const view = new MarkdownView();
	(view as unknown as { editor: EditorDouble }).editor = editor;
	return { view };
}

describe('buildLinkPattern', () => {
	// A fresh pattern per assertion: the /g flag makes test() stateful
	it('should match embed and plain wiki links', () => {
		expect(buildLinkPattern('rec.webm').test('![[rec.webm]]')).toBe(true);
		expect(buildLinkPattern('rec.webm').test('[[rec.webm]]')).toBe(true);
	});

	it('should match links with aliases', () => {
		expect(
			buildLinkPattern('rec.webm').test('![[rec.webm|My recording]]'),
		).toBe(true);
	});

	it('should escape regex metacharacters in the file name', () => {
		expect(buildLinkPattern('rec (1).webm').test('![[rec (1).webm]]')).toBe(
			true,
		);
		expect(buildLinkPattern('rec (1).webm').test('![[rec 1.webm]]')).toBe(
			false,
		);
	});

	it('should not match a different file', () => {
		expect(buildLinkPattern('rec.webm').test('![[other.webm]]')).toBe(
			false,
		);
	});
});

describe('buildReplacementLinks', () => {
	it('should join embed links with newlines', () => {
		expect(buildReplacementLinks(['a.wav', 'b.wav'], true)).toBe(
			'![[a.wav]]\n![[b.wav]]',
		);
	});

	it('should preserve plain link form', () => {
		expect(buildReplacementLinks(['a.wav'], false)).toBe('[[a.wav]]');
	});
});

describe('updateLinksInOpenEditors', () => {
	function createApp(editors: EditorDouble[]): App {
		return {
			workspace: {
				getLeavesOfType: jest
					.fn()
					.mockReturnValue(editors.map(createLeafWithEditor)),
			},
		} as unknown as App;
	}

	it('should replace a single embed link with multiple part links', () => {
		const editor = createEditor('before ![[rec.webm]] after');
		const app = createApp([editor]);

		updateLinksInOpenEditors(
			app,
			'rec.webm',
			['rec-part1.webm', 'rec-part2.webm'],
			'replace',
		);

		expect(editor.replaceRange).toHaveBeenCalledTimes(1);
		expect(editor.replaceRange).toHaveBeenCalledWith(
			'![[rec-part1.webm]]\n![[rec-part2.webm]]',
			{ line: 0, ch: 7 },
			{ line: 0, ch: 20 },
		);
	});

	it('should insert links after the source link for the after action', () => {
		const editor = createEditor('![[rec.webm]]');
		const app = createApp([editor]);

		updateLinksInOpenEditors(app, 'rec.webm', ['new.webm'], 'after');

		expect(editor.replaceRange).toHaveBeenCalledWith(
			'![[rec.webm]]\n![[new.webm]]',
			{ line: 0, ch: 0 },
			{ line: 0, ch: 13 },
		);
	});

	it('should replace multiple matches from end to start', () => {
		const editor = createEditor('![[rec.webm]] middle [[rec.webm]]');
		const app = createApp([editor]);

		updateLinksInOpenEditors(app, 'rec.webm', ['new.webm'], 'replace');

		expect(editor.replaceRange).toHaveBeenCalledTimes(2);
		// Last match is replaced first so earlier offsets stay valid
		const firstCall = editor.replaceRange.mock.calls[0];
		expect(firstCall[0]).toBe('[[new.webm]]');
		expect(firstCall[1]).toEqual({ line: 0, ch: 21 });
		const secondCall = editor.replaceRange.mock.calls[1];
		expect(secondCall[0]).toBe('![[new.webm]]');
		expect(secondCall[1]).toEqual({ line: 0, ch: 0 });
	});

	it('should skip editors whose content does not mention the file', () => {
		const editor = createEditor('nothing here');
		const app = createApp([editor]);

		updateLinksInOpenEditors(app, 'rec.webm', ['new.webm'], 'replace');

		expect(editor.replaceRange).not.toHaveBeenCalled();
	});

	it('should do nothing for the none action', () => {
		const editor = createEditor('![[rec.webm]]');
		const app = createApp([editor]);

		updateLinksInOpenEditors(app, 'rec.webm', ['new.webm'], 'none');

		expect(editor.replaceRange).not.toHaveBeenCalled();
	});

	it('should do nothing for an empty replacement list', () => {
		const editor = createEditor('![[rec.webm]]');
		const app = createApp([editor]);

		updateLinksInOpenEditors(app, 'rec.webm', [], 'replace');

		expect(editor.replaceRange).not.toHaveBeenCalled();
	});

	it('should skip leaves whose view is not a MarkdownView', () => {
		const app = {
			workspace: {
				getLeavesOfType: jest
					.fn()
					.mockReturnValue([{ view: { not: 'markdown' } }]),
			},
		} as unknown as App;

		expect(() =>
			updateLinksInOpenEditors(app, 'rec.webm', ['new.webm'], 'replace'),
		).not.toThrow();
	});
});

describe('updateLinksInVault', () => {
	function createSourceFile(path: string, name: string): TFile {
		const file = new TFile();
		(file as unknown as { path: string; name: string }).path = path;
		(file as unknown as { path: string; name: string }).name = name;
		return file;
	}

	function createVaultApp(
		resolvedLinks: Record<string, Record<string, number>>,
		noteContents: Record<string, string>,
	): { app: App; processedContents: Record<string, string> } {
		const processedContents: Record<string, string> = {
			...noteContents,
		};
		const app = {
			metadataCache: { resolvedLinks },
			vault: {
				getAbstractFileByPath: jest.fn((path: string) => {
					if (path in noteContents) {
						return createSourceFile(path, path);
					}
					return null;
				}),
				process: jest.fn(
					async (
						note: TFile,
						transform: (content: string) => string,
					) => {
						const path = note.path;
						processedContents[path] = transform(
							processedContents[path],
						);
						return processedContents[path];
					},
				),
			},
		} as unknown as App;
		return { app, processedContents };
	}

	it('should rewrite links in every referencing note', async () => {
		const source = createSourceFile('audio/rec.webm', 'rec.webm');
		const { app, processedContents } = createVaultApp(
			{
				'note1.md': { 'audio/rec.webm': 1 },
				'note2.md': { 'other.webm': 1 },
				'note3.md': { 'audio/rec.webm': 2 },
			},
			{
				'note1.md': 'intro ![[rec.webm]] outro',
				'note2.md': '![[other.webm]]',
				'note3.md': '[[rec.webm|alias]] and ![[audio/rec.webm]]',
			},
		);

		const updated = await updateLinksInVault(
			app,
			source,
			['rec-part1.webm', 'rec-part2.webm'],
			'replace',
		);

		expect(updated).toBe(2);
		expect(processedContents['note1.md']).toBe(
			'intro ![[rec-part1.webm]]\n![[rec-part2.webm]] outro',
		);
		expect(processedContents['note2.md']).toBe('![[other.webm]]');
		expect(processedContents['note3.md']).toBe(
			'[[rec-part1.webm]]\n[[rec-part2.webm]] and ![[rec-part1.webm]]\n![[rec-part2.webm]]',
		);
	});

	it('should append links for the after action', async () => {
		const source = createSourceFile('rec.webm', 'rec.webm');
		const { app, processedContents } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{ 'note.md': '![[rec.webm]]' },
		);

		await updateLinksInVault(app, source, ['new.webm'], 'after');

		expect(processedContents['note.md']).toBe(
			'![[rec.webm]]\n![[new.webm]]',
		);
	});

	it('should return zero and skip processing for the none action', async () => {
		const source = createSourceFile('rec.webm', 'rec.webm');
		const { app } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{ 'note.md': '![[rec.webm]]' },
		);

		const updated = await updateLinksInVault(
			app,
			source,
			['new.webm'],
			'none',
		);

		expect(updated).toBe(0);
		expect(app.vault.process).not.toHaveBeenCalled();
	});

	it('should skip notes that cannot be resolved to a file', async () => {
		const source = createSourceFile('rec.webm', 'rec.webm');
		const { app } = createVaultApp({ 'missing.md': { 'rec.webm': 1 } }, {});

		const updated = await updateLinksInVault(
			app,
			source,
			['new.webm'],
			'replace',
		);

		expect(updated).toBe(0);
	});

	it('should not count notes whose content did not change', async () => {
		const source = createSourceFile('rec.webm', 'rec.webm');
		const { app } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{ 'note.md': 'mentions rec.webm without a link' },
		);

		const updated = await updateLinksInVault(
			app,
			source,
			['new.webm'],
			'replace',
		);

		expect(updated).toBe(0);
	});
});
