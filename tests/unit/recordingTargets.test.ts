/**
 * Tests for how a file action finds its recordings: directly, as the active
 * audio file or a path on the command line, or through a note that embeds
 * them - every one of them, the one under the cursor, or the one the command
 * line picks - and what it says when it finds none.
 * @module tests/unit/recordingTargets.test
 */

import {
	activeRecordings,
	describeRecording,
	namedRecordings,
	namedVaultFile,
	recordingsInNote,
} from 'src/actions/recordingTargets';
import type { FileContext } from 'src/actions/PluginAction';
import { recordingVault } from '../helpers/recordingVault';
import { createMarkdownView } from '../helpers/createApp';
import { asMockWorkspace } from '../helpers/obsidianMock';

const STANDUP = 'Recordings/standup.webm';
const RETRO = 'Recordings/retro.mp3';
const MEETING = 'Meetings/Team Meeting.md';

/** A vault holding both recordings, a meeting note and an empty one. */
function createSut(
	options: { meeting?: readonly string[]; active?: string } = {},
): ReturnType<typeof recordingVault> {
	return recordingVault({
		recordings: [STANDUP, RETRO, 'Images/slide.png'],
		notes: {
			[MEETING]: options.meeting ?? [STANDUP, RETRO],
			'Meetings/Empty.md': [],
		},
		...(options.active ? { active: options.active } : {}),
	});
}

/** The recordings of the targets, by path, with the note each came through. */
const paths = (targets: readonly FileContext[] | string): unknown =>
	typeof targets === 'string'
		? targets
		: targets.map((target) => [target.file.path, target.note?.path]);

