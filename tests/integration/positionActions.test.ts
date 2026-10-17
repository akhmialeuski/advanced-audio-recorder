/**
 * Tests for the actions on a point of a recording: adding a bookmark or a
 * chapter there, and a link to it. The palette acts at the playback that is
 * running, the menu at the point of the player clicked, the command line at
 * the time it names - and all three write the same marker the same way.
 * @module tests/integration/positionActions.test
 */

import type { CliData } from 'obsidian';
import {
	POSITION_ACTIONS,
	positionActionFamily,
} from 'src/actions/positionActions';
import type { PositionContext } from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import type { PlaybackControlsState } from 'src/player/playbackControls';
import { makeMarkerStore, makePlaybackState } from '../helpers/playbackHarness';
import { recordingVault } from '../helpers/recordingVault';
import { createMarkdownView } from '../helpers/createApp';
import { asMockWorkspace } from '../helpers/obsidianMock';
import { noticeMessages } from '../mocks/obsidian';
import { accepted, at as itemAt } from '../helpers/assertions';
import type { CliRead } from 'src/obsidian/cliArgs';

const LECTURE = 'Recordings/lecture.webm';
const NOTES = 'Notes/lecture.md';

/**
 * A vault with the recording, its note, and a marker store, and the position
 * family over a playback the test pins.
 * @param options - What plays, and with which settings
 */
function createSut(
	options: {
		playback?: PlaybackControlsState | null;
		markers?: boolean;
	} = {},
): ReturnType<typeof recordingVault> & {
	family: ReturnType<typeof positionActionFamily>;
	store: ReturnType<typeof makeMarkerStore>;
	resolve: (args: CliData) => Promise<CliRead<readonly PositionContext[]>>;
} {
	const vault = recordingVault({
		recordings: [LECTURE],
		notes: { [NOTES]: [LECTURE] },
		settings: { playerEnableMarkers: options.markers ?? true },
	});
	const store = makeMarkerStore();
	Object.assign(vault.services, { recordingSidecar: store });
	const playback = options.playback === undefined ? null : options.playback;
	const family = positionActionFamily(vault.services, () => playback);
	return {
		...vault,
		family,
		store,
		resolve: (args) => Promise.resolve(family.cliTarget.resolve(args)),
	};
}

/** The action of the given command id. */
function action(commandId: string): (typeof POSITION_ACTIONS)[number] {
	const found = POSITION_ACTIONS.find(
		(entry) => entry.commandId === commandId,
	);
	if (!found) {
		throw new Error(`No position action ${commandId}`);
	}
	return found;
}

/** A position in the lecture. */
function at(
	sut: ReturnType<typeof createSut>,
	seconds: number,
	editable = true,
): PositionContext {
	return {
		file: sut.file(LECTURE),
		seconds,
		editable,
		services: sut.services,
	};
}

describe('the actions on a point', () => {
	it('keeps the palette ids of the playback marker commands, so hotkeys survive', () => {
		expect(POSITION_ACTIONS.map((entry) => entry.commandId)).toEqual([
			COMMAND_IDS.addPlaybackBookmark,
			COMMAND_IDS.addPlaybackChapter,
			COMMAND_IDS.copyTimestampLink,
		]);
	});

	it('says "here" in a menu, where the palette names the playback', () => {
		expect(POSITION_ACTIONS.map((entry) => entry.menuTitle)).toEqual([
			'Add marker here',
			'Add chapter here',
			'Copy timestamp link here',
		]);
	});
});

