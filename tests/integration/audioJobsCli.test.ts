/**
 * Tests for the audio jobs as the command line runs them: what each takes as
 * parameters in place of its dialog, what it defaults to (the settings, as the
 * dialog does), what it hands the service, and what it answers - including
 * what the service told the user along the way.
 *
 * The services decode and encode audio, which jsdom cannot, so their one
 * entry point is stubbed; everything around it runs for real.
 * @module tests/integration/audioJobsCli.test
 */

import type { CliData } from 'obsidian';
import {
	cleanupFromCli,
	convertFromCli,
	infoFromCli,
	splitFromCli,
} from 'src/actions/file/audioJobsCli';
import type { FileContext } from 'src/actions/file/FileContext';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { ConversionService } from 'src/recording/ConversionService';
import { SplitService } from 'src/recording/SplitService';
import { AudioProcessingService } from 'src/cleanup/AudioProcessingService';
import * as AudioFileAnalyzer from 'src/utils/AudioFileAnalyzer';
import type { Notify } from 'src/utils/notify';
import { recordingVault } from '../helpers/recordingVault';
import { at } from '../helpers/assertions';
import type { CancellationToken } from 'src/utils/cancellation';
import { noticeInstances, noticeText } from '../mocks/obsidian';
import { el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';
import { tick } from '../helpers/async';

jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	// The device's encoders, which jsdom has none of: every format but AAC.
	isOfflineEncodingSupported: jest.fn((format: string) => format !== 'aac'),
}));

const TAKE = 'Recordings/take.webm';
const MEETING = 'Meetings/standup.md';

/** The recording reached through its meeting note, or directly. */
function createSut(
	options: { throughNote?: boolean; settings?: Record<string, unknown> } = {},
): ReturnType<typeof recordingVault> & { context: FileContext } {
	const vault = recordingVault({
		recordings: [TAKE],
		notes: { [MEETING]: [TAKE] },
		settings: options.settings ?? {},
	});
	return {
		...vault,
		context: vault.fileContext(
			TAKE,
			options.throughNote ? MEETING : undefined,
		),
	};
}

/** The reporter a stubbed service was constructed with. */
const reporterOf = (service: unknown): Notify =>
	(service as { notify: Notify }).notify;

describe('reporting the properties of a recording', () => {
	const info = {
		fileName: 'take.webm',
		fileSize: '4.2 MB',
		duration: '12:34',
		containerFormat: 'audio/webm',
		audioCodec: 'opus',
		bitrate: '128 kbps',
		sampleRate: '48000 Hz',
		channels: '2 (Stereo)',
	};

	it('answers with the list the dialog copies', async () => {
		jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
			info,
		);

		await expect(infoFromCli(createSut().context, {})).resolves.toBe(
			AudioFileAnalyzer.formatAudioFileInfo(info),
		);
	});

	it('answers with the fields as JSON', async () => {
		jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
			info,
		);

		await expect(
			infoFromCli(createSut().context, { format: 'json' }).then(
				JSON.parse,
			),
		).resolves.toEqual(info);
	});

	it('says the recording could not be read', async () => {
		jest.spyOn(AudioFileAnalyzer, 'getAudioFileInfo').mockResolvedValue(
			null,
		);

		await expect(infoFromCli(createSut().context, {})).resolves.toBe(
			`Could not read ${TAKE}: it is empty, damaged, or in a container this app cannot read.`,
		);
	});

	it('refuses a format it does not answer in', async () => {
		await expect(
			infoFromCli(createSut().context, { format: 'xml' }),
		).resolves.toBe('format=xml is not one of: md, json.');
	});
});

