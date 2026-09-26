/**
 * Tests for the notice a finished transcript split or merge shows: what it
 * updated, and - never silently - what it kept as it was.
 */

import {
	describeTranscriptMerge,
	describeTranscriptSplit,
} from 'src/speakers/applyTranscriptEdit';

describe('describeTranscriptSplit', () => {
	it('names the updated files and the added speakers', () => {
		expect(
			describeTranscriptSplit(
				{
					rewrittenFiles: 2,
					keptFiles: 0,
					addedSpeakers: 2,
				},
				true,
			),
		).toBe(
			'Split the transcript line. Updated 2 transcript files. Added 2 speakers to the recording, so "Rename speakers" can name them.',
		);
	});

	it('counts a single file and a single speaker in the singular', () => {
		expect(
			describeTranscriptSplit(
				{ rewrittenFiles: 1, keptFiles: 0, addedSpeakers: 1 },
				true,
			),
		).toBe(
			'Split the transcript line. Updated 1 transcript file. Added 1 speaker to the recording, so "Rename speakers" can name it.',
		);
	});

	it('points at no rename action when renaming speakers is turned off', () => {
		expect(
			describeTranscriptSplit(
				{ rewrittenFiles: 0, keptFiles: 0, addedSpeakers: 1 },
				false,
			),
		).toBe('Split the transcript line. Added 1 speaker to the recording.');
	});

	it('says which files were kept and why', () => {
		expect(
			describeTranscriptSplit(
				{
					rewrittenFiles: 0,
					keptFiles: 2,
					addedSpeakers: 0,
				},
				true,
			),
		).toBe(
			'Split the transcript line. 2 transcript files were kept as they were: only a JSON transcript holding this line keeps the timings a split needs.',
		);
	});

	it('says no more than that the line was split when that is all', () => {
		expect(
			describeTranscriptSplit(
				{
					rewrittenFiles: 0,
					keptFiles: 0,
					addedSpeakers: 0,
				},
				true,
			),
		).toBe('Split the transcript line.');
	});
});

describe('describeTranscriptMerge', () => {
	it('says how many lines were merged and what was updated', () => {
		expect(
			describeTranscriptMerge(
				3,
				{ rewrittenFiles: 2, keptFiles: 0, addedSpeakers: 0 },
				true,
			),
		).toBe(
			'Merged 3 transcript lines into one. Updated 2 transcript files.',
		);
	});

	it('names the speaker the merge added', () => {
		expect(
			describeTranscriptMerge(
				2,
				{ rewrittenFiles: 1, keptFiles: 0, addedSpeakers: 1 },
				true,
			),
		).toBe(
			'Merged 2 transcript lines into one. Updated 1 transcript file. Added 1 speaker to the recording, so "Rename speakers" can name it.',
		);
	});

	it('says which files were kept and why', () => {
		expect(
			describeTranscriptMerge(
				2,
				{ rewrittenFiles: 0, keptFiles: 1, addedSpeakers: 0 },
				false,
			),
		).toBe(
			'Merged 2 transcript lines into one. 1 transcript file was kept as it was: only a JSON transcript holding these lines keeps the timings a merge needs.',
		);
	});
});
