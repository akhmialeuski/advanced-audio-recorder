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
import { assembleWavFromPcmSegments } from 'src/audio/WavEncoder';
import { PcmSampleFormat } from 'src/audio/pcm';
import { CancellationSource } from 'src/utils/cancellation';
import * as LinkUpdater from 'src/utils/LinkUpdater';
import { createMockApp } from '../helpers/createApp';
import { alawWav, encodePcmSamples } from '../helpers/pcmFixtures';
import { noticeMessages } from '../mocks/obsidian';
import { waitFor } from '../helpers/async';

/** Rate of the PCM fixtures, deliberately not the device's own. */
const PCM_RATE = 22050;

/**
 * A stereo 16-bit WAV, long enough that mediabunny reports progress well
 * before it is done.
 * @param seconds - Length of the recording
 */
function stereoWav(seconds: number): ArrayBuffer {
	const interleaved: number[] = [];
	for (let frame = 0; frame < PCM_RATE * seconds; frame++) {
		interleaved.push((frame % 2000) * 8, 4000);
	}
	const pcm = encodePcmSamples(PcmSampleFormat.Int16, interleaved);
	return assembleWavFromPcmSegments([pcm], 2, PCM_RATE);
}

/** A vault holding one recording, with every write and removal recorded. */
interface BinaryVault {
	app: App;
	/** What is on disk now, by path. */
	written: Map<string, ArrayBuffer>;
	/** Paths the service removed outright. */
	deleted: string[];
	/** Paths the service sent to the trash. */
	trashed: string[];
}

/**
 * The vault the service writes into.
 * @param source - Bytes of the recording being converted or split
 */
function binaryVault(source: ArrayBuffer): BinaryVault {
	const written = new Map<string, ArrayBuffer>();
	const deleted: string[] = [];
	const trashed: string[] = [];
	const remove =
		(into: string[]) =>
		(file: TFile): Promise<void> => {
			into.push(file.path);
			written.delete(file.path);
			return Promise.resolve();
		};
	const app = createMockApp({
		vault: {
			readBinary: jest.fn().mockResolvedValue(source),
			adapter: {
				exists: jest.fn((path: string) =>
					Promise.resolve(written.has(path)),
				),
			},
			createBinary: jest.fn((path: string, data: ArrayBuffer) => {
				written.set(path, data);
				return Promise.resolve(Object.assign(new TFile(), { path }));
			}),
			delete: jest.fn(remove(deleted)),
		},
		fileManager: { trashFile: jest.fn(remove(trashed)) },
	}).app;
	return { app, written, deleted, trashed };
}

/**
 * The recording a service acts on.
 * @param name - File name, with its extension
 * @param size - Its size on disk
 */
function recording(name: string, size: number): TFile {
	const [basename = name, extension = ''] = name.split('.');
	return Object.assign(new TFile(), {
		path: `Calls/${name}`,
		name,
		basename,
		extension,
		parent: { path: 'Calls' },
		stat: { size, ctime: 0, mtime: 0 },
	});
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
		const source = stereoWav(30);
		const vault = binaryVault(source);
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Converting\.\.\. \d+%$/);

		const outcome = await new ConversionService(vault.app).convert(
			request(recording('call.wav', source.byteLength)),
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
		expect(vault.written.size).toBe(0);
		expect(updateLinksInVault).not.toHaveBeenCalled();
		expect(noticeMessages()).toEqual([]);
	});

	it('cancels the conversion in the worker and does not fall back to the main thread', async () => {
		(global as Record<string, unknown>).Worker = InProcessWorker;
		global.URL.createObjectURL = jest.fn().mockReturnValue('blob:worker');
		global.URL.revokeObjectURL = jest.fn();
		const worker = new EncodingWorkerClient('worker-source');
		const source = stereoWav(30);
		const vault = binaryVault(source);
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Converting\.\.\. \d+%$/);

		const outcome = await new ConversionService(
			vault.app,
			() => worker,
		).convert(
			request(recording('call.wav', source.byteLength)),
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
		expect(vault.written.size).toBe(0);
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
				new Blob([stereoWav(1)]),
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
 * @param vault - The vault it wrote into
 */
function expectFirstPartUndone(
	outcome: Awaited<ReturnType<SplitService['split']>>,
	vault: BinaryVault,
): void {
	expect(outcome).toEqual({ status: 'cancelled' });
	expect(vault.trashed).toEqual(['Calls/call-part1.wav']);
	expect(vault.deleted).toEqual([]);
	expect(vault.written.size).toBe(0);
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
		const source = stereoWav(3);
		const vault = binaryVault(source);
		const cancellation = new CancellationSource();
		const progress = cancellingOn(cancellation, /^Writing part 2 of 3/);

		const outcome = await new SplitService(vault.app).split(
			request(recording('call.wav', source.byteLength), 1),
			progress.onProgress,
			cancellation.token,
		);

		expectFirstPartUndone(outcome, vault);
		expect(updateLinksInVault).not.toHaveBeenCalled();
		expect(noticeMessages()).toEqual([]);
	});

	it('stops the streamed decode inside a part and does not split again from a whole decode', async () => {
		const sampleRate = 8000;
		const source = alawWav(sampleRate, 6);
		const vault = binaryVault(source);
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

		const outcome = await new SplitService(vault.app).split(
			request(recording('call.wav', source.byteLength), 2),
			(text) => progressSeen.push(text),
			cancellation.token,
		);

		expectFirstPartUndone(outcome, vault);
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
