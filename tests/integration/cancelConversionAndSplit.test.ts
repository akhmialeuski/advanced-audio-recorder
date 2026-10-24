/**
 * Cancelling a conversion and a split on every path the audio really takes:
 * the streaming conversion on the main thread, the same conversion in the
 * encoding worker, the WAV byte copy and the split that streams its decode.
 *
 * The services, the conversion ladder, the worker client and handler and the
 * real mediabunny run together, with only the vault faked. jsdom has neither
 * an AudioContext nor a Worker, so a cancel that was mistaken for a failure
 * would fall to the whole-file decode and fail there loudly: a cancelled
 * outcome with nothing said is one the cancel itself produced.
 * @module tests/integration/cancelConversionAndSplit.test
 */

import { App, TFile } from 'obsidian';
import { AudioSampleSource } from 'mediabunny';
import { ConversionService } from 'src/recording/ConversionService';
import { SplitService } from 'src/recording/SplitService';
import { EncodingWorkerClient } from 'src/audio/EncodingWorkerClient';
import {
	handleEncodingMessage,
	type WorkerRequest,
	type WorkerResponse,
} from 'src/audio/encodingWorker';
import { ChannelMode } from 'src/audio/downmix';
import { CancellationSource } from 'src/utils/cancellation';
import * as LinkUpdater from 'src/utils/LinkUpdater';
import { asMockApp } from '../helpers/obsidianMock';
import { defined } from '../helpers/assertions';
import { alawWav, stereoWav } from '../helpers/pcmFixtures';
import { noticeMessages } from '../mocks/obsidian';
import { waitFor } from '../helpers/async';

/**
 * Rate of the PCM fixtures, deliberately not the device's own. Thirty seconds
 * at it is long enough that mediabunny reports progress well before it is
 * done.
 */
const PCM_RATE = 22050;

/** The recording every case acts on. */
const RECORDING = 'Calls/call.wav';

/** The shared mock vault holding one recording, and the recording. */
interface SeededVault {
	app: App;
	recording: TFile;
}

/**
 * The vault the service writes into: the mock vault, which reads back what
 * it holds, refuses to create over a taken path, and removes what is
 * deleted or trashed.
 * @param bytes - The recording's bytes
 */
function vaultHolding(bytes: ArrayBuffer): SeededVault {
	const app = new App();
	asMockApp(app).vault.seed([{ path: RECORDING, data: bytes }]);
	return { app, recording: defined(app.vault.getFileByPath(RECORDING)) };
}

/**
 * Every path the vault holds now.
 * @param app - The app over the vault
 */
function pathsIn(app: App): string[] {
	return asMockApp(app)
		.vault.getFiles()
		.map((file) => file.path);
}

/**
 * Progress text that cancels the job the first time it matches.
 * @param cancellation - The job's cancellation
 * @param pattern - The progress that pulls it
 * @returns The progress handler, and every text it received
 */
function cancellingOn(
	cancellation: CancellationSource,
	pattern: RegExp,
): { onProgress: (text: string) => void; seen: string[] } {
	const seen: string[] = [];
	return {
		seen,
		onProgress: (text) => {
			seen.push(text);
			if (pattern.test(text)) {
				cancellation.cancel();
			}
		},
	};
}

/**
 * A Worker that runs the real worker handler in this thread, delivering each
 * message on a later task the way a real worker does, so the client, the
 * handler and the streaming conversion between them are all the real ones.
 */
class InProcessWorker {
	static readonly requests: WorkerRequest[] = [];
	static readonly responses: WorkerResponse[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;

	postMessage(request: WorkerRequest): void {
		InProcessWorker.requests.push(request);
		setTimeout(() => {
			void handleEncodingMessage(request, (response) => {
				InProcessWorker.responses.push(response);
				setTimeout(() => {
					this.onmessage?.(
						new MessageEvent('message', { data: response }),
					);
				}, 0);
			});
		}, 0);
	}

	terminate(): void {
		this.onmessage = null;
	}
}

/** The vault-wide link rewrite, watched to prove a cancel touches no note. */
let updateLinksInVault: jest.SpyInstance;

beforeEach(() => {
	jest.spyOn(console, 'warn').mockImplementation();
	updateLinksInVault = jest.spyOn(LinkUpdater, 'updateLinksInVault');
	InProcessWorker.requests.length = 0;
	InProcessWorker.responses.length = 0;
});

describe('cancelling a conversion', () => {
	const request = (
		sourceFile: TFile,
	): Parameters<ConversionService['convert']>[0] => ({
		sourceFile,
		targetFormat: 'wav',
		bitrate: 0,
		channelMode: ChannelMode.MonoMix,
		deleteSource: false,
		linkAction: 'replace',
	});

	it('stops the streaming conversion inside mediabunny and writes nothing', async () => {
		const { app, recording } = vaultHolding(stereoWav(PCM_RATE, 30));
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Converting\.\.\. \d+%$/);

		const outcome = await new ConversionService(app).convert(
			request(recording),
			progress.onProgress,
			cancellation.token,
		);

		expect(outcome).toEqual({ status: 'cancelled' });
		// One percentage arrived and the conversion ended there, rather than
		// running to its last packet and being thrown away after it.
		expect(progress.seen.filter((text) => text.endsWith('%'))).toHaveLength(
			1,
		);
		expect(progress.seen).not.toContain('Saving...');
		expect(pathsIn(app)).toEqual([RECORDING]);
		expect(updateLinksInVault).not.toHaveBeenCalled();
		expect(noticeMessages()).toEqual([]);
	});

	it('cancels the conversion in the worker and does not fall back to the main thread', async () => {
		(global as Record<string, unknown>).Worker = InProcessWorker;
		global.URL.createObjectURL = jest.fn().mockReturnValue('blob:worker');
		global.URL.revokeObjectURL = jest.fn();
		const worker = new EncodingWorkerClient('worker-source');
		const { app, recording } = vaultHolding(stereoWav(PCM_RATE, 30));
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Converting\.\.\. \d+%$/);

		const outcome = await new ConversionService(app, () => worker).convert(
			request(recording),
			progress.onProgress,
			cancellation.token,
		);
		// The worker answers the cancel on a later task, once mediabunny has
		// stopped its loop, with the error the client no longer waits for.
		await waitFor(
			() =>
				InProcessWorker.responses.some(
					(response) => response.kind === 'error',
				),
			{ message: 'the worker never stopped its conversion' },
		);

		expect(outcome).toEqual({ status: 'cancelled' });
		expect(InProcessWorker.requests.map((sent) => sent.kind)).toEqual([
			'convertBlob',
			'cancel',
		]);
		expect(
			InProcessWorker.responses.map((response) => response.kind),
		).not.toContain('result');
		expect(console.warn).not.toHaveBeenCalledWith(
			expect.stringContaining('falling back'),
			expect.anything(),
		);
		expect(pathsIn(app)).toEqual([RECORDING]);
		expect(noticeMessages()).toEqual([]);
		// A cancel is the user's, not a sign of a broken worker, so the next
		// conversion still goes to it rather than to the main thread.
		expect(worker.isAvailable()).toBe(true);
		worker.terminate();
	});

