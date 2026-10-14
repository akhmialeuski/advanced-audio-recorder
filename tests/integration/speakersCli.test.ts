/**
 * Tests for renaming speakers from the command line: the roster listed when
 * no names are given, the names read from `map=` and checked against it, the
 * rename applied as the dialog applies it, a merge refused unless confirmed,
 * the participant profile the names grow, undo, and a recording that has no
 * roster to rename.
 *
 * The rewrite of the recorded outputs is stubbed: what it does to a note is
 * its own suite's subject; what it is asked to do is this one's.
 * @module tests/integration/speakersCli.test
 */

import type { CliData } from 'obsidian';
import { parseSpeakerMap, speakersFromCli } from 'src/actions/speakersCli';
import type { ActionServices, FileContext } from 'src/actions/PluginAction';
import {
	emptyTranscriptSection,
	type TranscriptSection,
} from 'src/sidecar/recordingSidecarModel';
import { applySpeakerRenamesWithSidecar } from 'src/speakers/applySpeakerRenames';
import { ProfileKindId, type Profile } from 'src/settings/profiles';
import { recordingVault } from '../helpers/recordingVault';
import { partial, silenceConsole } from '../helpers/doubles';
import {
	speakerSidecar,
	type SpeakerSidecarDouble,
} from '../helpers/speakerSidecar';

jest.mock('src/speakers/applySpeakerRenames', () => ({
	applySpeakerRenamesWithSidecar: jest.fn(),
	hasUnscopableRecordedNote: jest.fn(() => false),
}));

const TAKE = 'Recordings/take.webm';

/** A roster to name the speakers from. */
const TEAM: Profile = {
	id: 'team-1',
	kind: ProfileKindId.Participants,
	name: 'Team',
	body: 'Ann',
};

/** What the rewrite touched: one note and one transcript file. */
const REWROTE = {
	updatedNotes: 1,
	updatedTranscriptFiles: 1,
	failed: 0,
	unscopableNotes: 0,
	alreadyCurrentNotes: 0,
	unmatchedNotes: 0,
	missingOutputs: 0,
};

/** A roster of one named and one unnamed speaker. */
function roster(overrides: Partial<TranscriptSection> = {}): TranscriptSection {
	return {
		...emptyTranscriptSection(),
		speakers: [
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		],
		...overrides,
	};
}

/**
 * The recording, its sidecar holding the roster, and the command run on it.
 * @param section - The stored roster
 * @param corrupt - Whether the sidecar could not be read
 */
function createSut(
	section: TranscriptSection = roster(),
	corrupt = false,
): {
	sidecar: SpeakerSidecarDouble;
	saveSettings: jest.SpyInstance;
	team: () => Profile;
	run: (args?: CliData) => Promise<string>;
} {
	const vault = recordingVault({ recordings: [TAKE] });
	vault.settings.profiles = [...vault.settings.profiles, TEAM];
	const sidecar = speakerSidecar(section, corrupt);
	const context: FileContext = {
		file: vault.file(TAKE),
		services: {
			...vault.services,
			recordingSidecar:
				partial<ActionServices['recordingSidecar']>(sidecar),
		},
	};
	const saveSettings = jest.spyOn(vault.services, 'saveSettings');
	return {
		sidecar,
		saveSettings,
		team: () => {
			const found = vault.settings.profiles.find(
				(profile) => profile.id === TEAM.id,
			);
			if (!found) {
				throw new Error('The roster was removed');
			}
			return found;
		},
		run: (args = {}) => speakersFromCli(context, args),
	};
}

beforeEach(() => {
	jest.mocked(applySpeakerRenamesWithSidecar).mockReset();
	jest.mocked(applySpeakerRenamesWithSidecar).mockResolvedValue({
		...REWROTE,
	});
});

