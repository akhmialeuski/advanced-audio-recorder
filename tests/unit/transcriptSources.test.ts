/**
 * Tests for transcript discovery/parsing for auto chapters: reading timed
 * lines out of sidecar files (JSON, SRT, VTT, TXT) and out of notes whose
 * timecode links resolve to the recording, and reporting "no transcript"
 * as null.
 */

import type { App, CachedMetadata, TFile } from 'obsidian';
import {
	loadTranscriptLines,
	timedLinesFromTranscript,
} from 'src/chapters/transcriptSources';
import type { Transcript } from 'src/transcription/TranscriptTypes';

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

/** Builds a fake App over an in-memory file map with a metadata cache. */
function makeApp(
	files: Map<string, string>,
	opts: {
		resolvedLinks?: Record<string, Record<string, number>>;
		caches?: Record<string, Cache>;
	} = {},
): App {
	const { resolvedLinks = {}, caches = {} } = opts;
	return {
		vault: {
			getFiles: (): TFile[] => [...files.keys()].map(tf),
			getFileByPath: (path: string): TFile | null =>
				files.has(path) ? tf(path) : null,
			read: async (file: TFile): Promise<string> =>
				files.get(file.path) ?? '',
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

describe('timedLinesFromTranscript', () => {
	it('renders one line per segment with the speaker prefixed', () => {
		const transcript: Transcript = {
			segments: [
				{ start: 0, end: 4, text: 'hello', speaker: 'Speaker 1' },
				{ start: 5, end: 9, text: 'world' },
				{ start: 10, end: 11, text: '   ' },
			],
			speakers: ['Speaker 1'],
		};
		expect(timedLinesFromTranscript(transcript)).toEqual([
			{ time: 0, text: 'Speaker 1: hello' },
			{ time: 5, text: 'world' },
		]);
	});
});

describe('loadTranscriptLines', () => {
	it('returns null when the recording has no transcript anywhere', async () => {
		const files = new Map([['rec.wav', '']]);
		const app = makeApp(files);
		expect(await loadTranscriptLines(app, tf('rec.wav'))).toBeNull();
	});

	it('reads the JSON sidecar first', async () => {
		const transcript = {
			segments: [
				{ start: 0, end: 3, text: 'hi', speaker: 'Speaker 1' },
				{ start: 4, end: 8, text: 'there' },
			],
		};
		const files = new Map([
			['rec.wav', ''],
			['rec.transcript.json', JSON.stringify(transcript)],
			['rec.txt', '[0:10] should not win'],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.origin).toBe('rec.transcript.json');
		expect(found?.lines).toEqual([
			{ time: 0, text: 'Speaker 1: hi' },
			{ time: 4, text: 'there' },
		]);
	});

	it('parses SRT cues with speaker prefixes', async () => {
		const srt =
			'1\n00:00:01,500 --> 00:00:04,000\nSpeaker 1: hello\n\n' +
			'2\n00:01:00,000 --> 00:01:02,000\nsecond cue\nsecond line\n';
		const files = new Map([
			['rec.wav', ''],
			['rec.srt', srt],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.lines).toEqual([
			{ time: 1.5, text: 'Speaker 1: hello' },
			{ time: 60, text: 'second cue second line' },
		]);
	});

	it('parses VTT cues past the header', async () => {
		const vtt =
			'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nfirst\n\n' +
			'00:00:10.000 --> 00:00:12.000\nsecond\n';
		const files = new Map([
			['rec.wav', ''],
			['rec.vtt', vtt],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.lines).toEqual([
			{ time: 2, text: 'first' },
			{ time: 10, text: 'second' },
		]);
	});

	it('parses bracketed timecodes from a TXT sidecar', async () => {
		const txt = '[0:05] Speaker 1: hi\nno timecode line\n[1:00:01] later\n';
		const files = new Map([
			['rec.wav', ''],
			['rec.txt', txt],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.lines).toEqual([
			{ time: 5, text: 'Speaker 1: hi' },
			{ time: 3601, text: 'later' },
		]);
	});

	it('falls back to a note whose timecode links resolve to the audio', async () => {
		const note =
			'# Meeting\n' +
			'[[rec.wav#t=0|0:00]] **Speaker 1** welcome\n' +
			'[[rec.wav#t=65|1:05]] **Speaker 2** first topic\n' +
			'[[other.wav#t=5|0:05]] unrelated recording\n';
		const files = new Map([
			['rec.wav', ''],
			['other.wav', ''],
			['note.md', note],
		]);
		const refs: Ref[] = [
			{
				link: 'rec.wav#t=0',
				position: { start: { line: 1 }, end: { line: 1 } },
			},
			{
				link: 'rec.wav#t=65',
				position: { start: { line: 2 }, end: { line: 2 } },
			},
			{
				link: 'other.wav#t=5',
				position: { start: { line: 3 }, end: { line: 3 } },
			},
		];
		const app = makeApp(files, {
			resolvedLinks: { 'note.md': { 'rec.wav': 3, 'other.wav': 1 } },
			caches: { 'note.md': { links: refs } },
		});
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.origin).toBe('note.md');
		expect(found?.lines).toEqual([
			{ time: 0, text: '0:00 Speaker 1 welcome' },
			{ time: 65, text: '1:05 Speaker 2 first topic' },
		]);
	});

	it("ignores a sibling recording's own sidecar", async () => {
		const files = new Map([
			['rec.wav', ''],
			['rec_1.wav', ''],
			['rec_1.txt', '[0:05] belongs to the sibling'],
		]);
		const app = makeApp(files);
		expect(await loadTranscriptLines(app, tf('rec.wav'))).toBeNull();
	});
});
