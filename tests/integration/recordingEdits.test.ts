/**
 * Tests for the file actions that edit what belongs to a recording, as the
 * command line runs them and as the menus run them: deleting it with its
 * links, generating its chapters, and exporting them.
 * @module tests/integration/recordingEdits.test
 */

import type { Editor } from 'obsidian';
import {
	deleteRecordingWithLink,
	exportChaptersFromCli,
	generateChaptersFromCli,
} from 'src/actions/recordingEdits';
import type { FileContext } from 'src/actions/PluginAction';
import type { PlayerMarker } from 'src/markers/markerModel';
import { ProfileKindId, createProfile } from 'src/settings/profiles';
import { recordingVault } from '../helpers/recordingVault';
import { partial } from '../helpers/doubles';
import { noticeMessages } from '../mocks/obsidian';

const STANDUP = 'Recordings/standup.webm';
const MEETING = 'Meetings/standup.md';

/**
 * A vault holding the recording and a meeting note of the given text, and
 * the context the command line resolves over them.
 * @param meeting - The meeting note's text
 */
function createSut(meeting = '![[standup.webm]]'): ReturnType<
	typeof recordingVault
> & {
	context: FileContext;
	read: () => Promise<string>;
} {
	const vault = recordingVault({
		recordings: [STANDUP],
		notes: { [MEETING]: meeting },
	});
	const note = vault.file(MEETING);
	return {
		...vault,
		context: { file: vault.file(STANDUP), note, services: vault.services },
		read: () => vault.app.vault.read(note),
	};
}

describe('deleting a recording with its links', () => {
	it('removes exactly the link it was opened on, from the editor', async () => {
		const sut = createSut();
		const replaceRange = jest.fn();

		const answer = await deleteRecordingWithLink({
			...sut.context,
			link: {
				editor: partial<Editor>({ replaceRange }),
				subpath: '',
				line: 0,
				start: 0,
				end: 17,
			},
		});

		expect(answer).toBe('Recording and link deleted');
		expect(replaceRange).toHaveBeenCalledWith(
			'',
			{ line: 0, ch: 0 },
			{ line: 0, ch: 17 },
		);
		expect(sut.app.vault.getFileByPath(STANDUP)).toBeNull();
	});

	it('keeps a timecode link it was opened on, removing the whole-file links instead', async () => {
		const sut = createSut(
			'![[standup.webm]]\n[[standup.webm#t=90|1:30]] Budget.',
		);
		const replaceRange = jest.fn();

		const answer = await deleteRecordingWithLink({
			...sut.context,
			link: {
				editor: partial<Editor>({ replaceRange }),
				subpath: '#t=90',
				line: 1,
				start: 0,
				end: 26,
			},
		});

		expect(replaceRange).not.toHaveBeenCalled();
		expect(answer).toBe(
			`Deleted ${STANDUP} and removed 1 link(s) to it from ${MEETING}.`,
		);
		await expect(sut.read()).resolves.toBe(
			'\n[[standup.webm#t=90|1:30]] Budget.',
		);
	});

	it('removes every link to the whole recording from the note named', async () => {
		const sut = createSut('# Standup\n![[standup.webm]]\nSee [[standup]].');

		const answer = await deleteRecordingWithLink(sut.context);

		expect(answer).toBe(
			`Deleted ${STANDUP} and removed 2 link(s) to it from ${MEETING}.`,
		);
		await expect(sut.read()).resolves.toBe('# Standup\n\nSee .');
	});

	it('keeps the timecode links of a transcript, which belong to its lines', async () => {
		const sut = createSut(
			'![[standup.webm]]\n[[standup.webm#t=12|0:12]] Hello.',
		);

		await deleteRecordingWithLink(sut.context);

		await expect(sut.read()).resolves.toBe(
			'\n[[standup.webm#t=12|0:12]] Hello.',
		);
	});

	it('leaves a link that moved since the note was indexed', async () => {
		const sut = createSut('![[standup.webm]]');
		await sut.app.vault.modify(
			sut.file(MEETING),
			'Moved ![[standup.webm]]',
		);

		const answer = await deleteRecordingWithLink(sut.context);

		expect(answer).toBe(
			`Deleted ${STANDUP} and removed 0 link(s) to it from ${MEETING}. 1 link(s) changed since the note was last indexed and were left in place.`,
		);
		await expect(sut.read()).resolves.toBe('Moved ![[standup.webm]]');
	});

	it('says a link in the properties was left, since a property holds it', async () => {
		const sut = createSut('---\naudio: "[[standup.webm]]"\n---\nBody');

		await expect(deleteRecordingWithLink(sut.context)).resolves.toBe(
			`Deleted ${STANDUP} and removed 0 link(s) to it from ${MEETING}. 1 link(s) in the properties were left in place.`,
		);
	});

	it('only deletes a recording reached through no note and no link', async () => {
		const sut = createSut();

		await expect(
			deleteRecordingWithLink({
				file: sut.file(STANDUP),
				services: sut.services,
			}),
		).resolves.toBe('Recording deleted');
		await expect(sut.read()).resolves.toBe('![[standup.webm]]');
	});

	it('fails when the recording cannot be trashed, before touching the note', async () => {
		const sut = createSut();
		jest.mocked(sut.app.fileManager.trashFile).mockRejectedValue(
			new Error('locked'),
		);

		await expect(deleteRecordingWithLink(sut.context)).rejects.toThrow(
			'locked',
		);
		await expect(sut.read()).resolves.toBe('![[standup.webm]]');
	});
});

