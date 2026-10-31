/**
 * Tests for transcription started from the command line: the parameters set
 * what the dialog's controls would, each checked before anything starts; the
 * run goes into the note named and no other, under a notice that shows its
 * progress and can cancel it; and with `wait` the answer says where the
 * transcript went.
 *
 * The run itself is stubbed: what it does with the request it is handed is
 * its own suite's subject, what it is handed is this one's.
 * @module tests/integration/transcribeCli.test
 */

import type { CliData } from 'obsidian';
import {
	describeTranscriptionOutcome,
	transcribeFromCli,
	transcriptionRun,
} from 'src/actions/file/transcribeCli';
import type { FileContext } from 'src/actions/file/FileContext';
import {
	ProfileKindId,
	selectedProfileId,
	type Profile,
} from 'src/settings/profiles';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import type {
	RecordingTranscriptionRequest,
	TranscriptionRunOutcome,
} from 'src/transcription/api';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { recordingVault } from '../helpers/recordingVault';
import { valueOrThrow } from 'src/utils/refusal';
import { at } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';
import { noticeInstances, noticeMessages, noticeText } from '../mocks/obsidian';

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

/** The run a command asked for, the only time it asked. */
function runAskedFor(sut: {
	services: { transcriber: { transcribe: unknown } };
}): RecordingTranscriptionRequest {
	const transcribe = jest.mocked(
		sut.services.transcriber.transcribe as (
			request: RecordingTranscriptionRequest,
		) => Promise<TranscriptionRunOutcome>,
	);
	expect(transcribe).toHaveBeenCalledTimes(1);
	return at(transcribe.mock.calls, 0)[0];
}

/**
 * Ends every run the command starts the way a case says.
 * @param sut - The vault whose run is scripted
 * @param outcome - How the run ends, or how to end it from its request
 */
function runEnds(
	sut: { services: { transcriber: { transcribe: unknown } } },
	outcome:
		| TranscriptionRunOutcome
		| ((
				request: RecordingTranscriptionRequest,
		  ) => Promise<TranscriptionRunOutcome>),
): void {
	jest.mocked(
		sut.services.transcriber.transcribe as (
			request: RecordingTranscriptionRequest,
		) => Promise<TranscriptionRunOutcome>,
	).mockImplementation((request) =>
		typeof outcome === 'function'
			? outcome(request)
			: Promise.resolve(outcome),
	);
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
	it('starts the run typed in Obsidian, with no dialog', async () => {
		const sut = createSut();

		await expect(
			transcribeFromCli(sut.context, { language: 'de' }),
		).resolves.toBe(`Started transcribing ${TAKE} in Obsidian.`);

		const request = runAskedFor(sut);
		expect(request.file).toBe(sut.file(TAKE));
		expect(request.settings.transcriptionLanguage).toBe('de');
		// Nothing measured the recording, so nothing is guessed from it.
		expect(request.durationSeconds()).toBeNull();
	});

	it('writes into the note the recording was reached through', async () => {
		const sut = createSut({ throughNote: true });

		await transcribeFromCli(sut.context, {});

		expect(runAskedFor(sut).notePath).toBe(MEETING);
	});

	it('writes into no note when none was named', async () => {
		const sut = createSut();

		await transcribeFromCli(sut.context, {});

		expect(runAskedFor(sut).notePath).toBe('');
	});

	it('runs with the profile it picked', async () => {
		const sut = createSut();

		await transcribeFromCli(sut.context, { participants: 'Team' });

		expect(
			selectedProfileId(
				runAskedFor(sut).settings,
				ProfileKindId.Participants,
			),
		).toBe(TEAM.id);
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

	it('starts nothing for a value typed wrong', async () => {
		const sut = createSut();

		await expect(
			transcribeFromCli(sut.context, {
				participants: 'Team',
				words: 'some',
			}),
		).resolves.toBe('words=some is not on or off.');
		expect(sut.services.transcriber.transcribe).toHaveBeenCalledTimes(0);
		expect(sut.saveSettings).not.toHaveBeenCalled();
	});

	it('starts nothing for a run that would be refused, and says why', async () => {
		const sut = createSut({ settings: { whisperApiKey: '' } });

		await expect(transcribeFromCli(sut.context, {})).resolves.toMatch(
			/API key/,
		);
		expect(sut.services.transcriber.transcribe).toHaveBeenCalledTimes(0);
	});

	it('is refused for a choice that makes the run impossible', async () => {
		const sut = createSut();

		await expect(
			transcribeFromCli(sut.context, {
				engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			}),
		).resolves.toMatch(/Deepgram/);
		expect(sut.services.transcriber.transcribe).toHaveBeenCalledTimes(0);
	});

	it('answers once the run is over with wait', async () => {
		const sut = createSut({ throughNote: true });
		runEnds(sut, {
			status: 'done',
			destination: 'note',
			notePath: MEETING,
			missingParts: 0,
			usd: null,
			sessionTotalUsd: 0,
		});

		await expect(
			transcribeFromCli(sut.context, { wait: 'true' }),
		).resolves.toBe(`Transcribed ${TAKE} into ${MEETING}.`);
	});

	// The terminal cannot interrupt a command, so the app is where a run is
	// watched and stopped, as a conversion or a split started there is.
	it('shows the run in a notice whose Cancel stops it', async () => {
		const sut = createSut();
		runEnds(sut, (request) => {
			request.onProgress?.(0.4, 'Transcribing part 2 of 5...');
			return new Promise((resolve) => {
				request.token?.signal?.addEventListener('abort', () => {
					resolve({ status: 'cancelled' });
				});
			});
		});
		const settled = transcribeFromCli(sut.context, { wait: 'true' });
		await tick();

		const notice = at(noticeInstances, 0);
		expect(noticeText(notice)).toBe(
			'Transcribing "take.webm": Transcribing part 2 of 5... 40% Cancel',
		);
		el(
			notice.initialMessage as DocumentFragment,
			MODAL.noticeAction,
		).click();

		await expect(settled).resolves.toBe(
			`Transcription of ${TAKE} was cancelled in Obsidian.`,
		);
		expect(notice.hide).toHaveBeenCalledTimes(1);
		expect(noticeMessages()).toContain('Transcription cancelled.');
	});

	it.each([
		{
			ending: 'what a finished run cost',
			outcome: {
				status: 'done',
				destination: 'file',
				notePath: '',
				missingParts: 0,
				usd: 0.05,
				sessionTotalUsd: 0.2,
			},
			said: 'Transcription cost ~$0.05 (session total ~$0.20).',
		},
		{
			ending: 'why a run failed',
			outcome: { status: 'failed', message: 'quota exceeded' },
			said: 'Transcription failed: quota exceeded',
		},
	] as const)(
		'tells whoever watches the app $ending',
		async ({ outcome, said }) => {
			const sut = createSut();
			runEnds(sut, outcome);

			await transcribeFromCli(sut.context, { wait: 'true' });

			expect(noticeMessages()).toContain(said);
		},
	);
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
		usd: null,
		sessionTotalUsd: 0,
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