describe('listing the speakers', () => {
	it('lists each label and its name, and how to rename them', async () => {
		await expect(createSut().run()).resolves.toBe(
			[
				'Speaker 1: Alex',
				'Speaker 2: (no name)',
				'Rename with map="<label>=<name>; <label>=<name>".',
			].join('\n'),
		);
	});

	it('says no speakers are stored for a recording never diarized', async () => {
		await expect(createSut(emptyTranscriptSection()).run()).resolves.toBe(
			`No speakers are stored for ${TAKE}. Transcribe it with speaker diarization first.`,
		);
	});

	it('says the sidecar could not be read rather than that it is empty', async () => {
		silenceConsole('warn');

		await expect(createSut(roster(), true).run()).resolves.toMatch(
			/^The sidecar of Recordings\/take\.webm could not be read/,
		);
	});
});

describe('reading the names typed', () => {
	it.each([
		{ map: 'Speaker 2=Bea', names: [['Speaker 2', 'Bea']] },
		{
			map: ' Speaker 1 = Ann ; Speaker 2=Bea;',
			names: [
				['Speaker 1', 'Ann'],
				['Speaker 2', 'Bea'],
			],
		},
		{
			map: 'Speaker 1=Ann\nSpeaker 2=',
			names: [
				['Speaker 1', 'Ann'],
				['Speaker 2', ''],
			],
		},
	])('reads $map', ({ map, names }) => {
		expect(parseSpeakerMap(roster(), map)).toEqual(
			new Map(names as [string, string][]),
		);
	});

	it.each([
		{ map: 'Bea', refusal: '"Bea" is not <label>=<name>.' },
		{
			map: 'Speaker 3=Bea',
			refusal:
				'No speaker labelled "Speaker 3". The labels are: Speaker 1, Speaker 2.',
		},
		{
			map: 'Speaker 1=Ann;Speaker 1=Bea',
			refusal: '"Speaker 1" is named twice.',
		},
		{
			map: ' ; ',
			refusal: 'map= names no speaker. Use map="<label>=<name>".',
		},
	])('refuses $map', ({ map, refusal }) => {
		expect(parseSpeakerMap(roster(), map)).toBe(refusal);
	});

	it('writes nothing when the names are typed wrong', async () => {
		const sut = createSut();

		await expect(sut.run({ map: 'Speaker 9=Bea' })).resolves.toMatch(
			/^No speaker labelled "Speaker 9"/,
		);
		expect(applySpeakerRenamesWithSidecar).not.toHaveBeenCalled();
		expect(sut.sidecar.commitRename).not.toHaveBeenCalled();
	});
});

describe('renaming the speakers', () => {
	it('names the speakers typed and keeps the names of the rest', async () => {
		const sut = createSut();

		await expect(sut.run({ map: 'Speaker 2=Bea' })).resolves.toBe(
			'Renamed speakers in 1 note and 1 transcript file.',
		);
		expect(sut.sidecar.commitRename).toHaveBeenCalledWith(
			TAKE,
			[
				{ label: 'Speaker 1', name: 'Alex' },
				{ label: 'Speaker 2', name: 'Bea' },
			],
			{ 'Speaker 1': 'Alex', 'Speaker 2': 'Bea' },
			{ names: ['Alex', 'Bea'], profileId: '' },
		);
	});

	it('rewrites notes without timecodes only with broad', async () => {
		const sut = createSut();

		await sut.run({ map: 'Speaker 2=Bea', broad: 'true' });

		expect(applySpeakerRenamesWithSidecar).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			{ allowBroad: true },
		);
	});

	it('says how to reach the notes it left, by the flag', async () => {
		jest.mocked(applySpeakerRenamesWithSidecar).mockResolvedValue({
			...REWROTE,
			unscopableNotes: 1,
		});

		await expect(
			createSut().run({ map: 'Speaker 2=Bea' }),
		).resolves.toContain('add broad to rewrite them as well.');
	});

	it('says when there is nothing to change', async () => {
		const sut = createSut(
			roster({
				speakers: [{ label: 'Speaker 1' }, { label: 'Speaker 2' }],
			}),
		);

		await expect(sut.run({ map: 'Speaker 1=' })).resolves.toBe(
			'No speaker names to change.',
		);
		expect(sut.sidecar.commitRename).not.toHaveBeenCalled();
	});

	it("refuses a name that is another speaker's label", async () => {
		await expect(
			createSut().run({ map: 'Speaker 2=Speaker 1' }),
		).resolves.toMatch(/^A name cannot equal another speaker's label/);
	});
});