describe('converting a recording', () => {
	/** Runs a conversion whose service answers as given. */
	async function convert(
		args: CliData,
		outcome: Awaited<ReturnType<ConversionService['convert']>> = {
			status: 'completed',
			newFileName: 'take.mp3',
			newPath: 'Recordings/take.mp3',
		},
		said: string[] = [],
	): Promise<{
		answer: string;
		convert: jest.SpyInstance;
		sut: ReturnType<typeof createSut>;
	}> {
		const sut = createSut();
		jest.spyOn(sut.services, 'primeForEnhancement');
		const spy = jest
			.spyOn(ConversionService.prototype, 'convert')
			.mockImplementation(function (
				this: ConversionService,
				_request,
				onProgress,
			) {
				onProgress('Encoding 50%');
				said.forEach(reporterOf(this));
				return Promise.resolve(outcome);
			});
		const answer = await convertFromCli(sut.context, args);
		return { answer, convert: spy, sut };
	}

	it('hands the service the format typed and the settings for the rest', async () => {
		const { convert: spy, sut } = await convert({ to: 'MP3' });

		expect(spy).toHaveBeenCalledWith(
			{
				sourceFile: sut.file(TAKE),
				targetFormat: 'mp3',
				bitrate: 128000,
				channelMode: 'source',
				deleteSource: false,
				linkAction: 'replace',
			},
			expect.any(Function),
			// The notice's Cancel, which is how a command is stopped.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('takes every choice the dialog offers', async () => {
		const { convert: spy } = await convert({
			to: 'ogg',
			channels: 'mono-left',
			bitrate: '64',
			source: 'delete',
			links: 'after',
		});

		expect(at(spy.mock.calls, 0)[0]).toEqual(
			expect.objectContaining({
				channelMode: 'mono-left',
				bitrate: 64000,
				deleteSource: true,
				linkAction: 'after',
			}),
		);
	});

	it('answers with the new file and primes it for the player', async () => {
		const { answer, sut } = await convert({ to: 'mp3' });

		expect(answer).toBe(`Converted ${TAKE} to Recordings/take.mp3.`);
		expect(sut.services.primeForEnhancement).toHaveBeenCalledWith([
			'Recordings/take.mp3',
		]);
	});

	it('repeats what the service said along the way', async () => {
		const { answer } = await convert({ to: 'mp3' }, { status: 'aborted' }, [
			'File "take.mp3" already exists.',
		]);

		expect(answer).toBe(
			`Did not convert ${TAKE}.\nFile "take.mp3" already exists.`,
		);
	});

	it('says a conversion finished only in part', async () => {
		const { answer } = await convert({ to: 'mp3' }, { status: 'partial' }, [
			'Updating links failed.',
		]);

		expect(answer).toBe(
			`Converted ${TAKE}, but not every step after it finished.\nUpdating links failed.`,
		);
	});

	it('offers the source format for a mono downmix', async () => {
		const { convert: spy } = await convert({
			to: 'webm',
			channels: 'mono-mix',
		});

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: 'no format is named',
			args: {},
			said: 'Name the format with to=<format>. Formats offered: wav, ogg, mp3, mp4, m4a, flac.',
		},
		{
			name: 'the format is its own, keeping its channels',
			args: { to: 'webm' },
			said: `${TAKE} cannot be converted to webm here. Formats offered: wav, ogg, mp3, mp4, m4a, flac.`,
		},
		{
			name: 'this device cannot encode it',
			args: { to: 'aac' },
			said: `${TAKE} cannot be converted to aac here. Formats offered: wav, ogg, mp3, mp4, m4a, flac.`,
		},
		{
			name: 'the channels are none it offers',
			args: { to: 'mp3', channels: 'surround' },
			said: 'channels=surround is not one of: source, mono-mix, mono-left, mono-right.',
		},
		{
			name: 'the bitrate is not a number',
			args: { to: 'mp3', bitrate: 'high' },
			said: 'bitrate=high is not a number from 1 to 2000.',
		},
		{
			name: 'the source choice is neither',
			args: { to: 'mp3', source: 'archive' },
			said: 'source=archive is not one of: keep, delete.',
		},
		{
			name: 'the links choice is none',
			args: { to: 'mp3', links: 'all' },
			said: 'links=all is not one of: none, replace, after.',
		},
	])('refuses when $name', async ({ args, said }) => {
		const { answer, convert: spy } = await convert(args);

		expect(answer).toBe(said);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('splitting a recording', () => {
	/** Runs a split whose service answers as given. */
	async function split(
		args: CliData,
		options: {
			outcome?: Awaited<ReturnType<SplitService['split']>>;
			said?: string[];
			chapters?: boolean;
			settings?: Partial<AudioRecorderSettings>;
		} = {},
	): Promise<{ answer: string; split: jest.SpyInstance }> {
		const sut = createSut({
			settings: { splitChunkMinutes: 20, ...options.settings },
		});
		if (options.chapters) {
			jest.mocked(
				sut.services.recordingSidecar.getMarkers,
			).mockResolvedValue([
				{ id: 'c1', time: 0, label: 'Intro', kind: 'chapter' },
				{ id: 'b1', time: 30, label: 'Note', kind: 'bookmark' },
				{ id: 'c2', time: 60, label: 'Budget', kind: 'chapter' },
			]);
		}
		const spy = jest
			.spyOn(SplitService.prototype, 'split')
			.mockImplementation(function (
				this: SplitService,
				_request,
				onProgress,
			) {
				onProgress('Writing part 1');
				(options.said ?? []).forEach(reporterOf(this));
				return Promise.resolve(
					options.outcome ?? {
						status: 'completed',
						partCount: 3,
						firstPartName: 'take-part1.webm',
					},
				);
			});
		return { answer: await splitFromCli(sut.context, args), split: spy };
	}

	it('cuts every few minutes, as the settings say', async () => {
		const { answer, split: spy } = await split({});

		expect(answer).toBe(
			`Split ${TAKE} into 3 parts, the first take-part1.webm.`,
		);
		expect(at(spy.mock.calls, 0)[0]).toEqual(
			expect.objectContaining({
				partSeconds: 1200,
				suffix: 'part',
				deleteSource: false,
				linkAction: 'replace',
			}),
		);
		expect(at(spy.mock.calls, 0)[0]).not.toHaveProperty('cuts');
	});

	it('takes the length, the suffix and the bitrate typed', async () => {
		const { split: spy } = await split({
			minutes: '5',
			suffix: 'seg',
			bitrate: '96',
		});

		expect(at(spy.mock.calls, 0)[0]).toEqual(
			expect.objectContaining({
				partSeconds: 300,
				suffix: 'seg',
				bitrate: 96000,
			}),
		);
	});

	it.each([
		{ name: 'the one the settings name', setting: 'clip', suffix: 'clip' },
		// A setting the dialog would not start on is the default here too,
		// rather than a refusal of a suffix nobody typed.
		{
			name: 'the default for a blank setting',
			setting: '  ',
			suffix: 'part',
		},
		{
			name: 'the default for a setting no file name can carry',
			setting: 'part 1',
			suffix: 'part',
		},
	])('names the parts with $name', async ({ setting, suffix }) => {
		const { split: spy } = await split(
			{},
			{ settings: { splitPartSuffix: setting } },
		);

		expect(at(spy.mock.calls, 0)[0]).toEqual(
			expect.objectContaining({ suffix }),
		);
	});

	it('cuts at the chapters, and only at the chapters', async () => {
		const { split: spy } = await split(
			{ by: 'chapters' },
			{ chapters: true },
		);

		expect(at(spy.mock.calls, 0)[0]).toEqual(
			expect.objectContaining({
				cuts: [
					{ startSeconds: 0, title: 'Intro' },
					{ startSeconds: 60, title: 'Budget' },
				],
			}),
		);
	});

	it('refuses to cut at chapters a recording does not have', async () => {
		const { answer, split: spy } = await split({ by: 'chapters' });

		expect(answer).toBe(`${TAKE} has no chapters to cut at.`);
		expect(spy).not.toHaveBeenCalled();
	});

	it.each([
		{
			outcome: { status: 'aborted' } as const,
			said: `Did not split ${TAKE}.`,
		},
		{
			outcome: { status: 'partial' } as const,
			said: `Split ${TAKE}, but not every step after it finished.`,
		},
	])(
		'says how a $outcome.status split ended, and why',
		async ({ outcome, said }) => {
			const { answer } = await split(
				{},
				{ outcome, said: ['File is shorter than one part.'] },
			);

			expect(answer).toBe(`${said}\nFile is shorter than one part.`);
		},
	);

	it.each([
		{
			args: { by: 'size' },
			said: 'by=size is not one of: duration, chapters.',
		},
		{
			args: { minutes: '0' },
			said: 'minutes=0 is not a whole number from 1 to 180.',
		},
		{
			args: { source: 'move' },
			said: 'source=move is not one of: keep, delete.',
		},
		{
			args: { links: 'some' },
			said: 'links=some is not one of: none, replace, after.',
		},
		{
			args: { bitrate: '-1' },
			said: 'bitrate=-1 is not a number from 1 to 2000.',
		},
	])('refuses $args', async ({ args, said }) => {
		await expect(split(args).then((run) => run.answer)).resolves.toBe(said);
	});

	it('refuses a suffix a file name cannot carry', async () => {
		const { answer } = await split({ suffix: 'part 1' });

		expect(answer).toMatch(/^Part suffix /);
	});
});

describe('cancelling a job started from the command line', () => {
	/**
	 * A service step that reports one line of progress and then runs until
	 * the command's cancellation fires, answering as a cancelled job does.
	 */
	function runsUntilCancelled(
		_request: unknown,
		onProgress: (text: string) => void,
		token?: CancellationToken,
	): Promise<{ status: 'cancelled' }> {
		onProgress('Writing part 1 of 3...');
		return new Promise((resolve) => {
			token?.signal?.addEventListener('abort', () => {
				resolve({ status: 'cancelled' });
			});
		});
	}

	it.each([
		{
			job: 'conversion',
			run: (context: FileContext): Promise<string> => {
				jest.spyOn(
					ConversionService.prototype,
					'convert',
				).mockImplementation(runsUntilCancelled);
				return convertFromCli(context, { to: 'mp3' });
			},
			title: 'Converting "take.webm"',
			answer: `Conversion of ${TAKE} was cancelled in Obsidian.`,
		},
		{
			job: 'split',
			run: (context: FileContext): Promise<string> => {
				jest.spyOn(SplitService.prototype, 'split').mockImplementation(
					runsUntilCancelled,
				);
				return splitFromCli(context, {});
			},
			title: 'Splitting "take.webm"',
			answer: `Split of ${TAKE} was cancelled in Obsidian.`,
		},
	])(
		'shows the $job in a notice whose Cancel stops it and answers so',
		async ({ run, title, answer }) => {
			const settled = run(createSut().context);
			await tick();

			// The progress the terminal cannot show, in the app
			const notice = at(noticeInstances, 0);
			expect(noticeText(notice)).toBe(
				`${title}: Writing part 1 of 3... Cancel`,
			);
			expect(notice.timeout).toBe(0);

			el(
				notice.initialMessage as DocumentFragment,
				MODAL.noticeAction,
			).click();

			await expect(settled).resolves.toBe(answer);
			expect(notice.hide).toHaveBeenCalled();
		},
	);
});

describe('cleaning up a recording', () => {
	const OUTPUT = 'Recordings/take-processed.wav';

	/** Runs a cleanup whose processing writes the copy. */
	async function cleanup(
		args: CliData,
		throughNote = false,
	): Promise<{
		answer: string;
		process: jest.SpyInstance;
		sut: ReturnType<typeof createSut>;
	}> {
		const sut = createSut({ throughNote });
		const process = jest
			.spyOn(AudioProcessingService.prototype, 'process')
			.mockImplementation(async () => {
				await sut.app.vault.createBinary(OUTPUT, new ArrayBuffer(4));
				return OUTPUT;
			});
		const answer = await cleanupFromCli(sut.context, args);
		return { answer, process, sut };
	}

	it('applies the stages the settings switch on', async () => {
		const { answer, process } = await cleanup({});

		expect(answer).toBe(`Processed audio saved to ${OUTPUT}`);
		expect(at(process.mock.calls, 0)[1]).toEqual(
			expect.objectContaining({
				highPass: { enabled: true, hz: 80 },
				gate: expect.objectContaining({ enabled: false }),
				channelMode: 'source',
			}),
		);
	});

	it('switches a stage on at the value typed, and one off', async () => {
		const { process } = await cleanup({
			highpass: 'off',
			gate: '-40',
			level: 'on',
		});

		expect(at(process.mock.calls, 0)[1]).toEqual(
			expect.objectContaining({
				highPass: { enabled: false, hz: 80 },
				gate: { enabled: true, thresholdDb: -40 },
				leveling: { enabled: true, makeupDb: 6 },
			}),
		);
	});

	it('links the copy into the note the recording was reached through', async () => {
		const { sut } = await cleanup({}, true);

		await expect(sut.app.vault.read(sut.file(MEETING))).resolves.toContain(
			'![[take-processed.wav]]',
		);
	});

	it('touches no note when none was named', async () => {
		const { sut } = await cleanup({});

		await expect(
			sut.app.vault.read(sut.file(MEETING)),
		).resolves.not.toContain('take-processed');
	});

	it('replaces the source with its copy in the note, then trashes it', async () => {
		const { sut } = await cleanup({ source: 'delete' }, true);

		const note = await sut.app.vault.read(sut.file(MEETING));
		expect(note).toContain('![[take-processed.wav]]');
		expect(note).not.toContain('![[take.webm]]');
		expect(sut.app.fileManager.trashFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: TAKE }),
		);
	});

	it('trashes no source the note only links, with no embed to replace', async () => {
		const vault = recordingVault({
			recordings: [TAKE],
			notes: { [MEETING]: '[[take.webm#t=90|1:30]] **Ann** Budget.' },
		});
		const process = jest.spyOn(AudioProcessingService.prototype, 'process');

		await expect(
			cleanupFromCli(vault.fileContext(TAKE, MEETING), {
				source: 'delete',
			}),
		).resolves.toBe(
			`source=delete trashes ${TAKE} once its copy has replaced its embed in ${MEETING}, which embeds it nowhere. Keep the source with source=keep.`,
		);
		expect(process).not.toHaveBeenCalled();
	});

	it('trashes no source whose copy no note would link', async () => {
		const { answer, process } = await cleanup({ source: 'delete' });

		expect(answer).toBe(
			`source=delete trashes ${TAKE} once its copy is linked into its note: name the note with file=<note>, or note=<note> beside path=<recording>.`,
		);
		expect(process).not.toHaveBeenCalled();
	});

	it('refuses a run that would change nothing', async () => {
		const { answer, process } = await cleanup({ highpass: 'off' });

		expect(answer).toBe(
			'Every stage is off: switch one on (highpass, gate, level) or choose a mono channels option.',
		);
		expect(process).not.toHaveBeenCalled();
	});

	it('runs a mono downmix with every stage off', async () => {
		const { process } = await cleanup({
			highpass: 'off',
			channels: 'mono-mix',
		});

		expect(process).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			args: { highpass: '10' },
			said: 'highpass=10 is not a number from 20 to 300. Or on, or off.',
		},
		{
			args: { gate: '-90' },
			said: 'gate=-90 is not a number from -80 to -20. Or on, or off.',
		},
		{
			args: { level: '30' },
			said: 'level=30 is not a number from 0 to 24. Or on, or off.',
		},
		{
			args: { channels: 'quad' },
			said: 'channels=quad is not one of: source, mono-mix, mono-left, mono-right.',
		},
		{
			args: { source: 'move' },
			said: 'source=move is not one of: keep, delete.',
		},
	])('refuses $args', async ({ args, said }) => {
		await expect(cleanup(args).then((run) => run.answer)).resolves.toBe(
			said,
		);
	});
});
