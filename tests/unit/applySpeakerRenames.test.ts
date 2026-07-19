/**
 * Tests for the vault-side speaker rename: reading a recording's roster out of
 * its outputs and applying renames scoped to the recording (a note's lines
 * whose timecode link resolves to the audio) plus its sidecar files.
 */

import type { App, CachedMetadata, TFile } from 'obsidian';
import {
	applySpeakerRenamesToVault,
	inspectAudioTranscript,
} from 'src/speakers/applySpeakerRenames';

const FORMAT = '**{speaker}**';
const TEMPLATES = {
	lineFormat: '{timestamp} {speaker} {text}',
	speakerFormat: FORMAT,
	includeTimestamps: true,
};

interface Ref {
	link: string;
	position: { start: { line: number }; end: { line: number } };
}
interface Cache {
	links?: Ref[];
	embeds?: Ref[];
}

const tf = (path: string): TFile => {
	const name = path.split('/').pop() ?? path;
	const dot = name.lastIndexOf('.');
	const extension = dot >= 0 ? name.slice(dot + 1) : '';
	return { path, name, extension } as unknown as TFile;
};

/**
 * Builds a fake App over an in-memory file map with a metadata cache. Files
 * resolve by basename, notes carry the given link/embed caches, and paths in
 * `failPaths` throw on write to exercise the per-output resilience.
 */
function makeApp(
	files: Map<string, string>,
	opts: {
		resolvedLinks?: Record<string, Record<string, number>>;
		caches?: Record<string, Cache>;
		failPaths?: Set<string>;
	} = {},
): App {
	const { resolvedLinks = {}, caches = {}, failPaths = new Set() } = opts;
	return {
		vault: {
			getFiles: (): TFile[] => [...files.keys()].map(tf),
			getFileByPath: (path: string): TFile | null =>
				files.has(path) ? tf(path) : null,
			read: async (file: TFile): Promise<string> =>
				files.get(file.path) ?? '',
			process: async (
				file: TFile,
				fn: (content: string) => string,
			): Promise<string> => {
				if (failPaths.has(file.path)) {
					throw new Error(`write failed: ${file.path}`);
				}
				const next = fn(files.get(file.path) ?? '');
				files.set(file.path, next);
				return next;
			},
		},
		metadataCache: {
			resolvedLinks,
			getFileCache: (file: TFile): CachedMetadata | null =>
				(caches[file.path] as CachedMetadata | undefined) ?? null,
			getFirstLinkpathDest: (linkpath: string): TFile | null => {
				for (const path of files.keys()) {
					if (
						path.split('/').pop() === linkpath ||
						path === linkpath
					) {
						return tf(path);
					}
				}
				return null;
			},
		},
	} as unknown as App;
}

const audioFile = tf('audio/rec.wav');
const renames = [
	{ from: 'Speaker 1', to: 'Alex' },
	{ from: 'Speaker 2', to: 'Bob' },
];

/** A note holding this recording's transcript plus another recording's. */
function meetingNote(): { content: string; cache: Cache } {
	const content = [
		'![[rec.wav]]', // 0
		'', // 1
		'[00:00](rec.wav#t=0) **Speaker 1** hello', // 2
		'[00:05](rec.wav#t=5) **Speaker 2** hi', // 3
		'', // 4
		'[00:00](other.wav#t=0) **Speaker 1** unrelated', // 5
	].join('\n');
	const cache: Cache = {
		embeds: [
			{
				link: 'rec.wav',
				position: { start: { line: 0 }, end: { line: 0 } },
			},
		],
		links: [
			{
				link: 'rec.wav#t=0',
				position: { start: { line: 2 }, end: { line: 2 } },
			},
			{
				link: 'rec.wav#t=5',
				position: { start: { line: 3 }, end: { line: 3 } },
			},
			{
				link: 'other.wav#t=0',
				position: { start: { line: 5 }, end: { line: 5 } },
			},
		],
	};
	return { content, cache };
}

describe('inspectAudioTranscript', () => {
	it('reads the roster from sidecar files and scoped note lines', async () => {
		const { content, cache } = meetingNote();
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['meeting.md', content],
			['audio/rec.txt', '[0:00] Speaker 1: hi\n[0:05] Speaker 3: extra'],
		]);
		const app = makeApp(files, {
			resolvedLinks: { 'meeting.md': { 'audio/rec.wav': 1 } },
			caches: { 'meeting.md': cache },
		});

		const result = await inspectAudioTranscript(app, audioFile, TEMPLATES);
		expect(result.roster).toEqual(['Speaker 1', 'Speaker 3', 'Speaker 2']);
		expect(result.hasUnscopableNote).toBe(false);
	});

	it('flags a note whose transcript carries no timecode links', async () => {
		const content = '![[rec.wav]]\n\n**Speaker 1** hi\n**Speaker 2** yo';
		const cache: Cache = {
			embeds: [
				{
					link: 'rec.wav',
					position: { start: { line: 0 }, end: { line: 0 } },
				},
			],
		};
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['meeting.md', content],
		]);
		const app = makeApp(files, {
			resolvedLinks: { 'meeting.md': { 'audio/rec.wav': 1 } },
			caches: { 'meeting.md': cache },
		});

		// This note carries no timecode links and no timestamps, so extraction
		// must read the un-timestamped rendering.
		const result = await inspectAudioTranscript(app, audioFile, {
			...TEMPLATES,
			includeTimestamps: false,
		});
		expect(result.roster).toEqual(['Speaker 1', 'Speaker 2']);
		expect(result.hasUnscopableNote).toBe(true);
	});
});

