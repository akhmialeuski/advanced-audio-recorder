/**
 * Tests for what the recording panel says about a recording: which pieces of
 * the sidecar it gathers, who it lists as having taken part, how it names the
 * profile, and which recordings a note is taken to be about.
 */

import type { CachedMetadata, TFile } from 'obsidian';
import {
	formatPanelDate,
	recordingsReferencedBy,
	summarizeRecording,
	type RecordingPanelSources,
} from 'src/panel/recordingPanelModel';
import { emptyTranscriptSection } from 'src/sidecar/recordingSidecarModel';
import { partial } from '../helpers/doubles';
import { fileAt } from '../helpers/obsidianMock';

/** Sources for a recording nothing was ever done with, with overrides. */
function sources(
	overrides: Partial<RecordingPanelSources> = {},
): RecordingPanelSources {
	return {
		transcript: emptyTranscriptSection(),
		failedParts: null,
		profiles: [],
		...overrides,
	};
}

describe('summarizing a recording', () => {
	it('lists each participant with the speaker label given their name', () => {
		const transcript = emptyTranscriptSection();
		transcript.participants = ['Anna', 'Boris'];
		transcript.speakers = [
			{ label: 'Speaker 1', name: 'Boris' },
			{ label: 'Speaker 2' },
		];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.participants).toEqual([
			{ name: 'Anna', speaker: null },
			{ name: 'Boris', speaker: 'Speaker 1' },
		]);
	});

	it('adds a name given only to a speaker after the participants', () => {
		const transcript = emptyTranscriptSection();
		transcript.participants = ['Anna'];
		transcript.speakers = [{ label: 'Speaker 3', name: 'Guest' }];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.participants).toEqual([
			{ name: 'Anna', speaker: null },
			{ name: 'Guest', speaker: 'Speaker 3' },
		]);
	});

	it('lists nobody for speakers no one named', () => {
		const transcript = emptyTranscriptSection();
		transcript.speakers = [{ label: 'Speaker 1' }, { label: 'Speaker 2' }];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.participants).toEqual([]);
	});

	it('keeps the first label of a name given to two speakers', () => {
		const transcript = emptyTranscriptSection();
		transcript.speakers = [
			{ label: 'Speaker 1', name: 'Anna' },
			{ label: 'Speaker 4', name: 'Anna' },
		];

		const summary = summarizeRecording(sources({ transcript }));

		expect(summary.participants).toEqual([
			{ name: 'Anna', speaker: 'Speaker 1' },
		]);
	});

	it('reads how and when the recording was transcribed', () => {
		const transcript = emptyTranscriptSection();
		transcript.provenance = {
			model: 'deepgram',
			language: 'ru',
			createdAt: '2026-10-15T08:28:44Z',
		};

		const summary = summarizeRecording(sources({ transcript }));

		expect([
			summary.model,
			summary.language,
			summary.transcribedAt,
		]).toEqual(['deepgram', 'ru', '2026-10-15T08:28:44Z']);
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
