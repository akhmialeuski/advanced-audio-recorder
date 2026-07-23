/**
 * Tests for locating a recording's transcript for auto chapters: the
 * sidecar-recorded outputs are authoritative when present (files in format
 * preference order, then notes scoped by timecode links, with the recorded
 * provenance language riding along), while a recording without recorded
 * outputs falls back to legacy discovery (files next to the audio by name,
 * then referencing notes). "No transcript" is reported as null.
 */

import type { App, CachedMetadata, TFile } from 'obsidian';
import {
	loadTranscriptLines,
	timedLinesFromTranscript,
	type TranscriptSectionReader,
} from 'src/chapters/transcriptSources';
import {
	emptyTranscriptSection,
	type NoteOutput,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
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

	it('carries the language from the JSON sidecar', async () => {
		const transcript = {
			language: 'ru',
			segments: [{ start: 0, end: 3, text: 'привет' }],
		};
		const files = new Map([
			['rec.wav', ''],
			['rec.transcript.json', JSON.stringify(transcript)],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.language).toBe('ru');
	});

	it('leaves the language unset for a sidecar format that has none', async () => {
		const srt = '1\n00:00:01,000 --> 00:00:02,000\nhello\n';
		const files = new Map([
			['rec.wav', ''],
			['rec.srt', srt],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(app, tf('rec.wav'));
		expect(found?.lines).toHaveLength(1);
		expect(found?.language).toBeUndefined();
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

describe('loadTranscriptLines with a recorded sidecar section', () => {
	const sidecarWith = (
		section: TranscriptSection,
	): TranscriptSectionReader => ({
		getTranscript: () => Promise.resolve(section),
	});

	function recordedNote(path: string, llmProcessed = false): NoteOutput {
		return {
			path,
			templates: {
				lineFormat: '{timestamp} {speaker} {text}',
				speakerFormat: '**{speaker}**',
				includeTimestamps: true,
				timestampLinks: true,
				mergeConsecutiveSpeaker: true,
			},
			llmProcessed,
			heading: 'Transcript',
			writtenAt: 't',
		};
	}

	it('reads the recorded file output instead of scanning for candidates', async () => {
		// The recorded output lives at a collision path; the decoy at the
		// canonical name would win a discovery scan but must not be touched.
		const files = new Map([
			['rec.wav', ''],
			['rec_1.txt', '[0:05] recorded output'],
			['rec.txt', '[0:05] decoy at the canonical path'],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [{ path: 'rec_1.txt', format: 'txt', writtenAt: 't' }],
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('rec_1.txt');
		expect(found?.lines).toEqual([{ time: 5, text: 'recorded output' }]);
	});

	it('prefers the recorded JSON output over other recorded formats', async () => {
		const transcript = {
			language: 'ru',
			segments: [{ start: 0, end: 3, text: 'привет' }],
		};
		const files = new Map([
			['rec.wav', ''],
			['rec.srt', '1\n00:00:00,000 --> 00:00:01,000\nsubtitle line'],
			['rec.transcript.json', JSON.stringify(transcript)],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [
				{ path: 'rec.srt', format: 'srt', writtenAt: 't' },
				{ path: 'rec.transcript.json', format: 'json', writtenAt: 't' },
			],
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('rec.transcript.json');
		expect(found?.language).toBe('ru');
	});

	it('falls back to the recorded provenance language for non-JSON outputs', async () => {
		const files = new Map([
			['rec.wav', ''],
			['rec.srt', '1\n00:00:00,000 --> 00:00:01,000\nsubtitle line'],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [{ path: 'rec.srt', format: 'srt', writtenAt: 't' }],
			provenance: { language: 'de' },
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('rec.srt');
		expect(found?.language).toBe('de');
	});

	it('reads a recorded note, skipping LLM-replaced ones', async () => {
		const note =
			'# Meeting\n' +
			'[[rec.wav#t=0|0:00]] **Speaker 1** welcome\n' +
			'[[rec.wav#t=65|1:05]] **Speaker 2** first topic\n';
		const files = new Map([
			['rec.wav', ''],
			['note.md', note],
			['cleaned.md', 'llm prose without timecodes'],
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
		];
		const app = makeApp(files, { caches: { 'note.md': { links: refs } } });
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [
				recordedNote('cleaned.md', true),
				recordedNote('note.md'),
			],
			provenance: { language: 'en' },
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('note.md');
		expect(found?.language).toBe('en');
		expect(found?.lines).toEqual([
			{ time: 0, text: '0:00 Speaker 1 welcome' },
			{ time: 65, text: '1:05 Speaker 2 first topic' },
		]);
	});

	it('falls back to discovery when every recorded output is gone', async () => {
		// The recorded output was deleted, but an unrecorded transcript sits
		// next to the audio: reporting "no transcript" would hide it.
		const files = new Map([
			['rec.wav', ''],
			['rec.txt', '[0:05] unrecorded transcript'],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [{ path: 'gone.txt', format: 'txt', writtenAt: 't' }],
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('rec.txt');
		expect(found?.lines).toEqual([
			{ time: 5, text: 'unrecorded transcript' },
		]);
	});

	it('falls back to discovery when the only recorded note is LLM-replaced', async () => {
		const files = new Map([
			['rec.wav', ''],
			['cleaned.md', 'llm prose, no transcript lines'],
			['rec.srt', '1\n00:00:00,000 --> 00:00:05,000\nfrom disk'],
		]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			noteOutputs: [recordedNote('cleaned.md', true)],
		};
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(section),
		);
		expect(found?.origin).toBe('rec.srt');
	});

	it('still returns null when neither records nor discovery find anything', async () => {
		const files = new Map([['rec.wav', '']]);
		const app = makeApp(files);
		const section: TranscriptSection = {
			...emptyTranscriptSection(),
			fileOutputs: [{ path: 'gone.txt', format: 'txt', writtenAt: 't' }],
		};
		expect(
			await loadTranscriptLines(app, tf('rec.wav'), sidecarWith(section)),
		).toBeNull();
	});

	it('discovers legacy transcripts when the section records no outputs', async () => {
		const files = new Map([
			['rec.wav', ''],
			['rec.txt', '[0:05] legacy transcript'],
		]);
		const app = makeApp(files);
		const found = await loadTranscriptLines(
			app,
			tf('rec.wav'),
			sidecarWith(emptyTranscriptSection()),
		);
		expect(found?.origin).toBe('rec.txt');
	});

	it('falls back to discovery when the sidecar read fails', async () => {
		const files = new Map([
			['rec.wav', ''],
			['rec.txt', '[0:05] discovered'],
		]);
		const app = makeApp(files);
		const warn = jest
			.spyOn(console, 'warn')
			.mockImplementation(() => undefined);
		const failing: TranscriptSectionReader = {
			getTranscript: () => Promise.reject(new Error('io error')),
		};
		const found = await loadTranscriptLines(app, tf('rec.wav'), failing);
		expect(found?.origin).toBe('rec.txt');
		warn.mockRestore();
	});
});