describe('applySpeakerRenamesToVault', () => {
	it('rewrites sidecar files (including collision names) and scoped note lines', async () => {
		const { content, cache } = meetingNote();
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['meeting.md', content],
			[
				'audio/rec.transcript.json',
				JSON.stringify({
					segments: [{ speaker: 'Speaker 1', text: 'hi' }],
					speakers: ['Speaker 1'],
				}),
			],
			[
				'audio/rec.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: hi',
			],
			[
				'audio/rec_1.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 2: yo',
			],
		]);
		const app = makeApp(files, {
			resolvedLinks: { 'meeting.md': { 'audio/rec.wav': 1 } },
			caches: { 'meeting.md': cache },
		});

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			FORMAT,
			{ allowBroad: false },
		);

		expect(result.updatedTranscriptFiles).toBe(3);
		expect(result.updatedNotes).toBe(1);
		expect(result.failed).toBe(0);
		expect(files.get('audio/rec.transcript.json')).toContain('"Alex"');
		expect(files.get('audio/rec.srt')).toContain('Alex: hi');
		expect(files.get('audio/rec_1.srt')).toContain('Bob: yo');
		const note = files.get('meeting.md') ?? '';
		expect(note).toContain('**Alex** hello');
		expect(note).toContain('**Bob** hi');
		// The other recording's transcript in the same note is untouched.
		expect(note).toContain('**Speaker 1** unrelated');
	});

	it('leaves an untimecoded note alone unless broad rewrite is allowed', async () => {
		const content = '![[rec.wav]]\n\n**Speaker 1** hi';
		const cache: Cache = {
			embeds: [
				{
					link: 'rec.wav',
					position: { start: { line: 0 }, end: { line: 0 } },
				},
			],
		};
		const build = (): Map<string, string> =>
			new Map<string, string>([
				['audio/rec.wav', ''],
				['meeting.md', content],
			]);

		const scopedFiles = build();
		const scoped = await applySpeakerRenamesToVault(
			makeApp(scopedFiles, {
				resolvedLinks: { 'meeting.md': { 'audio/rec.wav': 1 } },
				caches: { 'meeting.md': cache },
			}),
			audioFile,
			renames,
			FORMAT,
			{ allowBroad: false },
		);
		expect(scoped.updatedNotes).toBe(0);
		expect(scopedFiles.get('meeting.md')).toBe(content);

		const broadFiles = build();
		const broad = await applySpeakerRenamesToVault(
			makeApp(broadFiles, {
				resolvedLinks: { 'meeting.md': { 'audio/rec.wav': 1 } },
				caches: { 'meeting.md': cache },
			}),
			audioFile,
			renames,
			FORMAT,
			{ allowBroad: true },
		);
		expect(broad.updatedNotes).toBe(1);
		expect(broadFiles.get('meeting.md')).toContain('**Alex** hi');
	});

	it('logs and skips a failing output without aborting the rest', async () => {
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			[
				'audio/rec.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: hi',
			],
			['audio/rec.txt', '[0:00] Speaker 1: hi'],
		]);
		const app = makeApp(files, { failPaths: new Set(['audio/rec.srt']) });
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			FORMAT,
			{ allowBroad: false },
		);

		expect(result.failed).toBe(1);
		expect(result.updatedTranscriptFiles).toBe(1);
		expect(files.get('audio/rec.txt')).toBe('[0:00] Alex: hi');
		warn.mockRestore();
	});

	it("leaves a sibling recording's collision-named sidecar untouched", async () => {
		// rec_1.srt is rec_1.wav's own canonical sidecar, not a collision copy
		// of rec.srt, so renaming rec.wav must not read or rewrite it.
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['audio/rec_1.wav', ''],
			[
				'audio/rec.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: mine',
			],
			[
				'audio/rec_1.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: sibling',
			],
		]);
		const app = makeApp(files);

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			FORMAT,
			{ allowBroad: false },
		);

		expect(result.updatedTranscriptFiles).toBe(1);
		expect(files.get('audio/rec.srt')).toContain('Alex: mine');
		expect(files.get('audio/rec_1.srt')).toBe(
			'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: sibling',
		);
	});

	it('rewrites the content vault.process supplies, not a stale read', async () => {
		const live = new Map<string, string>([
			['audio/rec.wav', ''],
			['audio/rec.txt', '[0:00] Speaker 1: live edit'],
		]);
		// read returns a stale snapshot while process operates on the current
		// content, mimicking an edit landing between the two calls.
		const app = {
			vault: {
				getFiles: (): TFile[] => [...live.keys()].map(tf),
				getFileByPath: (path: string): TFile | null =>
					live.has(path) ? tf(path) : null,
				read: async (): Promise<string> =>
					'[0:00] Speaker 1: stale snapshot',
				process: async (
					file: TFile,
					fn: (content: string) => string,
				): Promise<string> => {
					const next = fn(live.get(file.path) ?? '');
					live.set(file.path, next);
					return next;
				},
			},
			metadataCache: {
				resolvedLinks: {},
				getFileCache: (): null => null,
				getFirstLinkpathDest: (): null => null,
			},
		} as unknown as App;

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			[{ from: 'Speaker 1', to: 'Alex' }],
			FORMAT,
			{ allowBroad: false },
		);

		expect(result.updatedTranscriptFiles).toBe(1);
		// The concurrent "live edit" survives; only the speaker label changed.
		expect(live.get('audio/rec.txt')).toBe('[0:00] Alex: live edit');
	});

	it('is a no-op for an empty rename list', async () => {
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['audio/rec.txt', '[0:00] Speaker 1: hi'],
		]);
		const app = makeApp(files);
		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			[],
			FORMAT,
			{ allowBroad: false },
		);
		expect(result.updatedTranscriptFiles).toBe(0);
		expect(files.get('audio/rec.txt')).toBe('[0:00] Speaker 1: hi');
	});
});