describe('adding a marker at a point', () => {
	it.each([
		{
			commandId: COMMAND_IDS.addPlaybackBookmark,
			kind: 'bookmark',
			said: 'Marker 1 added at 0:42',
		},
		{
			commandId: COMMAND_IDS.addPlaybackChapter,
			kind: 'chapter',
			said: 'Chapter 1 added at 0:42',
		},
	])('adds a $kind and says so', async ({ commandId, kind, said }) => {
		const sut = createSut();

		await action(commandId).run(at(sut, 42));

		await expect(sut.store.getMarkers(LECTURE)).resolves.toEqual([
			expect.objectContaining({ time: 42, kind }),
		]);
		expect(noticeMessages()).toEqual([said]);
		expect(sut.services.onMarkersChanged).toHaveBeenCalledWith(LECTURE);
	});

	it('takes the label typed on the command line', async () => {
		const sut = createSut();

		await expect(
			Promise.resolve(
				action(COMMAND_IDS.addPlaybackChapter).cli.execute(
					at(sut, 75),
					{
						label: 'Budget',
					},
				),
			),
		).resolves.toBe('Budget added at 1:15');
	});

	it.each([
		{ name: 'markers are off', markers: false, editable: true },
		{ name: 'the player is read-only', markers: true, editable: false },
	])('is not offered where $name', ({ markers, editable }) => {
		const sut = createSut({ markers });

		expect(
			action(COMMAND_IDS.addPlaybackBookmark).isAvailable(
				at(sut, 1, editable),
			),
		).toBe(false);
	});

	it('says why on the command line', () => {
		expect(
			action(COMMAND_IDS.addPlaybackBookmark).cli.unavailable?.(
				at(createSut(), 1),
			),
		).toBe(
			'Markers are switched off in settings, or the player is read-only.',
		);
	});
});

describe('a link to a point', () => {
	it('is printed on the command line, as a transcript writes one', () => {
		const sut = createSut();
		jest.mocked(sut.app.fileManager.generateMarkdownLink).mockReturnValue(
			'[[lecture.webm#t=75|1:15]]',
		);

		expect(
			action(COMMAND_IDS.copyTimestampLink).cli.execute(
				at(sut, 75.8),
				{},
			),
		).toBe('[[lecture.webm#t=75|1:15]]');
		expect(sut.app.fileManager.generateMarkdownLink).toHaveBeenCalledWith(
			sut.file(LECTURE),
			'',
			'#t=75',
			'1:15',
		);
	});

	it('is copied from the menu and the palette', async () => {
		const writeText = jest.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText },
			configurable: true,
		});
		const sut = createSut();

		await action(COMMAND_IDS.copyTimestampLink).run(at(sut, 9));

		expect(writeText).toHaveBeenCalledWith('[[lecture.webm#t=9|0:09]]');
		expect(noticeMessages()).toEqual(['Copied timestamp link at 0:09']);
	});

	it('says so when the clipboard refuses', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: jest.fn().mockRejectedValue(new Error('denied')),
			},
			configurable: true,
		});

		await action(COMMAND_IDS.copyTimestampLink).run(at(createSut(), 9));

		expect(noticeMessages()).toEqual([
			'Could not copy timestamp link to the clipboard.',
		]);
	});
});

describe('the point the palette acts at', () => {
	it('is where the playback is, with the player own gate', () => {
		const sut = createSut({
			playback: makePlaybackState({
				recordingPath: LECTURE,
				currentTime: 65,
				markersEnabled: false,
			}),
		});

		expect(sut.family.activeTargets()).toEqual([
			expect.objectContaining({ seconds: 65, editable: false }),
		]);
	});

	it('names the active note as the one links are written for', () => {
		const sut = createSut({
			playback: makePlaybackState({ recordingPath: LECTURE }),
		});
		asMockWorkspace(sut.app.workspace).seedActiveView(
			createMarkdownView({ file: sut.file(NOTES) }),
		);

		expect(sut.family.activeTargets()[0]?.note?.path).toBe(NOTES);
	});

	it.each([
		{ name: 'nothing plays', playback: null },
		{
			name: 'what plays is gone from the vault',
			playback: makePlaybackState({ recordingPath: 'gone.webm' }),
		},
	])('is nowhere when $name', ({ playback }) => {
		expect(createSut({ playback }).family.activeTargets()).toEqual([]);
	});

	it('is named in a picker by the recording and the time', () => {
		const sut = createSut();

		expect(sut.family.describe(at(sut, 75))).toBe(`${LECTURE} at 1:15`);
	});
});

