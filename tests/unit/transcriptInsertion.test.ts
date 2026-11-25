/**
 * Tests the note-insertion half of transcriptOutput. Insertion targets the note
 * the timecode links were generated against - not whatever pane happens to be
 * active when an async run finishes - so the view lookup is what keeps a long
 * transcription from dumping its output into an unrelated file the user
 * switched to mid-run. A note that no editor is editing - one in Reading view,
 * or closed - is written through the vault, since nothing else reaches its
 * file. A refused insert must report false rather than throw, so the caller
 * can still write the sidecar fallback.
 * @module tests/unit/transcriptInsertion.test
 */

import {
	insertTranscriptFileLink,
	insertTranscriptIntoNote,
	writeTranscriptFile,
} from 'src/transcription/transcriptOutput';
import { MarkdownView } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { at, defined } from '../helpers/assertions';
import { createMockApp } from '../helpers/createApp';

/** A Markdown leaf whose editor records the ranges written into it. */
function makeLeaf(
	notePath: string | null,
	options: { throws?: boolean; mode?: 'source' | 'preview' } = {},
): {
	leaf: { view: MarkdownView };
	writes: [string, unknown][];
} {
	const writes: [string, unknown][] = [];
	// Built from the prototype rather than the constructor: the production
	// lookup filters leaves with `instanceof MarkdownView`, and Obsidian's own
	// constructor signature needs a real leaf we have no use for here.
	const view = Object.create(MarkdownView.prototype) as MarkdownView;
	Object.defineProperty(view, 'file', {
		value: notePath === null ? null : { path: notePath },
	});
	Object.defineProperty(view, 'getMode', {
		value: () => options.mode ?? 'source',
	});
	// Reading view keeps the editor, hidden: it takes a write without an
	// error and the note never receives it, so a write recorded here for a
	// view in that mode is a transcript lost.
	Object.defineProperty(view, 'editor', {
		get: () => ({
			getCursor: () => ({ line: 3, ch: 0 }),
			replaceRange: (text: string, cursor: unknown) => {
				if (options.throws) {
					throw new Error('editor is read-only');
				}
				writes.push([text, cursor]);
			},
		}),
	});
	return { leaf: { view }, writes };
}

/** What a test app is built from. */
interface AppOptions {
	/** The Markdown leaves that are open. */
	leaves?: { view: MarkdownView }[];
	/** The notes on disk, by path; written back by `vault.process`. */
	notes?: Record<string, string>;
	/** The embeds the cache reports for every note, by their exact text. */
	embeds?: string[];
	generateMarkdownLink?: jest.Mock;
}

/** An App exposing the given Markdown leaves over the given notes. */
function makeApp(options: AppOptions = {}): App {
	const { leaves = [], notes = {}, embeds = [] } = options;
	return createMockApp({
		workspace: {
			getLeavesOfType: jest.fn((type: string) =>
				type === 'markdown' ? leaves : [],
			),
		},
		vault: {
			getFileByPath: jest.fn((path: string) =>
				path in notes ? { path } : null,
			),
			process: jest.fn(
				(file: TFile, change: (content: string) => string) => {
					notes[file.path] = change(notes[file.path] ?? '');
					return Promise.resolve(notes[file.path]);
				},
			),
		},
		metadataCache: {
			getFileCache: jest.fn().mockReturnValue({
				embeds: embeds.map((original) => ({
					original,
					link: RECORDING.path,
				})),
			}),
			getFirstLinkpathDest: jest.fn().mockReturnValue(RECORDING),
		},
		fileManager: {
			generateMarkdownLink:
				options.generateMarkdownLink ??
				jest.fn().mockReturnValue('[[audio.srt]]'),
		},
	}).app;
}

/** The recording the transcripts are of. */
const RECORDING = { path: 'Recordings/audio.webm' } as TFile;

