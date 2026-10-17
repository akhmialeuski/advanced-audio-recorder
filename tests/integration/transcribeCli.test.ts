/**
 * Tests for transcription started from the command line: the parameters set
 * what the dialog's controls would, each checked before anything opens; the
 * run opens in the dialog, writing into the note named and no other; and with
 * `wait` the answer says where the transcript went.
 *
 * The dialog itself is stubbed: what it does with the settings it is handed
 * is its own suite's subject, what it is handed is this one's.
 * @module tests/integration/transcribeCli.test
 */

import type { CliData } from 'obsidian';
import {
	describeTranscriptionOutcome,
	transcribeFromCli,
	transcriptionRun,
} from 'src/actions/transcribeCli';
import type { FileContext } from 'src/actions/PluginAction';
import {
	ProfileKindId,
	selectedProfileId,
	type Profile,
} from 'src/settings/profiles';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import {
	TranscriptionModal,
	type TranscriptionRunOutcome,
} from 'src/ui/TranscriptionModal';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { recordingVault } from '../helpers/recordingVault';
import { valueOrThrow } from 'src/utils/refusal';

jest.mock('src/ui/TranscriptionModal', () => ({
	TranscriptionModal: jest.fn(() => ({ open: jest.fn() })),
}));

const TAKE = 'Recordings/take.webm';
const MEETING = 'Meetings/standup.md';

/** A participant roster the run can be told to use by name. */
const TEAM: Profile = {
	id: 'team-1',
	kind: ProfileKindId.Participants,
	name: 'Team',
	body: 'Ann\nBob',
};

/** Settings a run could start on. */
const RUNNABLE: Partial<AudioRecorderSettings> = {
	transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	whisperApiKey: 'sk-test',
};

/**
 * The recording, reached through its meeting note or directly, with a
 * roster to pick.
 * @param options - Whether it was reached through the note, and settings
 */
function createSut(
	options: {
		throughNote?: boolean;
		settings?: Partial<AudioRecorderSettings>;
	} = {},
): ReturnType<typeof recordingVault> & {
	context: FileContext;
	saveSettings: jest.SpyInstance;
} {
	const vault = recordingVault({
		recordings: [TAKE],
		notes: { [MEETING]: [TAKE] },
		settings: { ...RUNNABLE, ...options.settings },
	});
	vault.settings.profiles = [...vault.settings.profiles, TEAM];
	const saveSettings = jest.spyOn(vault.services, 'saveSettings');
	return {
		...vault,
		saveSettings,
		context: vault.fileContext(
			TAKE,
			options.throughNote ? MEETING : undefined,
		),
	};
}

/** What the dialog was opened with, the last time it was. */
function dialogOpened(): {
	settings: () => AudioRecorderSettings;
	options: {
		autoStart?: boolean;
		notePath?: string;
		onRunSettled?: (outcome: TranscriptionRunOutcome) => void;
	};
} {
	const call = jest.mocked(TranscriptionModal).mock.lastCall;
	if (!call) {
		throw new Error('The dialog was not opened');
	}
	return {
		settings: call[2],
		options: call[3] as ReturnType<typeof dialogOpened>['options'],
	};
}

/**
 * The run the arguments make, read against the vault's settings.
 * @param args - What was typed
 */
function runOf(args: CliData): ReturnType<typeof transcriptionRun> {
	return transcriptionRun(createSut().settings, args);
}

/**
 * The settings a run applies over the vault's.
 * @param args - What was typed
 */
function applied(args: CliData): AudioRecorderSettings {
	const sut = createSut();
	return valueOrThrow(transcriptionRun(sut.settings, args)).apply(
		sut.settings,
	);
}