describe('the point a command line names', () => {
	it('is the time named in the recording named', async () => {
		const sut = createSut();

		await expect(
			sut.resolve({ path: LECTURE, at: '1:15' }),
		).resolves.toEqual({
			value: [expect.objectContaining({ seconds: 75, editable: true })],
		});
	});

	it('carries the note the recording was reached through', async () => {
		const sut = createSut();

		const target = itemAt(
			accepted(await sut.resolve({ path: NOTES, at: '10' })),
			0,
		);

		expect(target.note?.path).toBe(NOTES);
	});

	it('is where the playback is when nothing is named', async () => {
		const sut = createSut({
			playback: makePlaybackState({
				recordingPath: LECTURE,
				currentTime: 30,
			}),
		});

		await expect(sut.resolve({})).resolves.toEqual({
			value: [expect.objectContaining({ seconds: 30 })],
		});
	});

	it('takes the recording named, not the one playing', async () => {
		const sut = createSut({
			playback: makePlaybackState({
				recordingPath: LECTURE,
				currentTime: 30,
			}),
		});
		asMockWorkspace(sut.app.workspace).seedActiveFile(sut.file(NOTES));

		const target = itemAt(
			accepted(await sut.resolve({ recording: 'lecture', at: '5' })),
			0,
		);

		// Reached through the active note, as recording= names it, at the
		// time typed rather than where the playback stands.
		expect(target.seconds).toBe(5);
		expect(target.note?.path).toBe(NOTES);
	});

	it('moves off the playback by the time typed', async () => {
		const sut = createSut({
			playback: makePlaybackState({ recordingPath: LECTURE }),
		});

		await expect(sut.resolve({ at: '5' })).resolves.toEqual({
			value: [expect.objectContaining({ seconds: 5 })],
		});
	});

	it.each([
		{
			name: 'no time is named and nothing plays',
			args: { path: LECTURE },
			refusal:
				'Name the time with at=<seconds|m:ss|h:mm:ss>, or play the recording in Obsidian.',
		},
		{
			name: 'only a time is named and nothing plays',
			args: { at: '5' },
			refusal:
				'Name a recording or a note with file=<name> or path=<vault path>, or open one in Obsidian.',
		},
		{
			name: 'the time is not one',
			args: { path: LECTURE, at: 'soon' },
			refusal: 'at=soon is not a time: use seconds, m:ss or h:mm:ss.',
		},
		{
			name: 'the recording is not in the vault',
			args: { path: 'gone.webm', at: '1' },
			refusal: 'No file at "gone.webm" in this vault.',
		},
	])('refuses when $name', async ({ args, refusal }) => {
		await expect(createSut().resolve(args)).resolves.toEqual({ refusal });
	});

	it('names the recordings to pick from without offering all', async () => {
		// The position commands take no all: told to add it, a script would
		// only be refused again.
		const sut = recordingVault({
			recordings: [LECTURE, 'Recordings/qa.webm'],
			notes: { [NOTES]: [LECTURE, 'Recordings/qa.webm'] },
		});
		const family = positionActionFamily(sut.services, () => null);

		await expect(
			Promise.resolve(family.cliTarget.resolve({ path: NOTES, at: '1' })),
		).resolves.toEqual({
			refusal: `${NOTES} links 2 recordings: ${LECTURE}, Recordings/qa.webm. Name one with recording=<name>.`,
		});
	});

	it('refuses a note of several recordings asked for all of them', async () => {
		const sut = recordingVault({
			recordings: [LECTURE, 'Recordings/qa.webm'],
			notes: { [NOTES]: [LECTURE, 'Recordings/qa.webm'] },
		});
		const family = positionActionFamily(sut.services, () => null);

		await expect(
			Promise.resolve(
				family.cliTarget.resolve({ path: NOTES, at: '1', all: 'true' }),
			),
		).resolves.toEqual({
			refusal:
				'A time belongs to one recording; name it with recording=<name>.',
		});
	});
});
