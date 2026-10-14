/**
 * Tests for the actions on a folder of recordings: queueing every recording
 * in it for transcription from the folder's menu, the palette's picker, and
 * the command line, which names the folder as Obsidian's own commands do.
 * @module tests/integration/folderActions.test
 */

import type { CliData } from 'obsidian';
import { FOLDER_ACTIONS, folderActionFamily } from 'src/actions/folderActions';
import type { FolderContext } from 'src/actions/PluginAction';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { recordingVault } from '../helpers/recordingVault';
import { at } from '../helpers/assertions';

/** Settings a transcription could run on. */
const RUNNABLE = {
	transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	whisperApiKey: 'sk-test',
};

/**
 * A vault of recordings in two folders, and the folder family over it.
 * @param settings - Settings on top of transcription switched on
 */
function createSut(settings: Record<string, unknown> = RUNNABLE): ReturnType<
	typeof recordingVault
> & {
	family: ReturnType<typeof folderActionFamily>;
	resolve: (args: CliData) => Promise<readonly FolderContext[] | string>;
	execute: (args?: CliData) => Promise<string>;
} {
	const vault = recordingVault({
		recordings: [
			'Recordings/2026/standup.webm',
			'Recordings/retro.mp3',
			'Images/slide.png',
		],
		settings,
	});
	const family = folderActionFamily(vault.services);
	const resolve = (
		args: CliData,
	): Promise<readonly FolderContext[] | string> =>
		Promise.resolve(family.cliTarget.resolve(args));
	return {
		...vault,
		family,
		resolve,
		execute: async (args = {}) => {
			const targets = await resolve({ folder: 'Recordings', ...args });
			return Promise.resolve(
				at(FOLDER_ACTIONS, 0).cli.execute(
					at(targets as FolderContext[], 0),
					args,
				),
			);
		},
	};
}

describe('the folders the palette offers', () => {
	it('lists every folder holding a recording, the vault first', () => {
		const sut = createSut();

		expect(sut.family.activeTargets().map(sut.family.describe)).toEqual([
			'the whole vault',
			'Recordings',
			'Recordings/2026',
		]);
	});

	it('queues the folder picked', async () => {
		const sut = createSut();
		const recordings = at(sut.family.activeTargets(), 1);

		await at(FOLDER_ACTIONS, 0).run(recordings);

		expect(
			sut.services.transcriptionQueue.queueFolder,
		).toHaveBeenCalledWith(recordings.folder);
	});

	it.each([
		{ enabled: true, offered: true },
		{ enabled: false, offered: false },
	])(
		'is offered: $offered, with transcription on: $enabled',
		({ enabled, offered }) => {
			const sut = createSut({ transcriptionEnabled: enabled });

			expect(
				at(FOLDER_ACTIONS, 0).isAvailable(
					at(sut.family.activeTargets(), 0),
				),
			).toBe(offered);
		},
	);
});

describe('the folder a command line names', () => {
	it.each([
		{ folder: 'Recordings/2026', named: 'Recordings/2026' },
		{ folder: '/', named: 'the whole vault' },
	])('finds $folder', async ({ folder, named }) => {
		const sut = createSut();

		const [target] = (await sut.resolve({ folder })) as FolderContext[];

		expect(target && sut.family.describe(target)).toBe(named);
	});

	it.each([
		{
			name: 'none is named',
			args: {},
			refusal:
				'Name the folder with folder=<path>; folder=/ is the whole vault.',
		},
		{
			name: 'it is not in the vault',
			args: { folder: 'Archive' },
			refusal: 'No folder at "Archive" in this vault.',
		},
		{
			name: 'it is a file',
			args: { folder: 'Recordings/retro.mp3' },
			refusal: 'Recordings/retro.mp3 is a file, not a folder.',
		},
	])('refuses when $name', async ({ args, refusal }) => {
		await expect(createSut().resolve(args)).resolves.toBe(refusal);
	});
});

describe('queueing a folder from the command line', () => {
	it('says how many of its recordings were queued', async () => {
		const sut = createSut();
		sut.services.transcriptionQueue.enqueueFolder.mockResolvedValue({
			found: 2,
			added: 2,
		});

		await expect(sut.execute()).resolves.toBe(
			'Queued 2 of the 2 recordings in Recordings. Start the queue with the queue command and start, or add start here.',
		);
		expect(sut.services.transcriptionQueue.start).not.toHaveBeenCalled();
	});

	it('starts the queue with start', async () => {
		const sut = createSut();
		sut.services.transcriptionQueue.enqueueFolder.mockResolvedValue({
			found: 2,
			added: 1,
		});

		await expect(sut.execute({ start: 'true' })).resolves.toBe(
			'Queued 1 of the 2 recordings in Recordings. The queue is transcribing them in Obsidian.',
		);
		expect(sut.services.transcriptionQueue.start).toHaveBeenCalledTimes(1);
	});

	it('says every recording is queued already', async () => {
		const sut = createSut();
		sut.services.transcriptionQueue.enqueueFolder.mockResolvedValue({
			found: 2,
			added: 0,
		});

		await expect(sut.execute()).resolves.toMatch(
			/^Every recording in Recordings is already in the queue\./,
		);
	});

	it('says a folder holds no recordings', async () => {
		await expect(createSut().execute()).resolves.toBe(
			'Recordings holds no recordings to transcribe.',
		);
	});

	it('queues nothing a run would be refused on', async () => {
		const sut = createSut({ whisperApiKey: '' });

		await expect(sut.execute()).resolves.toContain('API key');
		expect(
			sut.services.transcriptionQueue.enqueueFolder,
		).not.toHaveBeenCalled();
	});

	it('says transcription is off where the action is not offered', () => {
		expect(
			at(FOLDER_ACTIONS, 0).cli.unavailable?.(
				at(createSut().family.activeTargets(), 0),
			),
		).toBe('Transcription is switched off in settings.');
	});
});
