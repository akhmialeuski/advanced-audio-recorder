/**
 * Tests for what the recording panel says about a recording: which pieces of
 * the sidecar it gathers, how it names the template and the profile, and which
 * recordings a note is taken to be about.
 */

import type { CachedMetadata, TFile } from 'obsidian';
import {
	formatPanelDate,
	recordingsReferencedBy,
	summarizeRecording,
	type RecordingPanelSources,
} from 'src/panel/recordingPanelModel';
import {
	emptyTranscriptSection,
	type NoteOutput,
} from 'src/sidecar/recordingSidecarModel';
import type { PlayerMarker } from 'src/markers/markerModel';
import { TranscriptFileFormat } from 'src/transcription/TranscriptTypes';
import { partial } from '../helpers/doubles';
import { fileAt } from '../helpers/obsidianMock';

/** A note output written with the given line template at the given time. */
function noteOutput(
	path: string,
	lineFormat: string,
	writtenAt: string,
): NoteOutput {
	return {
		path,
		heading: '',
		writtenAt,
		templates: {
			lineFormat,
			speakerFormat: '**{speaker}**',
			includeTimestamps: true,
			timestampLinks: true,
			mergeConsecutiveSpeaker: true,
		},
	};
}

/** A marker of the given kind. */
function marker(kind: PlayerMarker['kind']): PlayerMarker {
	return partial<PlayerMarker>({ id: kind, time: 1, label: kind, kind });
}

/** Sources for a recording nothing was ever done with, with overrides. */
function sources(
	overrides: Partial<RecordingPanelSources> = {},
): RecordingPanelSources {
	return {
		transcript: emptyTranscriptSection(),
		markers: [],
		failedParts: null,
		profiles: [],
		notePath: '',
		...overrides,
	};
}

describe('summarizing a recording', () => {
	it('lists each speaker with the name the user gave it', () => {
		const transcript = emptyTranscriptSection();
		transcript.speakers = [
			{ label: 'Speaker 1', name: 'Anna' },
			{ label: 'Speaker 2' },
		];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.speakers).toEqual([
			{ label: 'Speaker 1', name: 'Anna' },
			{ label: 'Speaker 2', name: null },
		]);
	});

	it('names the participants profile the names came from', () => {
		const transcript = emptyTranscriptSection();
		transcript.participantProfileId = 'team';

		const summary = summarizeRecording(
			sources({
				transcript,
				profiles: [
					{
						id: 'team',
						kind: 'participants',
						name: 'Weekly sync',
						body: '',
					},
				],
			}),
		);

		expect(summary.participantProfile).toBe('Weekly sync');
	});

	it('names no profile when the one on record was deleted since', () => {
		const transcript = emptyTranscriptSection();
		transcript.participantProfileId = 'gone';

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.participantProfile).toBeNull();
	});

	it('shows the template of the note in view over a later write elsewhere', () => {
		const transcript = emptyTranscriptSection();
		transcript.noteOutputs = [
			noteOutput(
				'Meeting.md',
				'{speaker}: {text}',
				'2026-01-01T10:00:00Z',
			),
			noteOutput('Other.md', '{text}', '2026-02-01T10:00:00Z'),
		];

		const summary = summarizeRecording(
			sources({ transcript, notePath: 'Meeting.md' }),
		);

		expect(summary.lineTemplate).toBe('{speaker}: {text}');
	});

	it('shows the latest template when the recording itself is open', () => {
		const transcript = emptyTranscriptSection();
		transcript.noteOutputs = [
			noteOutput('Old.md', '{text}', '2026-01-01T10:00:00Z'),
			noteOutput('New.md', '{timestamp} {text}', '2026-03-01T10:00:00Z'),
		];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.lineTemplate).toBe('{timestamp} {text}');
	});

	it('counts chapters and bookmarks apart', () => {
		const summary = summarizeRecording(
			sources({
				markers: [
					marker('chapter'),
					marker('chapter'),
					marker('bookmark'),
				],
			}),
		);

		expect([summary.chapters, summary.bookmarks]).toEqual([2, 1]);
	});

	it('counts the parts the last run lost', () => {
		const summary = summarizeRecording(
			sources({
				failedParts: {
					recordedAt: '2026-01-01T00:00:00Z',
					parts: [
						{
							label: 'Part 2',
							message: 'timeout',
							startSeconds: 60,
						},
					],
				},
			}),
		);

		expect(summary.failedParts).toBe(1);
	});

	it('labels a translated transcript file with its language', () => {
		const transcript = emptyTranscriptSection();
		transcript.fileOutputs = [
			{
				path: 'rec.de.srt',
				format: TranscriptFileFormat.Srt,
				writtenAt: '',
				language: 'de',
			},
		];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.fileOutputs).toEqual([
			{ path: 'rec.de.srt', format: 'SRT', language: 'de' },
		]);
	});
});

describe('the recordings a note refers to', () => {
	/** Resolves link texts against a fixed set of files. */
	function resolver(...paths: string[]): (link: string) => TFile | null {
		const files = new Map(paths.map((path) => [path, fileAt(path)]));
		return (link) => files.get(link) ?? null;
	}

	it('lists embeds before links, each recording once', () => {
		const cache = partial<CachedMetadata>({
			embeds: [{ link: 'b.webm' }],
			links: [{ link: 'a.mp3' }, { link: 'b.webm#t=30' }],
		});

		const recordings = recordingsReferencedBy(
			cache,
			resolver('a.mp3', 'b.webm'),
		);

		expect(recordings.map((file) => file.path)).toEqual([
			'b.webm',
			'a.mp3',
		]);
	});

	it('leaves out links to files that are not audio', () => {
		const cache = partial<CachedMetadata>({
			embeds: [{ link: 'diagram.png' }, { link: 'call.m4a' }],
		});

		const recordings = recordingsReferencedBy(
			cache,
			resolver('diagram.png', 'call.m4a'),
		);

		expect(recordings.map((file) => file.path)).toEqual(['call.m4a']);
	});

	it('finds a recording a note property links to', () => {
		const cache = partial<CachedMetadata>({
			frontmatterLinks: [{ key: 'recording', link: 'standup.webm' }],
		});

		const recordings = recordingsReferencedBy(
			cache,
			resolver('standup.webm'),
		);

		expect(recordings.map((file) => file.path)).toEqual(['standup.webm']);
	});

	it('finds nothing in a note the cache has not parsed yet', () => {
		expect(recordingsReferencedBy(null, resolver())).toEqual([]);
	});
});

describe('printing a stored timestamp', () => {
	it('keeps text that is not a date as it was written', () => {
		expect(formatPanelDate('last Tuesday')).toBe('last Tuesday');
	});
});
