/**
 * Tests for describeTranscriptOutcome: the pure notice-text builder. The
 * regression focus is that a requested-but-not-inserted transcript never
 * reads as success and always points the user to the fallback file.
 */

import { describeTranscriptOutcome } from 'src/transcription/transcriptOutput';

describe('describeTranscriptOutcome', () => {
	it('reports a plain in-note insertion', () => {
		expect(
			describeTranscriptOutcome({
				inserted: true,
				filePath: null,
				noteRequested: true,
				savedAsFallback: false,
			}),
		).toBe('Transcript inserted into the note.');
	});

	it('reports insertion and a sidecar file', () => {
		expect(
			describeTranscriptOutcome({
				inserted: true,
				filePath: 'audio.srt',
				noteRequested: true,
				savedAsFallback: false,
			}),
		).toBe('Transcript inserted into the note and saved to audio.srt.');
	});

	it('reports a file-only destination', () => {
		expect(
			describeTranscriptOutcome({
				inserted: false,
				filePath: 'audio.json',
				noteRequested: false,
				savedAsFallback: false,
			}),
		).toBe('Transcript saved to audio.json.');
	});

	it('does not claim success when a note insert failed but a fallback file was written', () => {
		const text = describeTranscriptOutcome({
			inserted: false,
			filePath: 'audio.json',
			noteRequested: true,
			savedAsFallback: true,
		});
		expect(text).toContain('Could not insert');
		expect(text).toContain('audio.json');
		expect(text).not.toContain('inserted into the note.');
	});

	it('reports an honest failure when nothing could be written', () => {
		const text = describeTranscriptOutcome({
			inserted: false,
			filePath: null,
			noteRequested: true,
			savedAsFallback: false,
		});
		expect(text.toLowerCase()).toContain('could not write');
	});

	it('reports a file saved and linked in the note', () => {
		expect(
			describeTranscriptOutcome({
				inserted: false,
				filePath: 'audio.srt',
				noteRequested: false,
				savedAsFallback: false,
				linkRequested: true,
				linkInserted: true,
			}),
		).toBe('Transcript saved to audio.srt and linked in the note.');
	});

	it('does not claim a link when the note was not editable', () => {
		const text = describeTranscriptOutcome({
			inserted: false,
			filePath: 'audio.srt',
			noteRequested: false,
			savedAsFallback: false,
			linkRequested: true,
			linkInserted: false,
		});
		expect(text).toContain('saved to audio.srt');
		expect(text).toContain('to link it');
		expect(text).not.toContain('linked in the note.');
	});
});