describe('generating chapters from the command line', () => {
	/** A chapter service double over what the recording has already. */
	function withChapters(
		sut: ReturnType<typeof createSut>,
		existing: boolean,
	): { generate: jest.Mock } {
		const generate = jest.fn(
			(
				_file: unknown,
				_transcript: unknown,
				_lines: unknown,
				_signal: unknown,
				notify: (message: string) => void,
			) => {
				notify('Generating chapters for standup.webm...');
				notify('Added 3 chapters to standup.webm.');
				return Promise.resolve(true);
			},
		);
		Object.assign(sut.services.autoChapters, {
			generate,
			hasExistingChapters: jest.fn().mockResolvedValue(existing),
		});
		return { generate };
	}

	it('answers with what the generation said', async () => {
		const sut = createSut();
		withChapters(sut, false);

		await expect(generateChaptersFromCli(sut.context, {})).resolves.toBe(
			'Generating chapters for standup.webm...\nAdded 3 chapters to standup.webm.',
		);
	});

	it('keeps chapters generated before unless replace is typed', async () => {
		const sut = createSut();
		const { generate } = withChapters(sut, true);

		await expect(generateChaptersFromCli(sut.context, {})).resolves.toBe(
			`${STANDUP} already has generated chapters. Add replace to generate them again; bookmarks and chapters added by hand are kept.`,
		);
		expect(generate).not.toHaveBeenCalled();
	});

	it('generates them again with replace', async () => {
		const sut = createSut();
		const { generate } = withChapters(sut, true);

		await generateChaptersFromCli(sut.context, { replace: 'true' });

		expect(generate).toHaveBeenCalledTimes(1);
	});

	it('keeps the profile picked as the default, as the dialog does', async () => {
		const sut = createSut();
		withChapters(sut, false);
		const profile = createProfile(ProfileKindId.ChapterPrompt, 'Lecture');
		sut.settings.profiles = [profile];
		const save = jest.spyOn(sut.services, 'saveSettings');

		await generateChaptersFromCli(sut.context, { profile: 'lecture' });

		expect(
			sut.settings.selectedProfileIds[ProfileKindId.ChapterPrompt],
		).toBe(profile.id);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it('refuses a profile nobody made', async () => {
		const sut = createSut();
		const { generate } = withChapters(sut, false);

		await expect(
			generateChaptersFromCli(sut.context, { profile: 'Podcast' }),
		).resolves.toBe(
			'No profile named "Podcast". The ones to choose from: none, Default.',
		);
		expect(generate).not.toHaveBeenCalled();
	});
});

describe('exporting chapters from the command line', () => {
	const markers: PlayerMarker[] = [
		{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
		{ id: 'b', time: 75, label: 'Budget', kind: 'chapter' },
	];

	/** The vault, its recording holding the markers. */
	function withMarkers(
		held: PlayerMarker[] = markers,
	): ReturnType<typeof createSut> {
		const sut = createSut();
		jest.mocked(sut.services.recordingSidecar.getMarkers).mockResolvedValue(
			held,
		);
		return sut;
	}

	it('writes the timecoded list beside the recording', async () => {
		const sut = withMarkers();

		await expect(exportChaptersFromCli(sut.context, {})).resolves.toBe(
			'Markers written to Recordings/standup.chapters.txt.',
		);
		await expect(
			sut.app.vault.read(sut.file('Recordings/standup.chapters.txt')),
		).resolves.toBe('0:00 Intro\n1:15 Budget');
	});

	it('writes a cue sheet with format=cue', async () => {
		const sut = withMarkers();

		await expect(
			exportChaptersFromCli(sut.context, { format: 'cue' }),
		).resolves.toBe('Markers written to Recordings/standup.cue.');
	});

	it('prints instead of writing with print', async () => {
		const sut = withMarkers();

		await expect(
			exportChaptersFromCli(sut.context, { print: 'true' }),
		).resolves.toBe('0:00 Intro\n1:15 Budget');
		expect(
			sut.app.vault.getFileByPath('Recordings/standup.chapters.txt'),
		).toBeNull();
	});

	it('prints the outline, which belongs in a note', async () => {
		const sut = withMarkers();

		await expect(
			exportChaptersFromCli(sut.context, { format: 'outline' }),
		).resolves.toContain('Budget');
	});

	it.each([
		{ reached: 'through its note', throughNote: true, from: MEETING },
		{ reached: 'directly', throughNote: false, from: '' },
	])(
		'links the outline from where the recording was reached: $reached',
		async ({ throughNote, from }) => {
			const sut = withMarkers();
			const links = jest.spyOn(
				sut.app.fileManager,
				'generateMarkdownLink',
			);
			const { note: _note, ...direct } = sut.context;

			await exportChaptersFromCli(throughNote ? sut.context : direct, {
				format: 'outline',
			});

			expect(links).toHaveBeenCalledWith(
				sut.file(STANDUP),
				from,
				'#t=75',
				'1:15',
			);
		},
	);

	it('writes beside a recording at the root of the vault', async () => {
		const vault = recordingVault({ recordings: ['standup.webm'] });
		jest.mocked(
			vault.services.recordingSidecar.getMarkers,
		).mockResolvedValue(markers);

		await expect(
			exportChaptersFromCli(
				{ file: vault.file('standup.webm'), services: vault.services },
				{},
			),
		).resolves.toBe('Markers written to standup.chapters.txt.');
	});

	it('says so when there is nothing to export', async () => {
		const sut = withMarkers([]);

		await expect(exportChaptersFromCli(sut.context, {})).resolves.toBe(
			`${STANDUP} has no chapters or markers to export.`,
		);
	});

	it('refuses a format it does not write', async () => {
		const sut = withMarkers();

		await expect(
			exportChaptersFromCli(sut.context, { format: 'pdf' }),
		).resolves.toBe('format=pdf is not one of: list, cue, outline.');
	});
});

describe('nothing said along the way', () => {
	it('shows no notice for an answer the command line gives itself', async () => {
		const sut = createSut();

		await exportChaptersFromCli(sut.context, { format: 'pdf' });

		expect(noticeMessages()).toEqual([]);
	});
});
