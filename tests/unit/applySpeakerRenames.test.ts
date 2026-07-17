/**
 * Tests for applying speaker renames across the vault: transcript sidecar
 * files next to the recording and notes that reference the recording.
 */

import type { App, TFile } from 'obsidian';
import { applySpeakerRenamesToVault } from 'src/speakers/applySpeakerRenames';

const SPEAKER_FORMAT = '**{speaker}**';

/**
 * Builds a fake App over an in-memory file map: getFileByPath resolves
 * paths present in the map, vault.process rewrites their content, and
 * resolvedLinks names the notes that reference the audio file.
 */
function makeApp(
	files: Map<string, string>,
	resolvedLinks: Record<string, Record<string, number>> = {},
): App {
	return {
		vault: {
			getFileByPath: (path: string) =>
				files.has(path) ? ({ path } as unknown as TFile) : null,
			process: async (
				file: TFile,
				fn: (content: string) => string,
			): Promise<string> => {
				const next = fn(files.get(file.path) ?? '');
				files.set(file.path, next);
				return next;
			},
		},
		metadataCache: { resolvedLinks },
	} as unknown as App;
}

const audioFile = { path: 'audio/rec.wav' } as unknown as TFile;
const renames = [{ from: 'Speaker 1', to: 'Alex' }];

describe('applySpeakerRenamesToVault', () => {
	it('rewrites every existing transcript sidecar format', async () => {
		const files = new Map<string, string>([
			[
				'audio/rec.transcript.json',
				JSON.stringify({
					segments: [
						{ start: 0, end: 1, text: 'hi', speaker: 'Speaker 1' },
					],
					speakers: ['Speaker 1'],
				}),
			],
			[
				'audio/rec.srt',
				'1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: hi',
			],
			[
				'audio/rec.vtt',
				'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSpeaker 1: hi',
			],
			['audio/rec.txt', '[0:00] Speaker 1: hi'],
		]);
		const app = makeApp(files);

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			SPEAKER_FORMAT,
		);

		expect(result.updatedTranscriptFiles).toBe(4);
		expect(files.get('audio/rec.transcript.json')).toContain('"Alex"');
		expect(files.get('audio/rec.srt')).toContain('Alex: hi');
		expect(files.get('audio/rec.vtt')).toContain('Alex: hi');
		expect(files.get('audio/rec.txt')).toBe('[0:00] Alex: hi');
	});

	it('rewrites notes that reference the audio and counts only changed ones', async () => {
		const files = new Map<string, string>([
			['meeting.md', '![[rec.wav]]\n\n[[rec#t=0|0:00]] **Speaker 1** hi'],
			['linked-only.md', 'See ![[rec.wav]]'],
		]);
		const app = makeApp(files, {
			'meeting.md': { 'audio/rec.wav': 1 },
			'linked-only.md': { 'audio/rec.wav': 1 },
			'unrelated.md': { 'other.wav': 1 },
		});

		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			SPEAKER_FORMAT,
		);

		expect(result.updatedNotes).toBe(1);
		expect(files.get('meeting.md')).toContain('**Alex** hi');
		expect(files.get('linked-only.md')).toBe('See ![[rec.wav]]');
	});

	it('skips missing sidecars and notes without touching anything', async () => {
		const app = makeApp(new Map(), {
			'gone.md': { 'audio/rec.wav': 1 },
		});
		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			renames,
			SPEAKER_FORMAT,
		);
		expect(result).toEqual({
			updatedNotes: 0,
			updatedTranscriptFiles: 0,
		});
	});

	it('is a no-op for an empty rename list', async () => {
		const files = new Map<string, string>([
			['audio/rec.txt', '[0:00] Speaker 1: hi'],
		]);
		const app = makeApp(files);
		const result = await applySpeakerRenamesToVault(
			app,
			audioFile,
			[],
			SPEAKER_FORMAT,
		);
		expect(result.updatedTranscriptFiles).toBe(0);
		expect(files.get('audio/rec.txt')).toBe('[0:00] Speaker 1: hi');
	});
});