describe('the choices a command line makes for one run', () => {
	it('changes nothing when nothing is typed', () => {
		const sut = createSut();
		const run = valueOrThrow(transcriptionRun(sut.settings, {}));

		expect(run).toEqual({ apply: expect.any(Function), picks: [] });
		expect(run.apply(sut.settings)).toEqual(sut.settings);
	});

	it('sets each dropdown of the dialog', () => {
		expect(
			applied({
				engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				destination: 'both',
				format: 'srt',
				task: 'summary',
				language: 'de',
			}),
		).toEqual(
			expect.objectContaining({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				transcriptDestination: 'both',
				transcriptFileFormat: 'srt',
				llmPostProcessTask: 'summary',
				transcriptionLanguage: 'de',
			}),
		);
	});

	it.each([
		{ param: 'diarize', field: 'transcriptionDiarize' },
		{ param: 'words', field: 'transcriptionWordTimestamps' },
		{ param: 'advanced', field: 'transcriptionAdvancedSettingsEnabled' },
		{ param: 'twopass', field: 'transcriptionAdvancedEnabled' },
		{ param: 'timestamps', field: 'transcriptIncludeTimestamps' },
		{ param: 'speakers', field: 'transcriptIncludeSpeakers' },
		{ param: 'postprocess', field: 'llmPostProcessEnabled' },
		{ param: 'chapters', field: 'transcriptionAutoChaptersOnTranscribe' },
	] satisfies { param: string; field: keyof AudioRecorderSettings }[])(
		'turns $param on and off',
		({ param, field }) => {
			expect(applied({ [param]: 'on' })[field]).toBe(true);
			expect(applied({ [param]: 'off' })[field]).toBe(false);
		},
	);

	it('picks a profile by its name, whatever its case', () => {
		const sut = createSut();
		const run = valueOrThrow(
			transcriptionRun(sut.settings, { participants: 'team' }),
		);

		expect(run.picks).toEqual([
			{ kind: ProfileKindId.Participants, id: TEAM.id },
		]);
		expect(
			selectedProfileId(
				run.apply(sut.settings),
				ProfileKindId.Participants,
			),
		).toBe(TEAM.id);
	});

	it('picks no profile with none', () => {
		expect(runOf({ dictionary: 'none' })).toEqual({
			value: expect.objectContaining({
				picks: [{ kind: ProfileKindId.Dictionary, id: '' }],
			}),
		});
	});

	it('leaves the plugin settings as they are', () => {
		const sut = createSut();
		const run = valueOrThrow(
			transcriptionRun(sut.settings, {
				diarize: 'on',
				participants: 'Team',
			}),
		);

		run.apply(sut.settings);

		expect(sut.settings.transcriptionDiarize).toBe(false);
		expect(
			selectedProfileId(sut.settings, ProfileKindId.Participants),
		).not.toBe(TEAM.id);
	});

	it('lays its choices over the settings as they stand when read', () => {
		const sut = createSut();
		const run = valueOrThrow(
			transcriptionRun(sut.settings, { language: 'de' }),
		);

		const later = { ...sut.settings, whisperApiKey: 'sk-new' };

		expect(run.apply(later)).toEqual(
			expect.objectContaining({
				whisperApiKey: 'sk-new',
				transcriptionLanguage: 'de',
			}),
		);
	});

	it.each([
		{
			args: { engine: 'siri' },
			refusal: /^engine=siri is not one of: whisper-api, /,
		},
		{
			args: { destination: 'clipboard' },
			refusal:
				/^destination=clipboard is not one of: note, file, both, link\.$/,
		},
		{
			args: { diarize: 'maybe' },
			refusal: /^diarize=maybe is not on or off\.$/,
		},
		{
			args: { participants: 'Board' },
			refusal:
				/^No profile named "Board"\. The ones to choose from: none, Team\.$/,
		},
	])('refuses $args', ({ args, refusal }) => {
		expect(runOf(args)).toEqual({
			refusal: expect.stringMatching(refusal),
		});
	});
});

