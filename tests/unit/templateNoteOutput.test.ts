/**
 * Tests writing the note a template built: into the recording's note with its
 * properties, keeping the ones it had, or as a note of its own next to the
 * recording, linked from its note.
 * @module tests/unit/templateNoteOutput.test
 */

import {
	separateNoteName,
	writeNoteProperties,
	writeTemplateNote,
} from 'src/transcription/templateNoteOutput';
import type { TemplateNoteRequest } from 'src/transcription/templateNoteOutput';
import { recordingVault } from '../helpers/recordingVault';
import { noticeMessages } from '../mocks/obsidian';

const STANDUP = 'Recordings/standup.webm';
const MEETING = 'Meetings/standup.md';
const OWN_NOTE = 'Recordings/standup - Daily sync.md';

/** A meeting note with properties of its own and the recording embedded. */
const MEETING_TEXT = [
	'---',
	'tags:',
	'  - meeting',
	'status: draft',
	'---',
	'![[standup.webm]]',
].join('\n');

/**
 * The vault, and a request for the recording's note.
 * @param overrides - What differs from writing into the meeting note
 */
function createSut(overrides: Partial<TemplateNoteRequest> = {}) {
	const vault = recordingVault({
		recordings: [STANDUP],
		notes: { [MEETING]: MEETING_TEXT },
	});
	const request: TemplateNoteRequest = {
		recording: vault.file(STANDUP),
		notePath: MEETING,
		markdown: '### Summary\n\n- Ship on Friday.',
		heading: '## Notes',
		templateName: 'Daily sync',
		properties: { summary: 'Ship on Friday.', participants: 'Anna, Ben' },
		output: 'note',
		...overrides,
	};
	return {
		...vault,
		request,
		read: (path: string): Promise<string> =>
			vault.app.vault.read(vault.file(path)),
	};
}

describe('writing a template note into the recording note', () => {
	it('sets its properties and keeps the ones the note had', async () => {
		const sut = createSut();

		await expect(writeTemplateNote(sut.app, sut.request)).resolves.toBe(
			MEETING,
		);

		const text = await sut.read(MEETING);
		expect(text).toMatch(
			/^---\ntags:\n {2}- meeting\nstatus: draft\nsummary: "Ship on Friday\."\nparticipants: "Anna, Ben"\n---\n/,
		);
		expect(text).toContain('## Notes\n\n### Summary\n\n- Ship on Friday.');
	});

	it('answers null when the note cannot be written', async () => {
		const sut = createSut({ notePath: 'Meetings/gone.md' });

		await expect(
			writeTemplateNote(sut.app, sut.request),
		).resolves.toBeNull();
	});
});

describe('writing a template note apart', () => {
	it('creates it next to the recording, with the properties, and links it', async () => {
		const sut = createSut({ output: 'separate' });

		await expect(writeTemplateNote(sut.app, sut.request)).resolves.toBe(
			OWN_NOTE,
		);

		expect(await sut.read(OWN_NOTE)).toBe(
			'---\nsummary: "Ship on Friday."\nparticipants: "Anna, Ben"\n---\n### Summary\n\n- Ship on Friday.',
		);
		const meeting = await sut.read(MEETING);
		expect(meeting).toContain('## Notes\n\n[[standup - Daily sync]]');
		// The recording's note keeps its properties as they were.
		expect(meeting).toMatch(
			/^---\ntags:\n {2}- meeting\nstatus: draft\n---\n/,
		);
	});

	it('gives a second run a name of its own', async () => {
		const sut = createSut({ output: 'separate', properties: {} });

		await writeTemplateNote(sut.app, sut.request);
		await expect(writeTemplateNote(sut.app, sut.request)).resolves.toBe(
			'Recordings/standup - Daily sync_1.md',
		);
	});

	it('is what a run with no note to go into writes', async () => {
		const sut = createSut({ notePath: '', properties: {} });

		await expect(writeTemplateNote(sut.app, sut.request)).resolves.toBe(
			OWN_NOTE,
		);
		expect(await sut.read(MEETING)).toBe(MEETING_TEXT);
	});

	it('says so when the note it wrote cannot be linked', async () => {
		const sut = createSut({
			output: 'separate',
			notePath: 'Meetings/gone.md',
			properties: {},
		});

		await expect(writeTemplateNote(sut.app, sut.request)).resolves.toBe(
			OWN_NOTE,
		);
		expect(noticeMessages()).toContain(
			`Wrote ${OWN_NOTE}, but could not link it from Meetings/gone.md.`,
		);
	});

	it('answers null when the note cannot be created', async () => {
		const sut = createSut({ output: 'separate' });
		jest.spyOn(sut.app.vault, 'create').mockRejectedValue(
			new Error('read-only'),
		);

		await expect(
			writeTemplateNote(sut.app, sut.request),
		).resolves.toBeNull();
	});
});

describe('writeNoteProperties', () => {
	it('tells, rather than throws, when the frontmatter cannot be written', async () => {
		const sut = createSut();
		jest.spyOn(sut.app.fileManager, 'processFrontMatter').mockRejectedValue(
			new Error('locked'),
		);

		await writeNoteProperties(sut.app, MEETING, { summary: 'x' });

		expect(noticeMessages()).toContain(
			`The note template's properties could not be written to ${MEETING}.`,
		);
	});

	it('leaves a note without properties to write, or that is not there, alone', async () => {
		const sut = createSut();

		await writeNoteProperties(sut.app, MEETING, {});
		await writeNoteProperties(sut.app, 'Meetings/gone.md', { a: 'b' });

		expect(sut.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});
});

describe('separateNoteName', () => {
	it('names the note after the recording and the template', () => {
		const sut = createSut();

		expect(separateNoteName(sut.file(STANDUP), 'Lecture')).toBe(
			'standup - Lecture.md',
		);
	});
});