	it('sends the worker nothing for a conversion cancelled before it started', async () => {
		(global as Record<string, unknown>).Worker = InProcessWorker;
		global.URL.createObjectURL = jest.fn().mockReturnValue('blob:worker');
		global.URL.revokeObjectURL = jest.fn();
		const worker = new EncodingWorkerClient('worker-source');
		const cancellation = new CancellationSource();
		cancellation.cancel();

		await expect(
			worker.convertBlob(
				new Blob([stereoWav(PCM_RATE, 1)]),
				'wav',
				0,
				false,
				ChannelMode.Source,
				undefined,
				cancellation.token,
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(InProcessWorker.requests).toEqual([]);
		worker.terminate();
	});
});

/**
 * A split cancelled after its first part was written, undone: the part in
 * the trash, where a failed split's parts go, nothing left on disk, and the
 * source nowhere near the trash, since it was to go only after a split.
 * @param outcome - What the split answered
 * @param app - The app over the vault it wrote into
 */
function expectFirstPartUndone(
	outcome: Awaited<ReturnType<SplitService['split']>>,
	app: App,
): void {
	const { vault, fileManager } = asMockApp(app);
	expect(outcome).toEqual({ status: 'cancelled' });
	expect(fileManager.trashFile.mock.calls.map(([file]) => file.path)).toEqual(
		['Calls/call-part1.wav'],
	);
	expect(vault.delete).not.toHaveBeenCalled();
	expect(pathsIn(app)).toEqual([RECORDING]);
}

describe('cancelling a split', () => {
	const request = (
		sourceFile: TFile,
		partSeconds: number,
	): Parameters<SplitService['split']>[0] => ({
		sourceFile,
		partSeconds,
		suffix: 'part',
		bitrate: 128000,
		deleteSource: true,
		linkAction: 'replace',
	});

	it('trashes the parts the WAV byte copy already wrote and keeps the source', async () => {
		const { app, recording } = vaultHolding(stereoWav(PCM_RATE, 3));
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Writing part 2 of 3/);

		const outcome = await new SplitService(app).split(
			request(recording, 1),
			progress.onProgress,
			cancellation.token,
		);

		expectFirstPartUndone(outcome, app);
		expect(updateLinksInVault).not.toHaveBeenCalled();
		expect(noticeMessages()).toEqual([]);
	});

	it('stops the streamed decode inside a part and does not split again from a whole decode', async () => {
		const sampleRate = 8000;
		const { app, recording } = vaultHolding(alawWav(sampleRate, 6));
		const cancellation = new CancellationSource();
		const progressSeen: string[] = [];
		// Pulled while the second part's encoder is being fed, which no
		// boundary between parts could have noticed.
		const add = AudioSampleSource.prototype.add;
		let added = 0;
		let addedAtCancel: number | null = null;
		jest.spyOn(AudioSampleSource.prototype, 'add').mockImplementation(
			function (this: AudioSampleSource, sample) {
				added++;
				if (
					addedAtCancel === null &&
					progressSeen.includes('Writing part 2 of 3...')
				) {
					addedAtCancel = added;
					cancellation.cancel();
				}
				return add.call(this, sample);
			},
		);

		const outcome = await new SplitService(app).split(
			request(recording, 2),
			(text) => progressSeen.push(text),
			cancellation.token,
		);

		expectFirstPartUndone(outcome, app);
		// The sample in hand at the cancel was the last one fed: the decode
		// stopped there instead of finishing the part.
		expect(addedAtCancel).not.toBeNull();
		expect(added).toBe(addedAtCancel);
		expect(progressSeen).not.toContain('Writing part 3 of 3...');
		expect(progressSeen).not.toContain('Decoding audio...');
		expect(updateLinksInVault).not.toHaveBeenCalled();
		expect(noticeMessages()).toEqual([]);
	});
});
