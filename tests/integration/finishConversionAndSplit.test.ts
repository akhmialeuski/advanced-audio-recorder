/**
 * How a conversion and a split finish once their files are written: the
 * note that embeds the recording is pointed at the new files, and the
 * recording goes to the trash only when every link to it was rewritten.
 *
 * Both jobs share that rule, so every case runs both through the real
 * services, the real link rewrite and the real WAV paths, with only the
 * vault and its metadata cache faked.
 * @module tests/integration/finishConversionAndSplit.test
 */

import { App, TFile } from 'obsidian';
import { ConversionService } from 'src/recording/ConversionService';
import { SplitService } from 'src/recording/SplitService';
import { ChannelMode } from 'src/audio/downmix';
import { asMockApp } from '../helpers/obsidianMock';
import { defined } from '../helpers/assertions';
import { stereoWav } from '../helpers/pcmFixtures';
import { noticeMessages } from '../mocks/obsidian';

const RECORDING = 'Calls/call.wav';
const NOTE = 'Notes/call.md';
const EMBED = '![[call.wav]]';

/** What one job answered, reduced to whether it finished. */
type JobStatus = { status: string };

/** One of the two jobs that end by replacing their source. */
interface Job {
	name: string;
	run(app: App, recording: TFile): Promise<JobStatus>;
	/** What the embed reads once it points at the job's files. */
	rewrittenEmbed: string;
	/** The files the job leaves next to the recording. */
	outputs: string[];
}

const JOBS: Job[] = [
	{
		name: 'a conversion',
		run: (app, recording) =>
			new ConversionService(app).convert(
				{
					sourceFile: recording,
					targetFormat: 'wav',
					bitrate: 0,
					channelMode: ChannelMode.MonoMix,
					deleteSource: true,
					linkAction: 'replace',
				},
				() => undefined,
			),
		rewrittenEmbed: '![[call-mono.wav]]',
		outputs: ['Calls/call-mono.wav'],
	},
	{
		name: 'a split',
		run: (app, recording) =>
			new SplitService(app).split(
				{
					sourceFile: recording,
					partSeconds: 1,
					suffix: 'part',
					bitrate: 128000,
					deleteSource: true,
					linkAction: 'replace',
				},
				() => undefined,
			),
		// An embed alone on its line becomes one embed per line.
		rewrittenEmbed: [1, 2, 3]
			.map((part) => `![[call-part${String(part)}.wav]]`)
			.join('\n'),
		outputs: [1, 2, 3].map((part) => `Calls/call-part${String(part)}.wav`),
	},
];

/**
 * A vault holding a three-second recording and a note embedding it, with
 * the metadata cache describing that embed.
 * @param noteBody - What the note holds. The cache always records
 *   {@link EMBED} at its place in the note's first version, so a body that
 *   moved on stands for a cache that lags behind the file.
 */
function vaultWithEmbeddedRecording(noteBody: string): {
	app: App;
	recording: TFile;
} {
	const app = new App();
	const mock = asMockApp(app);
	mock.vault.seed([
		{ path: RECORDING, data: stereoWav(22050, 3) },
		{ path: NOTE, content: noteBody },
	]);
	const recording = defined(app.vault.getFileByPath(RECORDING));
	const start = `# Call\n\n`.length;
	mock.metadataCache.resolvedLinks = { [NOTE]: { [RECORDING]: 1 } };
	mock.metadataCache.getFileCache.mockImplementation(
		(file: { path: string }) =>
			file.path === NOTE
				? {
						embeds: [
							{
								link: 'call.wav',
								original: EMBED,
								position: {
									start: { line: 2, col: 0, offset: start },
									end: {
										line: 2,
										col: EMBED.length,
										offset: start + EMBED.length,
									},
								},
							},
						],
					}
				: null,
	);
	mock.metadataCache.getFirstLinkpathDest.mockImplementation(
		(linkpath: string) => (linkpath === 'call.wav' ? recording : null),
	);
	return { app, recording };
}

/**
 * Every path the vault holds now, sorted.
 * @param app - The app over the vault
 */
function pathsIn(app: App): string[] {
	return asMockApp(app)
		.vault.getFiles()
		.map((file) => file.path)
		.sort();
}

/**
 * What the note holds now.
 * @param app - The app over the vault
 */
function noteBody(app: App): Promise<string> {
	return app.vault.read(defined(app.vault.getFileByPath(NOTE)));
}

beforeEach(() => {
	// The link rewrite logs the reference it skips.
	jest.spyOn(console, 'warn').mockImplementation();
});

describe.each(JOBS)('$name that deletes its source', (job) => {
	it('points the note at its files and trashes the source', async () => {
		const { app, recording } = vaultWithEmbeddedRecording(
			`# Call\n\n${EMBED}\n`,
		);

		const outcome = await job.run(app, recording);

		expect(outcome.status).toBe('completed');
		expect(await noteBody(app)).toBe(`# Call\n\n${job.rewrittenEmbed}\n`);
		expect(
			asMockApp(app).fileManager.trashFile.mock.calls.map(
				([file]) => file.path,
			),
		).toEqual([RECORDING]);
		expect(pathsIn(app)).toEqual([...job.outputs, NOTE].sort());
		expect(noticeMessages()).toEqual([]);
	});

	it('keeps the source when a link to it could not be rewritten', async () => {
		// The note was edited after the cache recorded the embed, so the
		// rewrite skips it, and the source is the only thing it still opens.
		const staleBody = '# Call\n\n![[elsewhere.wav]]\n';
		const { app, recording } = vaultWithEmbeddedRecording(staleBody);

		const outcome = await job.run(app, recording);

		expect(outcome.status).toBe('completed');
		expect(await noteBody(app)).toBe(staleBody);
		expect(asMockApp(app).fileManager.trashFile).not.toHaveBeenCalled();
		expect(pathsIn(app)).toEqual([...job.outputs, RECORDING, NOTE].sort());
		expect(noticeMessages()).toEqual([
			'Source file kept: 1 link(s) could not be updated.',
		]);
	});
});
