/**
 * Tests for the notice a finished transcript split shows: what it updated,
 * and - never silently - what it kept as it was.
 */

import { describeTranscriptSplit } from 'src/speakers/applyTranscriptSplit';

describe('describeTranscriptSplit', () => {
	it('names the updated files and the added speakers', () => {
		expect(
			describeTranscriptSplit({
				rewrittenFiles: 2,
				keptFiles: 0,
				addedSpeakers: 2,
			}),
		).toBe(
			'Split the transcript line. Updated 2 transcript files. Added 2 speakers to the recording, so "Rename speakers" can name them.',
		);
	});

	it('says which files were kept and why', () => {
		expect(
			describeTranscriptSplit({
				rewrittenFiles: 0,
				keptFiles: 2,
				addedSpeakers: 0,
			}),
		).toBe(
			'Split the transcript line. 2 transcript files were kept as they were: only a JSON transcript holding this line keeps the timings a split needs.',
		);
	});

	it('says no more than that the line was split when that is all', () => {
		expect(
			describeTranscriptSplit({
				rewrittenFiles: 0,
				keptFiles: 0,
				addedSpeakers: 0,
			}),
		).toBe('Split the transcript line.');
	});
});
