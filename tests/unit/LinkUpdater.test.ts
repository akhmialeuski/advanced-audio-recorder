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
	getLinkpath: (linktext: string): string => {
		const hashIndex = linktext.indexOf('#');
		return hashIndex === -1 ? linktext : linktext.slice(0, hashIndex);
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
	it('should join embed links with newlines by default', () => {
		expect(buildReplacementLinks(['a.wav', 'b.wav'], true)).toBe(
			'![[a.wav]]\n![[b.wav]]',
		);
	});

	it('should join links with a custom separator', () => {
		expect(buildReplacementLinks(['a.wav', 'b.wav'], true, ' ')).toBe(
			'![[a.wav]] ![[b.wav]]',
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

	it('should replace an inline embed with space-separated part links', () => {
		// The link shares its line with other content, so newlines would
		// reflow the surrounding text
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
			'![[rec-part1.webm]] ![[rec-part2.webm]]',
			{ line: 0, ch: 7 },
			{ line: 0, ch: 20 },
		);
	});

	it('should replace a link alone on its line with one link per line', () => {
		const editor = createEditor('![[rec.webm]]');
		const app = createApp([editor]);

		updateLinksInOpenEditors(
			app,
			'rec.webm',
			['rec-part1.webm', 'rec-part2.webm'],
			'replace',
		);

		expect(editor.replaceRange).toHaveBeenCalledWith(
			'![[rec-part1.webm]]\n![[rec-part2.webm]]',
			{ line: 0, ch: 0 },
			{ line: 0, ch: 13 },
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
	/**
	 * Minimal reference cache double carrying only the fields
	 * updateLinksInVault reads (link text, original text, offsets).
	 */
	interface ReferenceDouble {
		link: string;
		original: string;
		position: { start: { offset: number }; end: { offset: number } };
	}

	/**
	 * Note entry for the vault double: raw content plus the parsed
	 * references the metadata cache would report for it.
	 */
	interface VaultNoteEntry {
		content: string;
		links?: ReferenceDouble[];
		embeds?: ReferenceDouble[];
		frontmatterLinks?: { link: string }[];
	}

	/**
	 * Handles the tests assert against after building the app double.
	 */
	interface VaultAppDouble {
		app: App;
		contents: Record<string, string>;
		processMock: jest.Mock;
		generateMarkdownLink: jest.Mock;
	}

	/**
	 * Creates a TFile instance (of the mocked class) with path and name set.
	 */
	function createFile(path: string): TFile {
		const file = new TFile();
		const writable = file as unknown as { path: string; name: string };
		writable.path = path;
		writable.name = path.split('/').pop() ?? path;
		return file;
	}

	/**
	 * Builds a reference whose offsets point at the given occurrence of
	 * the original text inside the note content, so the defensive
	 * stale-cache check in updateLinksInVault passes.
	 */
	function createReference(
		content: string,
		original: string,
		link: string,
		occurrence = 0,
	): ReferenceDouble {
		let start = -1;
		for (let i = 0; i <= occurrence; i++) {
			start = content.indexOf(original, start + 1);
		}
		return {
			link,
			original,
			position: {
				start: { offset: start },
				end: { offset: start + original.length },
			},
		};
	}

	/**
	 * Builds an App double wired the way updateLinksInVault expects:
	 * resolvedLinks drives note discovery, getFileCache serves the
	 * parsed references, getFirstLinkpathDest resolves link paths via
	 * the provided map, and vault.process applies the transform to the
	 * in-memory contents.
	 */
	function createVaultApp(
		resolvedLinks: Record<string, Record<string, number>>,
		notes: Record<string, VaultNoteEntry>,
		linkTargets: Record<string, TFile>,
	): VaultAppDouble {
		const contents: Record<string, string> = {};
		for (const [path, entry] of Object.entries(notes)) {
			contents[path] = entry.content;
		}
		const generateMarkdownLink = jest.fn();
		const processMock = jest.fn(
			async (note: TFile, transform: (content: string) => string) => {
				contents[note.path] = transform(contents[note.path]);
			},
		);
		const app = {
			metadataCache: {
				resolvedLinks,
				getFileCache: jest.fn((note: TFile) => {
					const entry = notes[note.path];
					if (
						!entry.links &&
						!entry.embeds &&
						!entry.frontmatterLinks
					) {
						return null;
					}
					return {
						links: entry.links,
						embeds: entry.embeds,
						frontmatterLinks: entry.frontmatterLinks,
					};
				}),
				getFirstLinkpathDest: jest.fn(
					(linkpath: string) => linkTargets[linkpath] ?? null,
				),
			},
			vault: {
				getAbstractFileByPath: jest.fn((path: string) =>
					path in notes ? createFile(path) : null,
				),
				process: processMock,
			},
			fileManager: { generateMarkdownLink },
		} as unknown as App;
		return { app, contents, processMock, generateMarkdownLink };
	}

	it('should replace a wikilink embed and preserve the embed prefix', async () => {
		const source = createFile('audio/rec.webm');
		const content = 'intro ![[rec.webm]] outro';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{
				'note.md': { 'audio/rec.webm': 1 },
				'unrelated.md': { 'other.webm': 1 },
			},
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockImplementation(
			(file: TFile) => `[[${file.name}]]`,
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[
				createFile('audio/rec-part1.webm'),
				createFile('audio/rec-part2.webm'),
			],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		// The embed shares its line with other text, so the part links
		// are space-separated to keep the line intact
		expect(contents['note.md']).toBe(
			'intro ![[rec-part1.webm]] ![[rec-part2.webm]] outro',
		);
		expect(generateMarkdownLink).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'audio/rec-part1.webm' }),
			'note.md',
		);
	});

	it('should strip the embed prefix for non-embed wikilinks', async () => {
		const source = createFile('rec.webm');
		const content = 'see [[rec.webm]] here';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					links: [
						createReference(content, '[[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		// generateMarkdownLink embeds media files by default; the plain
		// link in the note must stay a plain link
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe('see [[new.webm]] here');
	});

	it('should rewrite Markdown-style embeds', async () => {
		const source = createFile('rec.webm');
		const content = 'audio: ![](rec.webm)';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![](rec.webm)', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![](new.webm)');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe('audio: ![](new.webm)');
	});

	it('should leave references resolving to other files untouched', async () => {
		const source = createFile('rec.webm');
		const other = createFile('other.webm');
		const content = '![[other.webm]] and ![[ghost.webm]]';
		const { app, contents, processMock } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(
							content,
							'![[other.webm]]',
							'other.webm',
						),
						createReference(
							content,
							'![[ghost.webm]]',
							'ghost.webm',
						),
					],
				},
			},
			// ghost.webm is deliberately unresolvable (returns null)
			{ 'other.webm': other },
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(0);
		expect(processMock).not.toHaveBeenCalled();
		expect(contents['note.md']).toBe(content);
	});

	it('should append links below the original for the after action', async () => {
		const source = createFile('rec.webm');
		const content = '![[rec.webm]]';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'after',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe('![[rec.webm]]\n![[new.webm]]');
	});

	it('should return zero without processing for none action or empty file list', async () => {
		const source = createFile('rec.webm');
		const content = '![[rec.webm]]';
		const { app, processMock } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);

		expect(
			(
				await updateLinksInVault(
					app,
					source,
					[createFile('new.webm')],
					'none',
				)
			).updatedNotes,
		).toBe(0);
		expect(
			(await updateLinksInVault(app, source, [], 'replace')).updatedNotes,
		).toBe(0);
		expect(processMock).not.toHaveBeenCalled();
	});

	it('should skip stale references and warn instead of corrupting the note', async () => {
		const warnSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const source = createFile('rec.webm');
		const content = 'edited content ![[rec.webm]]';
		// Offsets predate an edit, so the slice no longer matches original
		const stale: ReferenceDouble = {
			link: 'rec.webm',
			original: '![[rec.webm]]',
			position: { start: { offset: 0 }, end: { offset: 13 } },
		};
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{ 'note.md': { content, embeds: [stale] } },
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(0);
		expect(updated.skippedReferences).toBe(1);
		expect(contents['note.md']).toBe(content);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	it('should replace multiple references in one note from end to start', async () => {
		const source = createFile('rec.webm');
		const content = '![[rec.webm]] middle [[rec.webm#start|intro]] end';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 2 } },
			{
				'note.md': {
					content,
					links: [
						// Subpath link: getLinkpath must strip '#start'
						createReference(
							content,
							'[[rec.webm#start|intro]]',
							'rec.webm#start',
						),
					],
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockImplementation(
			(file: TFile) => `[[${file.name}]]`,
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('part1.webm'), createFile('part2.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		// Both references share their line with other text, so the part
		// links are space-separated to keep the line intact
		expect(contents['note.md']).toBe(
			'![[part1.webm]] ![[part2.webm]] middle [[part1.webm]] [[part2.webm]] end',
		);
	});

	it('should skip referencing paths that do not resolve to a file', async () => {
		const source = createFile('rec.webm');
		const { app, processMock } = createVaultApp(
			{ 'missing.md': { 'rec.webm': 1 } },
			{},
			{},
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(0);
		expect(processMock).not.toHaveBeenCalled();
	});

	it('should skip notes whose metadata cache has no references', async () => {
		const source = createFile('rec.webm');
		const { app, processMock } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{ 'note.md': { content: 'plain text mentioning rec.webm' } },
			{ 'rec.webm': source },
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(0);
		expect(processMock).not.toHaveBeenCalled();
	});

	it('should count only notes whose content changed', async () => {
		const warnSpy = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const source = createFile('rec.webm');
		const goodContent = '![[rec.webm]]';
		const staleContent = 'shifted ![[rec.webm]]';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{
				'good.md': { 'rec.webm': 1 },
				'stale.md': { 'rec.webm': 1 },
			},
			{
				'good.md': {
					content: goodContent,
					embeds: [
						createReference(
							goodContent,
							'![[rec.webm]]',
							'rec.webm',
						),
					],
				},
				'stale.md': {
					content: staleContent,
					embeds: [
						{
							link: 'rec.webm',
							original: '![[rec.webm]]',
							// Offsets miss the shifted link on purpose
							position: {
								start: { offset: 0 },
								end: { offset: 13 },
							},
						},
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(updated.skippedReferences).toBe(1);
		expect(contents['good.md']).toBe('![[new.webm]]');
		expect(contents['stale.md']).toBe(staleContent);
		warnSpy.mockRestore();
	});

	it('should keep a table row on one line when replacing an embed inside it', async () => {
		const source = createFile('rec.webm');
		const content = '| ![[rec.webm]] | comment |';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockImplementation(
			(file: TFile) => `[[${file.name}]]`,
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('p1.webm'), createFile('p2.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe(
			'| ![[p1.webm]] ![[p2.webm]] | comment |',
		);
	});

	it('should keep a table row on one line for the after action', async () => {
		const source = createFile('rec.webm');
		const content = '| ![[rec.webm]] |';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'after',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe('| ![[rec.webm]] ![[new.webm]] |');
	});

	it('should use one link per line when the embed is alone on its line', async () => {
		const source = createFile('rec.webm');
		const content = 'intro\n![[rec.webm]]\noutro';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{ 'note.md': { 'rec.webm': 1 } },
			{
				'note.md': {
					content,
					embeds: [
						createReference(content, '![[rec.webm]]', 'rec.webm'),
					],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockImplementation(
			(file: TFile) => `[[${file.name}]]`,
		);

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('p1.webm'), createFile('p2.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(contents['note.md']).toBe(
			'intro\n![[p1.webm]]\n![[p2.webm]]\noutro',
		);
	});

	it('should count frontmatter references without touching them', async () => {
		const source = createFile('rec.webm');
		const bodyContent = '---\naudio: "[[rec.webm]]"\n---\n![[rec.webm]]';
		const { app, contents, generateMarkdownLink } = createVaultApp(
			{
				'note.md': { 'rec.webm': 2 },
				'fm-only.md': { 'rec.webm': 1 },
			},
			{
				'note.md': {
					content: bodyContent,
					embeds: [
						createReference(
							bodyContent,
							'![[rec.webm]]',
							'rec.webm',
						),
					],
					frontmatterLinks: [{ link: 'rec.webm' }],
				},
				'fm-only.md': {
					content: '---\naudio: "[[rec.webm]]"\n---\n',
					frontmatterLinks: [{ link: 'rec.webm' }],
				},
			},
			{ 'rec.webm': source },
		);
		generateMarkdownLink.mockReturnValue('![[new.webm]]');

		const updated = await updateLinksInVault(
			app,
			source,
			[createFile('new.webm')],
			'replace',
		);

		expect(updated.updatedNotes).toBe(1);
		expect(updated.frontmatterReferences).toBe(2);
		// The body embed is rewritten, the frontmatter stays untouched
		expect(contents['note.md']).toBe(
			'---\naudio: "[[rec.webm]]"\n---\n![[new.webm]]',
		);
		expect(contents['fm-only.md']).toBe(
			'---\naudio: "[[rec.webm]]"\n---\n',
		);
	});
});