describe('starting a transcription from the command line', () => {
	beforeEach(() => {
		jest.mocked(TranscriptionModal).mockClear();
	});

	it('opens the dialog running at once, on the run typed', async () => {
		const sut = createSut();

		await expect(
			transcribeFromCli(sut.context, { language: 'de' }),
		).resolves.toBe(`Started transcribing ${TAKE} in Obsidian.`);

		const { settings, options } = dialogOpened();
		expect(jest.mocked(TranscriptionModal).mock.lastCall?.[1]).toBe(
			sut.file(TAKE),
		);
		expect(options.autoStart).toBe(true);
		expect(settings().transcriptionLanguage).toBe('de');
	});

	it('writes into the note the recording was reached through', async () => {
		await transcribeFromCli(createSut({ throughNote: true }).context, {});

		expect(dialogOpened().options.notePath).toBe(MEETING);
	});

	it('writes into no note when none was named', async () => {
		await transcribeFromCli(createSut().context, {});

		expect(dialogOpened().options.notePath).toBe('');
	});

	it('hands the dialog the settings as they stand when it reads them', async () => {
		const sut = createSut();
		await transcribeFromCli(sut.context, {});

		sut.settings.whisperApiKey = 'sk-rotated';

		expect(dialogOpened().settings().whisperApiKey).toBe('sk-rotated');
	});

	it('keeps a profile picked as the next default, as the dialog does', async () => {
		const sut = createSut();

		await transcribeFromCli(sut.context, { participants: 'Team' });

		expect(
			selectedProfileId(sut.settings, ProfileKindId.Participants),
		).toBe(TEAM.id);
		expect(sut.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('saves nothing when no profile was picked', async () => {
		const sut = createSut();

		await transcribeFromCli(sut.context, { diarize: 'on' });

		expect(sut.saveSettings).not.toHaveBeenCalled();
	});

	it('opens nothing for a value typed wrong', async () => {
		const sut = createSut();

		await expect(
			transcribeFromCli(sut.context, {
				participants: 'Team',
				words: 'some',
			}),
		).resolves.toBe('words=some is not on or off.');
		expect(TranscriptionModal).not.toHaveBeenCalled();
		expect(sut.saveSettings).not.toHaveBeenCalled();
	});

	it('opens nothing for a run that would be refused, and says why', async () => {
		await expect(
			transcribeFromCli(
				createSut({ settings: { whisperApiKey: '' } }).context,
				{},
			),
		).resolves.toMatch(/API key/);
		expect(TranscriptionModal).not.toHaveBeenCalled();
	});

	it('is refused for a choice that makes the run impossible', async () => {
		await expect(
			transcribeFromCli(createSut().context, {
				engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			}),
		).resolves.toMatch(/Deepgram/);
		expect(TranscriptionModal).not.toHaveBeenCalled();
	});

	it('answers once the run is over with wait', async () => {
		const answer = transcribeFromCli(
			createSut({ throughNote: true }).context,
			{ wait: 'true' },
		);
		await Promise.resolve();

		dialogOpened().options.onRunSettled?.({
			status: 'done',
			destination: 'note',
			notePath: MEETING,
			missingParts: 0,
		});

		await expect(answer).resolves.toBe(
			`Transcribed ${TAKE} into ${MEETING}.`,
		);
	});

	it('answers that the run was cancelled with wait', async () => {
		const answer = transcribeFromCli(createSut().context, { wait: 'true' });
		await Promise.resolve();

		dialogOpened().options.onRunSettled?.({ status: 'cancelled' });

		await expect(answer).resolves.toBe(
			`Transcription of ${TAKE} was cancelled in Obsidian.`,
		);
	});
});

describe('where a finished run says the transcript went', () => {
	/** A finished run into the given place. */
	const done = (
		destination: 'note' | 'file' | 'both' | 'link',
		notePath: string,
		missingParts = 0,
	): TranscriptionRunOutcome => ({
		status: 'done',
		destination,
		notePath,
		missingParts,
	});

	it.each([
		{ outcome: done('note', MEETING), into: MEETING },
		{
			outcome: done('both', MEETING),
			into: `${MEETING} and a transcript file next to the recording`,
		},
		{
			outcome: done('link', MEETING),
			into: `a transcript file next to the recording, linked from ${MEETING}`,
		},
		{
			outcome: done('file', MEETING),
			into: 'a transcript file next to the recording',
		},
		{
			outcome: done('note', ''),
			into: 'a transcript file next to the recording',
		},
	])('names $into', ({ outcome, into }) => {
		expect(describeTranscriptionOutcome(TAKE, outcome)).toBe(
			`Transcribed ${TAKE} into ${into}.`,
		);
	});

	it.each([
		{ missing: 1, said: '1 part failed' },
		{ missing: 3, said: '3 parts failed' },
	])(
		'counts the parts the engine left out: $missing',
		({ missing, said }) => {
			expect(
				describeTranscriptionOutcome(TAKE, done('file', '', missing)),
			).toBe(
				`Transcribed ${TAKE} into a transcript file next to the recording. ${said} and can be transcribed again with retry-failed.`,
			);
		},
	);

	it('repeats why a run failed', () => {
		expect(
			describeTranscriptionOutcome(TAKE, {
				status: 'failed',
				message: 'The API key was rejected.',
			}),
		).toBe(`Transcription of ${TAKE} failed: The API key was rejected.`);
	});
});
