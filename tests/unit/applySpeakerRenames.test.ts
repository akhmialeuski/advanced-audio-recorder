/**
 * Tests for the sidecar-driven speaker rename application: recorded file
 * outputs rewritten at their exact paths, recorded notes rewritten with the
 * templates they were written with (scoped to the recording's timecode
 * lines), the three untouched-note outcomes counted apart (never attempted for
 * want of a scope, attempted and already showing these names, attempted and
 * holding no rendered label), missing outputs skipped and counted, and the
 * unscopable-note detection behind the broad-rewrite opt-in.
 */

import type { App, CachedMetadata, TFile } from 'obsidian';
import {
	applySpeakerRenamesWithSidecar,
	hasUnscopableRecordedNote,
} from 'src/speakers/applySpeakerRenames';
import {
	emptyTranscriptSection,
	type NoteOutput,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';

const FORMAT = '**{speaker}**';

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
	return partial<TFile>({ path, name, extension });
};

/**
 * Builds a fake App over an in-memory file map with a metadata cache. Files
 * resolve by basename, notes carry the given link/embed caches, and paths in
 * `failPaths` throw on write to exercise the per-output resilience.
 */
function makeApp(
	files: Map<string, string>,
	opts: {
		caches?: Record<string, Cache>;
		failPaths?: Set<string>;
	} = {},
): App {
	const { caches = {}, failPaths = new Set() } = opts;
	return createMockApp({
		vault: {
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
	}).app;
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

/**
 * The same note after a rename already reached it. Only this recording's lines
 * carry the new names, so the neighbour's line still shows its engine label
 * exactly as a scoped rewrite leaves it, and the line positions the cache
 * refers to are unchanged.
 */
function renamedMeetingNote(): { content: string; cache: Cache } {
	const { content, cache } = meetingNote();
	const lines = content.split('\n');
	lines[2] = '[00:00](rec.wav#t=0) **Alex** hello';
	lines[3] = '[00:05](rec.wav#t=5) **Bob** hi';
	return { content: lines.join('\n'), cache };
}

/** Builds a recorded note output with the given speaker template. */
function recordedNote(path: string, speakerFormat = FORMAT): NoteOutput {
	return {
		path,
		templates: {
			lineFormat: '{timestamp} {speaker} {text}',
			speakerFormat,
			includeTimestamps: true,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		},
		heading: 'Transcript',
		writtenAt: '2026-07-21T10:00:00Z',
	};
}

describe('applySpeakerRenamesWithSidecar', () => {
	it("rewrites recorded outputs and only this recording's note lines", async () => {
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
		]);
		const app = makeApp(files, { caches: { 'meeting.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md')],
			fileOutputs: [
				{
					path: 'audio/rec.transcript.json',
					format: 'json',
					writtenAt: 't',
				},
				{ path: 'audio/rec.srt', format: 'srt', writtenAt: 't' },
			],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);

		expect(result.updatedTranscriptFiles).toBe(2);
		expect(result.updatedNotes).toBe(1);
		expect(result.failed).toBe(0);
		expect(files.get('audio/rec.transcript.json')).toContain('"Alex"');
		expect(files.get('audio/rec.srt')).toContain('Alex: hi');
		const note = files.get('meeting.md') ?? '';
		expect(note).toContain('**Alex** hello');
		expect(note).toContain('**Bob** hi');
		// The other recording's transcript in the same note is untouched.
		expect(note).toContain('**Speaker 1** unrelated');
	});

	it('rewrites recorded file outputs at their exact (collision) paths only', async () => {
		// The recorded output lives at a collision path; the unrecorded file
		// with the canonical name belongs to nobody and stays untouched.
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			[
				'audio/rec_1.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: hi',
			],
			[
				'audio/rec.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: old copy',
			],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{ path: 'audio/rec_1.srt', format: 'srt', writtenAt: 't' },
			],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.updatedTranscriptFiles).toBe(1);
		expect(files.get('audio/rec_1.srt')).toContain('Alex: hi');
		expect(files.get('audio/rec.srt')).toContain('Speaker 1: old copy');
	});

	it('skips recorded outputs whose path no longer resolves', async () => {
		const files = new Map<string, string>([['audio/rec.wav', '']]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('gone.md')],
			fileOutputs: [
				{ path: 'audio/gone.srt', format: 'srt', writtenAt: 't' },
			],
		};
		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.missingOutputs).toBe(2);
		expect(result.failed).toBe(0);
	});

	it('rewrites a recorded note with its recorded template, not the current one', async () => {
		// The note was written with an underscore speaker template while the
		// plugin settings have long moved on; the rewrite must match the note
		// as written.
		const content = [
			'![[rec.wav]]',
			'',
			'[00:00](rec.wav#t=0) __Speaker 1__ hello',
		].join('\n');
		const cache: Cache = {
			links: [
				{
					link: 'rec.wav#t=0',
					position: { start: { line: 2 }, end: { line: 2 } },
				},
			],
		};
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['meeting.md', content],
		]);
		const app = makeApp(files, { caches: { 'meeting.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md', '__{speaker}__')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.updatedNotes).toBe(1);
		expect(files.get('meeting.md')).toContain('__Alex__ hello');
	});

	it('rewrites an LLM-processed note whose timecoded lines survived', async () => {
		// The cleanup pass is instructed to keep speaker labels and timestamps
		// on their original lines, so the rendered transcript is still there;
		// the rename must not refuse the note just because the flag is set.
		const { content, cache } = meetingNote();
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.updatedNotes).toBe(1);
		expect(result.unmatchedNotes).toBe(0);
		expect(result.unscopableNotes).toBe(0);
		const note = files.get('cleaned.md') ?? '';
		expect(note).toContain('**Alex** hello');
		expect(note).toContain('**Bob** hi');
		expect(note).toContain('**Speaker 1** unrelated');
	});

	it('counts a note the pass restructured, its labels folded into prose', async () => {
		// The timecode links survived, so the note is scoped and genuinely
		// attempted; the pass dissolved the rendered labels into the sentence,
		// leaving a template-driven rewrite nothing to match. This is the only
		// shape that may be reported as carrying no labels.
		const content = [
			'![[rec.wav]]',
			'',
			'[00:00](rec.wav#t=0) Alex opened the meeting.',
			'[00:05](rec.wav#t=5) Bob answered right away.',
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
			],
		};
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.unmatchedNotes).toBe(1);
		expect(result.unscopableNotes).toBe(0);
		expect(result.updatedNotes).toBe(0);
		expect(files.get('cleaned.md')).toBe(content);
	});

	it('counts an untimecoded note as unscopable, never as unmatched', async () => {
		// The labels are right there and the broad opt-in would rewrite them,
		// so reporting this as a note without matching labels would state a
		// false reason and hide the remedy from the user.
		const content = 'Cleaned up prose mentioning **Speaker 1** somewhere.';
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.unscopableNotes).toBe(1);
		expect(result.unmatchedNotes).toBe(0);
		expect(result.updatedNotes).toBe(0);
		expect(files.get('cleaned.md')).toBe(content);
	});

	it('rewrites that same untimecoded note once broad is allowed', async () => {
		// The proof that the previous case was never "no matching labels": the
		// identical content rewrites cleanly the moment the opt-in is on.
		const content = 'Cleaned up prose mentioning **Speaker 1** somewhere.';
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: true },
		);
		expect(result.updatedNotes).toBe(1);
		expect(result.unscopableNotes).toBe(0);
		expect(result.unmatchedNotes).toBe(0);
		expect(files.get('cleaned.md')).toContain('**Alex** somewhere.');
	});

	it('counts a broad-allowed note with no labels at all as unmatched', async () => {
		// With the opt-in on, an untimecoded note is attempted whole; only now
		// may "no matching labels" be reported, and only because it is true.
		const content = 'A summary paragraph naming nobody in particular.';
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: true },
		);
		expect(result.unmatchedNotes).toBe(1);
		expect(result.unscopableNotes).toBe(0);
		expect(result.updatedNotes).toBe(0);
	});

	it('counts a note that already shows these names as current', async () => {
		// Both a healthy note and one whose labels are gone leave the rewrite
		// with nothing to do, so only reading the note back tells them apart.
		// Accusing this one is the misreport the separate count exists for.
		const content = renamedMeetingNote().content;
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['meeting.md', content],
		]);
		const app = makeApp(files, {
			caches: { 'meeting.md': renamedMeetingNote().cache },
		});
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.alreadyCurrentNotes).toBe(1);
		expect(result.unmatchedNotes).toBe(0);
		expect(result.updatedNotes).toBe(0);
		expect(files.get('meeting.md')).toBe(content);
	});

	it('heals one note while reporting the other as already current', async () => {
		// The shape a repeated apply takes after a write failed on one output:
		// the roster and the healthy note agree, the failed one still shows the
		// engine label, and this apply is what closes the gap.
		const healed = meetingNote();
		const current = renamedMeetingNote();
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['stale.md', healed.content],
			['fresh.md', current.content],
		]);
		const app = makeApp(files, {
			caches: { 'stale.md': healed.cache, 'fresh.md': current.cache },
		});
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('stale.md'), recordedNote('fresh.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.updatedNotes).toBe(1);
		expect(result.alreadyCurrentNotes).toBe(1);
		expect(result.unmatchedNotes).toBe(0);
		expect(files.get('stale.md')).toContain('**Alex** hello');
		expect(files.get('fresh.md')).toBe(current.content);
	});

	it("reads 'already current' from this recording's lines only", async () => {
		// The new names sit on a second recording's line while this
		// recording's own lines lost their labels: scoping the read-back the
		// same way the rewrite scopes keeps the neighbour from vouching for a
		// transcript that really is beyond reach.
		const content = [
			'![[rec.wav]]',
			'',
			'[00:00](rec.wav#t=0) Alex opened the meeting.',
			'',
			'[00:00](other.wav#t=0) **Alex** unrelated',
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
					link: 'other.wav#t=0',
					position: { start: { line: 4 }, end: { line: 4 } },
				},
			],
		};
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['meeting.md', content],
		]);
		const app = makeApp(files, { caches: { 'meeting.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.unmatchedNotes).toBe(1);
		expect(result.alreadyCurrentNotes).toBe(0);
	});

	it('counts a broad-allowed note that already shows the names as current', async () => {
		const content = 'Cleaned up prose mentioning **Alex** somewhere.';
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', content],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: true },
		);
		expect(result.alreadyCurrentNotes).toBe(1);
		expect(result.unmatchedNotes).toBe(0);
		expect(files.get('cleaned.md')).toBe(content);
	});

	it('leaves an already-current transcript file byte-identical', async () => {
		// A healing apply runs over every recorded output, so a file that
		// needs nothing must not be re-serialized into a phantom update.
		const serialized = JSON.stringify(
			{
				language: 'en',
				segments: [
					{ speaker: 'Alex', text: 'hi' },
					{ speaker: 'Bob', text: 'hello' },
				],
				speakers: ['Alex', 'Bob'],
			},
			null,
			2,
		);
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['audio/rec.transcript.json', serialized],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{
					path: 'audio/rec.transcript.json',
					format: 'json',
					writtenAt: 't',
				},
			],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(result.updatedTranscriptFiles).toBe(0);
		expect(result.failed).toBe(0);
		expect(files.get('audio/rec.transcript.json')).toBe(serialized);
	});

	it('rewrites an untimecoded recorded note only under allowBroad', async () => {
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
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md')],
		};

		const scopedFiles = build();
		const scoped = await applySpeakerRenamesWithSidecar(
			makeApp(scopedFiles, { caches: { 'meeting.md': cache } }),
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);
		expect(scoped.updatedNotes).toBe(0);
		// Never attempted, so it counts as unscopable however the run was
		// configured; the flag plays no part in this at all.
		expect(scoped.unscopableNotes).toBe(1);
		expect(scoped.unmatchedNotes).toBe(0);
		expect(scopedFiles.get('meeting.md')).toBe(content);

		const broadFiles = build();
		const broad = await applySpeakerRenamesWithSidecar(
			makeApp(broadFiles, { caches: { 'meeting.md': cache } }),
			audioFile,
			section,
			renames,
			{ allowBroad: true },
		);
		expect(broad.updatedNotes).toBe(1);
		expect(broad.unscopableNotes).toBe(0);
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
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{ path: 'audio/rec.srt', format: 'srt', writtenAt: 't' },
				{ path: 'audio/rec.txt', format: 'txt', writtenAt: 't' },
			],
		};
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			renames,
			{ allowBroad: false },
		);

		expect(result.failed).toBe(1);
		expect(result.updatedTranscriptFiles).toBe(1);
		expect(files.get('audio/rec.txt')).toBe('[0:00] Alex: hi');
	});

	it('rewrites the content vault.process supplies, not a stale read', async () => {
		const live = new Map<string, string>([
			['audio/rec.wav', ''],
			['audio/rec.txt', '[0:00] Speaker 1: live edit'],
		]);
		// read returns a stale snapshot while process operates on the current
		// content, mimicking an edit landing between the two calls.
		const app = createMockApp({
			vault: {
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
				getFileCache: (): null => null,
				getFirstLinkpathDest: (): null => null,
			},
		}).app;
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{ path: 'audio/rec.txt', format: 'txt', writtenAt: 't' },
			],
		};

		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			[{ from: 'Speaker 1', to: 'Alex' }],
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
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{ path: 'audio/rec.txt', format: 'txt', writtenAt: 't' },
			],
		};
		const result = await applySpeakerRenamesWithSidecar(
			app,
			audioFile,
			section,
			[],
			{ allowBroad: false },
		);
		expect(result.updatedTranscriptFiles).toBe(0);
		expect(files.get('audio/rec.txt')).toBe('[0:00] Speaker 1: hi');
	});
});

describe('hasUnscopableRecordedNote', () => {
	it('flags an existing recorded note without timecode-scoped lines', () => {
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['plain.md', '**Speaker 1** hi'],
		]);
		const app = makeApp(files, { caches: { 'plain.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('plain.md')],
		};
		expect(hasUnscopableRecordedNote(app, audioFile, section)).toBe(true);
	});

	it('ignores missing and properly scoped notes', () => {
		const { content, cache } = meetingNote();
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['other.wav', ''],
			['meeting.md', content],
		]);
		const app = makeApp(files, { caches: { 'meeting.md': cache } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('meeting.md'), recordedNote('gone.md')],
		};
		expect(hasUnscopableRecordedNote(app, audioFile, section)).toBe(false);
	});

	it('flags an LLM-processed note that lost its timecode links', () => {
		// Stripping the timecode links is exactly what a restructuring pass
		// does, and it is the case the broad opt-in exists for.
		const files = new Map<string, string>([
			['audio/rec.wav', ''],
			['cleaned.md', 'llm prose mentioning **Speaker 1**'],
		]);
		const app = makeApp(files, { caches: { 'cleaned.md': {} } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md')],
		};
		expect(hasUnscopableRecordedNote(app, audioFile, section)).toBe(true);
	});
});