describe('the recordings a note links', () => {
	it('lists them in the order the note does', () => {
		const sut = createSut();

		expect(
			recordingsInNote(sut.app, sut.file(MEETING)).map(
				(file) => file.path,
			),
		).toEqual([STANDUP, RETRO]);
	});

	it('folds a recording the note embeds twice into one', () => {
		const sut = createSut({ meeting: [STANDUP, STANDUP] });

		expect(recordingsInNote(sut.app, sut.file(MEETING))).toHaveLength(1);
	});

	it('leaves out what is not audio', () => {
		const sut = createSut({ meeting: ['Images/slide.png', RETRO] });

		expect(
			recordingsInNote(sut.app, sut.file(MEETING)).map(
				(file) => file.path,
			),
		).toEqual([RETRO]);
	});

	it('resolves a recording a transcript links on every line only once', () => {
		const lines = Array.from(
			{ length: 50 },
			(_, second) =>
				`[[standup.webm#t=${String(second)}|0:00]] **Ann** Hi.`,
		);
		const sut = recordingVault({
			recordings: [STANDUP],
			notes: { [MEETING]: lines.join('\n') },
		});
		const resolve = jest.spyOn(
			sut.app.metadataCache,
			'getFirstLinkpathDest',
		);

		expect(recordingsInNote(sut.app, sut.file(MEETING))).toHaveLength(1);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('finds nothing in a note the cache has not read', () => {
		const sut = createSut();

		expect(recordingsInNote(sut.app, sut.file(STANDUP))).toEqual([]);
	});
});

describe('the file a command line names', () => {
	it.each([
		{ name: 'an exact path', args: { path: STANDUP } },
		{
			name: 'a name, as a wikilink resolves it',
			args: { file: 'standup' },
		},
		{ name: 'a path given as the name', args: { file: STANDUP } },
	])('finds $name', ({ args }) => {
		const sut = createSut();

		expect(namedVaultFile(sut.app, args)).toEqual({
			value: sut.file(STANDUP),
		});
	});

	it.each([
		{
			args: { path: 'nowhere.webm' },
			refusal: 'No file at "nowhere.webm" in this vault.',
		},
		{
			args: { file: 'nowhere' },
			refusal: 'No file named "nowhere" in this vault.',
		},
	])('refuses $args', ({ args, refusal }) => {
		const sut = createSut();

		expect(namedVaultFile(sut.app, args)).toEqual({ refusal });
	});

	it.each([
		{ name: 'neither is typed', args: {} },
		// A parameter typed without its value arrives as the word 'true'.
		{ name: 'one is typed without a value', args: { file: 'true' } },
		{ name: 'one is blank', args: { path: '  ' } },
	])('names none when $name', ({ args }) => {
		const sut = createSut();

		expect(namedVaultFile(sut.app, args)).toEqual({ value: null });
	});
});

describe('the recordings the palette acts on', () => {
	it('is the active audio file itself', () => {
		const sut = createSut({ active: STANDUP });

		expect(paths(activeRecordings(sut.services))).toEqual([
			[STANDUP, undefined],
		]);
	});

	it('is every recording of the active note', () => {
		const sut = createSut({ active: MEETING });

		expect(paths(activeRecordings(sut.services))).toEqual([
			[STANDUP, MEETING],
			[RETRO, MEETING],
		]);
	});

	it('is the one under the cursor, with its link', () => {
		const sut = createSut({ active: MEETING });
		const view = createMarkdownView({
			file: sut.file(MEETING),
			cursor: { line: 4, ch: 3 },
		});
		Object.assign(view.editor, { getLine: () => '![[retro.mp3]]' });
		asMockWorkspace(sut.app.workspace).seedActiveView(view);

		const [target] = activeRecordings(sut.services);

		expect(target?.file.path).toBe(RETRO);
		expect(target?.link).toEqual({
			editor: view.editor,
			line: 4,
			start: 0,
			end: 14,
		});
	});

	it('picks the recording of a timecode link, which is not the link to remove', () => {
		const sut = createSut({ active: MEETING });
		const view = createMarkdownView({
			file: sut.file(MEETING),
			cursor: { line: 4, ch: 3 },
		});
		Object.assign(view.editor, {
			getLine: () => '[[retro.mp3#t=90|1:30]] **Ann** Budget.',
		});
		asMockWorkspace(sut.app.workspace).seedActiveView(view);

		const [target] = activeRecordings(sut.services);

		expect(target?.file.path).toBe(RETRO);
		expect(target?.link).toBeUndefined();
	});

	it('falls back to the whole note when the cursor is on a link to no recording', () => {
		const sut = createSut({ active: MEETING });
		const view = createMarkdownView({ file: sut.file(MEETING) });
		Object.assign(view.editor, { getLine: () => '![[slide.png]]' });
		asMockWorkspace(sut.app.workspace).seedActiveView(view);

		expect(activeRecordings(sut.services)).toHaveLength(2);
	});

	it('falls back to the whole note when the cursor is on no recording', () => {
		const sut = createSut({ active: MEETING });
		const view = createMarkdownView({ file: sut.file(MEETING) });
		Object.assign(view.editor, { getLine: () => '# Meeting' });
		asMockWorkspace(sut.app.workspace).seedActiveView(view);

		expect(activeRecordings(sut.services)).toHaveLength(2);
	});

	it.each([
		{ name: 'nothing is open', active: undefined },
		{ name: 'an image is open', active: 'Images/slide.png' },
		{
			name: 'a note without recordings is open',
			active: 'Meetings/Empty.md',
		},
	])('is nothing when $name', ({ active }) => {
		const sut = createSut(active ? { active } : {});

		expect(activeRecordings(sut.services)).toEqual([]);
	});
});

describe('the recordings a command line names', () => {
	it('is the recording named', () => {
		const sut = createSut();

		expect(paths(namedRecordings(sut.services, { path: STANDUP }))).toEqual(
			[[STANDUP, undefined]],
		);
	});

	it('carries the note named beside it', () => {
		const sut = createSut();

		expect(
			paths(
				namedRecordings(sut.services, {
					path: STANDUP,
					note: 'Team Meeting',
				}),
			),
		).toEqual([[STANDUP, MEETING]]);
	});

	it('is the only recording of the note named', () => {
		const sut = createSut({ meeting: [RETRO] });

		expect(paths(namedRecordings(sut.services, { path: MEETING }))).toEqual(
			[[RETRO, MEETING]],
		);
	});

	it('is every recording of the note with all', () => {
		const sut = createSut();

		expect(
			namedRecordings(sut.services, { path: MEETING, all: 'true' }),
		).toHaveLength(2);
	});

	it.each([
		{ name: 'its path', recording: RETRO },
		{ name: 'its name', recording: 'retro.mp3' },
		{ name: 'its base name', recording: 'retro' },
	])('is the recording of the note picked by $name', ({ recording }) => {
		const sut = createSut();

		expect(
			paths(namedRecordings(sut.services, { path: MEETING, recording })),
		).toEqual([[RETRO, MEETING]]);
	});

	it('stands in the active file when nothing is named', () => {
		const sut = createSut({ active: STANDUP });

		expect(paths(namedRecordings(sut.services, {}))).toEqual([
			[STANDUP, undefined],
		]);
	});

	it.each([
		{
			name: 'nothing is named or open',
			args: {},
			refusal:
				'Name a recording or a note with file=<name> or path=<vault path>, or open one in Obsidian.',
		},
		{
			name: 'the file is missing',
			args: { path: 'gone.webm' },
			refusal: 'No file at "gone.webm" in this vault.',
		},
		{
			name: 'the file is neither',
			args: { path: 'Images/slide.png' },
			refusal: 'Images/slide.png is neither a recording nor a note.',
		},
		{
			name: 'the note links nothing',
			args: { path: 'Meetings/Empty.md' },
			refusal: 'Meetings/Empty.md links no recording.',
		},
		{
			name: 'the note links several and none is picked',
			args: { path: MEETING },
			refusal: `${MEETING} links 2 recordings: ${STANDUP}, ${RETRO}. Name one with recording=<name>, or add all to run on each.`,
		},
		{
			name: 'the recording picked is not one of the note',
			args: { path: MEETING, recording: 'lecture' },
			refusal: `${MEETING} links no recording named "lecture". It links: ${STANDUP}, ${RETRO}.`,
		},
		{
			name: 'a recording is picked out of a recording',
			args: { path: STANDUP, recording: 'retro' },
			refusal: `recording= picks a recording of a note, and ${STANDUP} is a recording itself.`,
		},
		{
			name: 'a note is named beside a note',
			args: { path: MEETING, note: 'Empty' },
			refusal: `note= names the note of a recording, and ${MEETING} is a note itself.`,
		},
		{
			name: 'the note named beside a recording is missing',
			args: { path: STANDUP, note: 'Nowhere' },
			refusal: 'No note named "Nowhere" in this vault.',
		},
		{
			name: 'the note named beside a recording does not link it',
			args: { path: STANDUP, note: 'Empty' },
			refusal: `Meetings/Empty.md does not link ${STANDUP}. Name the note the recording belongs to.`,
		},
		{
			name: 'what is named beside a recording is not a note',
			args: { path: STANDUP, note: RETRO },
			refusal: `No note named "${RETRO}" in this vault.`,
		},
	])('refuses when $name', ({ args, refusal }) => {
		const sut = createSut();

		expect(namedRecordings(sut.services, args)).toBe(refusal);
	});
});

describe('naming a recording target', () => {
	it('uses its path', () => {
		const sut = createSut();

		expect(
			describeRecording({
				file: sut.file(STANDUP),
				services: sut.services,
			}),
		).toBe(STANDUP);
	});
});