describe('insertTranscriptIntoNote', () => {
	it('writes at the cursor of the note the links were generated against', async () => {
		const target = makeLeaf('Notes/meeting.md');
		const other = makeLeaf('Notes/unrelated.md');
		const app = makeApp({ leaves: [other.leaf, target.leaf] });

		await expect(
			insertTranscriptIntoNote(app, 'Notes/meeting.md', 'body', ''),
		).resolves.toBe(true);

		expect(at(target.writes, 0)).toEqual([
			'\n\nbody\n',
			{ line: 3, ch: 0 },
		]);
		// The pane the user switched to must be left alone.
		expect(other.writes).toEqual([]);
	});

	it('puts the heading above the body when one is given', async () => {
		const target = makeLeaf('Notes/meeting.md');

		await insertTranscriptIntoNote(
			makeApp({ leaves: [target.leaf] }),
			'Notes/meeting.md',
			'body',
			'## Transcript',
		);

		expect(at(at(target.writes, 0), 0)).toBe('\n\n## Transcript\n\nbody\n');
	});

	it('writes a note in Reading view through the vault, not its hidden editor', async () => {
		// Regression (#177): the view keeps its editor in Reading view, and a
		// write to it raised no error and never reached the note, so a paid
		// transcript was reported as inserted and lost.
		const target = makeLeaf('Notes/meeting.md', { mode: 'preview' });
		const notes = { 'Notes/meeting.md': 'Agenda\n' };

		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [target.leaf], notes }),
				'Notes/meeting.md',
				'body',
				'## Transcript',
			),
		).resolves.toBe(true);

		expect(target.writes).toEqual([]);
		expect(notes['Notes/meeting.md']).toBe(
			'Agenda\n\n## Transcript\n\nbody\n',
		);
	});

	it('puts the transcript under the embed of its recording in a note written through the vault', async () => {
		// Reading view has no cursor, and the transcript belongs under the
		// player it was started from rather than below everything else.
		const target = makeLeaf('Notes/meeting.md', { mode: 'preview' });
		const notes = {
			'Notes/meeting.md': 'Agenda\n![[audio.webm]]\nNext steps\n',
		};

		await insertTranscriptIntoNote(
			makeApp({
				leaves: [target.leaf],
				notes,
				embeds: ['![[audio.webm]]'],
			}),
			'Notes/meeting.md',
			'body',
			'',
			RECORDING,
		);

		expect(notes['Notes/meeting.md']).toBe(
			'Agenda\n![[audio.webm]]\n\nbody\n\nNext steps\n',
		);
	});

	it('uses the pane editing the note when another shows it in Reading view', async () => {
		// What is typed in the editor is not on disk yet, so the note open in
		// both modes is written where it is being edited.
		const reading = makeLeaf('Notes/meeting.md', { mode: 'preview' });
		const editing = makeLeaf('Notes/meeting.md');
		const notes = { 'Notes/meeting.md': 'Agenda\n' };

		await insertTranscriptIntoNote(
			makeApp({ leaves: [reading.leaf, editing.leaf], notes }),
			'Notes/meeting.md',
			'body',
			'',
		);

		expect(at(at(editing.writes, 0), 0)).toBe('\n\nbody\n');
		expect(reading.writes).toEqual([]);
		expect(notes['Notes/meeting.md']).toBe('Agenda\n');
	});

	it('writes a note that is not open through the vault', async () => {
		// The user closed the note during a long run; the transcript still
		// belongs in it, and the pane they moved to is left alone.
		const other = makeLeaf('Notes/unrelated.md');
		const notes = { 'Notes/meeting.md': 'Agenda' };

		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [other.leaf], notes }),
				'Notes/meeting.md',
				'body',
				'',
			),
		).resolves.toBe(true);

		expect(notes['Notes/meeting.md']).toBe('Agenda\n\nbody\n');
		expect(other.writes).toEqual([]);
	});

	it('reports not-inserted when the target note no longer exists', async () => {
		const other = makeLeaf('Notes/unrelated.md');

		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [other.leaf] }),
				'Notes/meeting.md',
				'body',
				'',
			),
		).resolves.toBe(false);
		expect(other.writes).toEqual([]);
	});

	it('reports not-inserted for an empty note path', async () => {
		const target = makeLeaf('Notes/meeting.md');

		// A run with no host note must not fall through to "the first open
		// Markdown leaf" - that is exactly the wrong-file bug.
		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [target.leaf] }),
				'',
				'body',
				'',
			),
		).resolves.toBe(false);
		expect(target.writes).toEqual([]);
	});

	it('ignores a leaf whose view has no file', async () => {
		const empty = makeLeaf(null);

		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [empty.leaf] }),
				'Notes/meeting.md',
				'body',
				'',
			),
		).resolves.toBe(false);
		expect(empty.writes).toEqual([]);
	});

	it('reports not-inserted instead of throwing when the write is refused', async () => {
		const target = makeLeaf('Notes/meeting.md', { throws: true });
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		// The caller needs a false to fall back to the sidecar file, not an
		// exception that aborts the whole run and takes the transcript along.
		await expect(
			insertTranscriptIntoNote(
				makeApp({ leaves: [target.leaf] }),
				'Notes/meeting.md',
				'body',
				'',
			),
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('insertTranscriptFileLink', () => {
	const transcriptFile = { path: 'Recordings/audio.srt' } as TFile;

	it('inserts a link built for the vault link format', async () => {
		const target = makeLeaf('Notes/meeting.md');
		const generateMarkdownLink = jest
			.fn()
			.mockReturnValue('[[Recordings/audio.srt]]');
		const app = makeApp({ leaves: [target.leaf], generateMarkdownLink });

		await expect(
			insertTranscriptFileLink(
				app,
				'Notes/meeting.md',
				transcriptFile,
				'',
			),
		).resolves.toBe(true);

		// Built through Obsidian rather than hand-formatted, so a wikilink vault
		// gets a wikilink and a Markdown-link vault gets a Markdown link.
		expect(generateMarkdownLink).toHaveBeenCalledWith(
			transcriptFile,
			'Notes/meeting.md',
		);
		expect(at(at(target.writes, 0), 0)).toBe(
			'\n\n[[Recordings/audio.srt]]\n',
		);
	});

	it('places the link under the heading when one is given', async () => {
		const target = makeLeaf('Notes/meeting.md');

		await insertTranscriptFileLink(
			makeApp({ leaves: [target.leaf] }),
			'Notes/meeting.md',
			transcriptFile,
			'## Transcript',
		);

		expect(at(at(target.writes, 0), 0)).toBe(
			'\n\n## Transcript\n\n[[audio.srt]]\n',
		);
	});

	it('links the file in a note in Reading view through the vault', async () => {
		const target = makeLeaf('Notes/meeting.md', { mode: 'preview' });
		const notes = { 'Notes/meeting.md': 'Agenda\n' };

		await expect(
			insertTranscriptFileLink(
				makeApp({ leaves: [target.leaf], notes }),
				'Notes/meeting.md',
				transcriptFile,
				'',
			),
		).resolves.toBe(true);

		expect(target.writes).toEqual([]);
		expect(notes['Notes/meeting.md']).toBe('Agenda\n\n[[audio.srt]]\n');
	});

	it('reports not-inserted when the note no longer exists', async () => {
		await expect(
			insertTranscriptFileLink(
				makeApp(),
				'Notes/meeting.md',
				transcriptFile,
				'',
			),
		).resolves.toBe(false);
	});
});

describe('writeTranscriptFile', () => {
	it('writes the sidecar next to the audio in the requested format', async () => {
		const create = jest.fn().mockResolvedValue({ path: 'out' });
		const app = createMockApp({
			vault: {
				create,
				getFileByPath: jest.fn().mockReturnValue(null),
				adapter: { exists: jest.fn().mockResolvedValue(false) },
			},
		}).app;

		await writeTranscriptFile(
			app,
			{ path: 'Recordings/audio.webm' } as TFile,
			{
				language: 'en',
				speakers: [],
				segments: [{ start: 0, end: 1, text: 'hi' }],
			},
			'txt',
		);

		const [path, body] = at(create.mock.calls, 0);
		expect(path).toBe('Recordings/audio.txt');
		expect(defined(body)).toContain('hi');
	});

	it('does not overwrite an existing sidecar', async () => {
		const create = jest.fn().mockResolvedValue({ path: 'out' });
		const existing = new Set(['Recordings/audio.txt']);
		const app = createMockApp({
			vault: {
				create,
				getFileByPath: jest.fn((path: string) =>
					existing.has(path) ? { path } : null,
				),
				adapter: {
					exists: jest.fn((path: string) =>
						Promise.resolve(existing.has(path)),
					),
				},
			},
		}).app;

		await writeTranscriptFile(
			app,
			{ path: 'Recordings/audio.webm' } as TFile,
			{ language: 'en', speakers: [], segments: [] },
			'txt',
		);

		// Re-transcribing a file must not silently replace the previous
		// transcript.
		expect(at(at(create.mock.calls, 0), 0)).not.toBe(
			'Recordings/audio.txt',
		);
	});
});