describe('giving two speakers one name', () => {
	it('refuses without merge, saying what would merge', async () => {
		const sut = createSut();

		await expect(sut.run({ map: 'Speaker 2=Alex' })).resolves.toBe(
			'Speaker 1, Speaker 2 become Alex. Merged speakers cannot be told apart again; add merge to do it anyway.',
		);
		expect(sut.sidecar.commitRename).not.toHaveBeenCalled();
	});

	it('merges with merge', async () => {
		const sut = createSut();

		await expect(
			sut.run({ map: 'Speaker 2=Alex', merge: 'true' }),
		).resolves.toBe('Renamed speakers in 1 note and 1 transcript file.');
		expect(sut.sidecar.commitRename).toHaveBeenCalledTimes(1);
	});
});

describe('the participant profile the names grow', () => {
	/**
	 * The participant profile the rename committed its names to.
	 * @param sut - The recording the rename ran on
	 * @returns The profile id, '' for none
	 */
	function profileNamesWentTo(sut: ReturnType<typeof createSut>): unknown {
		const commit = sut.sidecar.commitRename.mock.lastCall as
			| [string, unknown, unknown, { profileId: string }]
			| undefined;
		return commit?.[3].profileId;
	}

	it('is the one typed', async () => {
		const sut = createSut();

		await sut.run({ map: 'Speaker 2=Bea', profile: 'team' });

		expect(profileNamesWentTo(sut)).toBe(TEAM.id);
	});

	it('is the one the recording was transcribed with when none is typed', async () => {
		const sut = createSut(roster({ participantProfileId: TEAM.id }));

		await sut.run({ map: 'Speaker 2=Bea' });

		expect(profileNamesWentTo(sut)).toBe(TEAM.id);
	});

	it('is none when the one transcribed with is gone', async () => {
		const sut = createSut(roster({ participantProfileId: 'deleted' }));

		await sut.run({ map: 'Speaker 2=Bea' });

		expect(profileNamesWentTo(sut)).toBe('');
	});

	it('grows by nothing when every name is cleared', async () => {
		const sut = createSut();

		await sut.run({ map: 'Speaker 1=', profile: 'Team' });

		expect(sut.sidecar.commitRename).toHaveBeenCalledTimes(1);
		expect(sut.saveSettings).not.toHaveBeenCalled();
		expect(sut.team().body).toBe('Ann');
	});

	it('refuses one that does not exist, writing nothing', async () => {
		const sut = createSut();

		await expect(
			sut.run({ map: 'Speaker 2=Bea', profile: 'Board' }),
		).resolves.toBe(
			'No profile named "Board". The ones to choose from: none, Team.',
		);
		expect(applySpeakerRenamesWithSidecar).not.toHaveBeenCalled();
	});
});

describe('undoing the last rename', () => {
	it('steps the names back and consumes the history entry', async () => {
		const sut = createSut(
			roster({
				speakers: [
					{ label: 'Speaker 1', name: 'Alex' },
					{ label: 'Speaker 2', name: 'Bea' },
				],
				history: [
					{
						at: '2026-01-01T00:00:00Z',
						names: { 'Speaker 1': 'Alex' },
					},
					{
						at: '2026-01-02T00:00:00Z',
						names: { 'Speaker 1': 'Alex', 'Speaker 2': 'Bea' },
					},
				],
			}),
		);

		await expect(sut.run({ undo: 'true' })).resolves.toBe(
			'Renamed speakers in 1 note and 1 transcript file.',
		);
		expect(sut.sidecar.setSpeakers).toHaveBeenCalledWith(TAKE, [
			{ label: 'Speaker 1', name: 'Alex' },
			{ label: 'Speaker 2' },
		]);
		expect(sut.sidecar.popHistory).toHaveBeenCalledWith(TAKE);
	});

	it('takes undo over names typed alongside it', async () => {
		const sut = createSut();

		await sut.run({ undo: 'true', map: 'Speaker 2=Bea' });

		expect(sut.sidecar.commitRename).not.toHaveBeenCalled();
		expect(sut.sidecar.popHistory).toHaveBeenCalledTimes(1);
	});
});
