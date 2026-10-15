/**
 * Unit tests for SplitService module. The full pipeline is also
 * exercised end-to-end through the SplitModal suite; this suite covers
 * the service-level contract.
 * @module tests/unit/SplitService.test
 */

import { SplitService } from 'src/recording/SplitService';
import type { SplitRequest } from 'src/recording/SplitService';
import { App, TFile } from 'obsidian';
import { noticeMessages } from '../mocks/obsidian';
import { createMockApp } from '../helpers/createApp';
import { defined } from '../helpers/assertions';
import { useDesktopPlatform } from '../helpers/platform';
import { partial } from '../helpers/doubles';
import { createWavHeader } from 'src/audio/WavEncoder';
import { StreamedSplit, StreamedSplitError } from 'src/audio/streamingSplit';

jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'webm', 'ogg'].includes(format),
	),
}));

jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({
		length: 882000,
		sampleRate: 44100,
		numberOfChannels: 1,
		getChannelData: jest.fn().mockReturnValue(new Float32Array(882000)),
	}),
}));

jest.mock('src/platform/capabilities', () => {
	const actual = jest.requireActual<
		typeof import('src/platform/capabilities')
	>('src/platform/capabilities');
	return {
		...actual,
		isDecodableSize: jest.fn(actual.isDecodableSize),
		isReadableSize: jest.fn(actual.isReadableSize),
	};
});

jest.mock('src/recording/AudioSplitter', () => {
	const actual = jest.requireActual<
		typeof import('src/recording/AudioSplitter')
	>('src/recording/AudioSplitter');
	return {
		...actual,
		sliceAudioBuffer: jest.fn().mockReturnValue({}),
	};
});

jest.mock('src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 0,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

// By default this device cannot stream the source, which is the decode-
// everything path most of this suite describes.
jest.mock('src/audio/streamingSplit', () =>
	require('../mocks/modules/streamingSplit'),
);

/**
 * Lets the next split stream its source: a recording of the given length,
 * decoded at the given rate, whose every part encodes to a few bytes.
 * @param seconds - Length the split plans its parts over
 * @param sampleRate - Rate the frames are counted in
 * @returns The part and release spies of the scripted split
 */
function streamingSource(
	seconds: number,
	sampleRate = 48000,
): { nextPart: jest.Mock; release: jest.Mock } {
	const nextPart = jest.fn().mockResolvedValue(new ArrayBuffer(8));
	const release = jest.fn();
	jest.mocked(StreamedSplit.open).mockResolvedValueOnce(
		partial<StreamedSplit>({
			sampleRate,
			numberOfChannels: 1,
			plannedFrames: seconds * sampleRate,
			nextPart,
			[Symbol.dispose]: release,
		}),
	);
	return { nextPart, release };
}

const createSourceFile = (extension: string): TFile => {
	const file = new TFile();
	Object.assign(file, {
		path: `Audio/recording.${extension}`,
		name: `recording.${extension}`,
		basename: 'recording',
		extension,
		parent: { path: 'Audio' },
		stat: { size: 64, ctime: 0, mtime: 0 },
	});
	return file;
};

describe('SplitService', () => {
	let service: SplitService;
	let mockApp: App;
	let createdFiles: string[];

	const createRequest = (
		overrides: Partial<SplitRequest> = {},
	): SplitRequest => ({
		sourceFile: createSourceFile('mp3'),
		partSeconds: 10,
		suffix: 'part',
		bitrate: 128000,
		deleteSource: false,
		linkAction: 'none',
		...overrides,
	});

	beforeEach(() => {
		createdFiles = [];
		mockApp = createMockApp({
			vault: {
				readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(64)),
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					remove: jest.fn().mockResolvedValue(undefined),
				},
				delete: jest.fn().mockResolvedValue(undefined),
				createBinary: jest.fn((path: string) => {
					createdFiles.push(path);
					const file = new TFile();
					Object.assign(file, { path });
					return Promise.resolve(file);
				}),
			},
			fileManager: {
				trashFile: jest.fn().mockResolvedValue(undefined),
			},
		}).app;
		service = new SplitService(mockApp);
	});

	describe('getTargetExtension', () => {
		it('keeps WAV sources as WAV', () => {
			expect(service.getTargetExtension(createSourceFile('wav'))).toBe(
				'wav',
			);
		});

		it('keeps encodable compressed formats', () => {
			expect(service.getTargetExtension(createSourceFile('mp3'))).toBe(
				'mp3',
			);
		});

		it('falls back to WAV for unencodable formats', () => {
			expect(service.getTargetExtension(createSourceFile('aiff'))).toBe(
				'wav',
			);
		});
	});

	describe('split', () => {
		it('writes all parts and complete', async () => {
			const outcome = await service.split(createRequest(), jest.fn());

			// 882000 samples at 44100 Hz / 10 s parts -> 2 parts
			expect(outcome).toEqual({
				status: 'completed',
				partCount: 2,
				firstPartName: 'recording-part1.mp3',
			});
			expect(createdFiles).toEqual([
				'Audio/recording-part1.mp3',
				'Audio/recording-part2.mp3',
			]);
		});

		it('aborts BEFORE reading a source over the platform read ceiling', async () => {
			// On mobile even materializing the source bytes can get the
			// WebView killed, so the size gate must run on stat.size,
			// before vault.readBinary
			const { isReadableSize } = jest.requireMock<{
				isReadableSize: jest.Mock;
			}>('src/platform/capabilities');
			isReadableSize.mockReturnValueOnce(false);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(mockApp.vault.readBinary).not.toHaveBeenCalled();
			expect(
				noticeMessages().some((message) =>
					// The advice that follows depends on the platform and is
					// pinned in the capability suite; what matters here is that
					// the path refused and said which operation it refused.
					message.includes('too large to split'),
				),
			).toBe(true);
		});

		it('aborts the decode path when the file exceeds the platform decode ceiling', async () => {
			// Decoding expands the file to full PCM in memory; whether a file
			// may be decoded whole is one question the platform capability
			// layer answers for every path that asks it (far stricter on
			// mobile), and this is that path asking.
			const { isDecodableSize } = jest.requireMock<{
				isDecodableSize: jest.Mock;
			}>('src/platform/capabilities');
			isDecodableSize.mockReturnValueOnce(false);
			const { decodeAudioBlob } = jest.requireMock<{
				decodeAudioBlob: jest.Mock;
			}>('src/audio/AudioFormatConverter');

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(decodeAudioBlob).not.toHaveBeenCalled();
			expect(createdFiles).toEqual([]);
			expect(
				noticeMessages().some((message) =>
					// The advice that follows depends on the platform and is
					// pinned in the capability suite; what matters here is that
					// the path refused and said which operation it refused.
					message.includes('too large to split'),
				),
			).toBe(true);
		});

		// On desktop the generic way out of a size ceiling is to split the
		// file into parts, which is the button the user just pressed. The
		// splitter answers with the reason the ceiling exists instead: it
		// bounds the decode, and a raw WAV source is never decoded.
		it('does not answer a refused split by advising a split', async () => {
			useDesktopPlatform();
			const { isDecodableSize } = jest.requireMock<{
				isDecodableSize: jest.Mock;
			}>('src/platform/capabilities');
			isDecodableSize.mockReturnValueOnce(false);

			await service.split(createRequest(), jest.fn());

			const refusal = defined(
				noticeMessages().find((message) =>
					message.includes('too large to split'),
				),
			);
			expect(refusal).not.toMatch(/split it/i);
			expect(refusal).toContain('WAV');
		});

		it('aborts on a name collision before writing anything', async () => {
			jest.mocked(mockApp.vault.adapter.exists).mockResolvedValue(true);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(createdFiles).toEqual([]);
			expect(
				noticeMessages().some((message) =>
					message.includes('already exists'),
				),
			).toBe(true);
		});

		it('reports partial success when the source cannot be deleted', async () => {
			jest.mocked(mockApp.fileManager.trashFile).mockRejectedValue(
				new Error('locked'),
			);

			const outcome = await service.split(
				createRequest({ deleteSource: true }),
				jest.fn(),
			);

			expect(outcome).toEqual({ status: 'partial' });
			expect(createdFiles).toHaveLength(2);
		});

		it('aborts with a notice when reading the source fails', async () => {
			jest.mocked(mockApp.vault.readBinary).mockRejectedValue(
				new Error('missing'),
			);
			const onProgress = jest.fn();

			const outcome = await service.split(createRequest(), onProgress);

			expect(outcome).toEqual({ status: 'aborted' });
			expect(onProgress).toHaveBeenCalledWith('Error: missing');
		});
	});

	// Chapter boundaries make parts of different lengths, each named after
	// its chapter, which is the whole point of cutting there rather than
	// every N minutes.
	describe('cutting at chapters', () => {
		const CUTS = [
			{ startSeconds: 0, title: 'Intro' },
			{ startSeconds: 5, title: 'The middle' },
		];

		it('names each part after its chapter, on the decode path', async () => {
			const outcome = await service.split(
				createRequest({ cuts: CUTS }),
				jest.fn(),
			);

			expect(outcome.status).toBe('completed');
			expect(createdFiles).toEqual([
				'Audio/Intro.mp3',
				'Audio/The middle.mp3',
			]);
		});

		it('numbers the second of two chapters sharing a title', async () => {
			await service.split(
				createRequest({
					cuts: [
						{ startSeconds: 0, title: 'Part' },
						{ startSeconds: 5, title: 'Part' },
					],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual([
				'Audio/Part.mp3',
				'Audio/Part-2.mp3',
			]);
		});

		it('falls back to the recording name for a title of punctuation', async () => {
			await service.split(
				createRequest({
					cuts: [{ startSeconds: 0, title: '///' }],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual(['Audio/recording-1.mp3']);
		});

		it('names the audio before the first chapter after the recording', async () => {
			// Naming it after that chapter would label it with a title that
			// belongs to the part after it
			await service.split(
				createRequest({
					cuts: [{ startSeconds: 5, title: 'Late' }],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual([
				'Audio/recording-1.mp3',
				'Audio/Late.mp3',
			]);
		});

		it('cuts nowhere for a chapter past the end of the recording', async () => {
			// 882000 samples at 44100 Hz is twenty seconds
			await service.split(
				createRequest({
					cuts: [
						{ startSeconds: 0, title: 'Intro' },
						{ startSeconds: 99, title: 'Never' },
					],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual(['Audio/Intro.mp3']);
		});

		it('cuts an uncompressed WAV at chapters without decoding it', async () => {
			// One second per 1000 bytes at 500 Hz, 16-bit mono
			const header = createWavHeader(1, 500, 4000);
			const wav = new Uint8Array(44 + 4000);
			wav.set(new Uint8Array(header), 0);
			jest.mocked(mockApp.vault.readBinary).mockResolvedValue(wav.buffer);
			const decode = jest.mocked(
				jest.requireMock<{ decodeAudioBlob: jest.Mock }>(
					'src/audio/AudioFormatConverter',
				).decodeAudioBlob,
			);
			decode.mockClear();

			await service.split(
				createRequest({
					sourceFile: createSourceFile('wav'),
					cuts: [
						{ startSeconds: 0, title: 'Intro' },
						{ startSeconds: 2, title: 'The middle' },
					],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual([
				'Audio/Intro.wav',
				'Audio/The middle.wav',
			]);
			// The lossless path never decodes, which is what makes it usable
			// on a file too big to hold in memory
			expect(decode).not.toHaveBeenCalled();
		});

		it('does not measure a chapter split against a fixed part length', async () => {
			// The even split refuses a file shorter than one part; a chapter
			// split has no such length to be shorter than
			const outcome = await service.split(
				createRequest({ partSeconds: 99999, cuts: CUTS }),
				jest.fn(),
			);

			expect(outcome.status).toBe('completed');
		});

		it('cuts chapters at their frames while decoding', async () => {
			const { nextPart } = streamingSource(20);

			await service.split(createRequest({ cuts: CUTS }), jest.fn());

			expect(createdFiles).toEqual([
				'Audio/Intro.mp3',
				'Audio/The middle.mp3',
			]);
			// The last part runs to whatever the decoder produces.
			expect(nextPart.mock.calls).toEqual([[5 * 48000], [null]]);
		});
	});

	// Where this device can decode the source and encode the target, the
	// parts are cut out of one continuous decode instead of out of a buffer
	// holding the whole recording as floats.
	describe('splitting as it decodes', () => {
		/** The whole-file decode the streamed split stands in for. */
		const decode = (): jest.Mock =>
			jest.requireMock<{ decodeAudioBlob: jest.Mock }>(
				'src/audio/AudioFormatConverter',
			).decodeAudioBlob;

		it('cuts the parts on the frames the decoded split cuts at', async () => {
			const { nextPart } = streamingSource(25);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({
				status: 'completed',
				partCount: 3,
				firstPartName: 'recording-part1.mp3',
			});
			expect(nextPart.mock.calls).toEqual([
				[10 * 48000],
				[20 * 48000],
				[null],
			]);
			expect(decode()).not.toHaveBeenCalled();
		});

		it('encodes the parts in the source format at the chosen bitrate', async () => {
			streamingSource(25);

			await service.split(createRequest({ bitrate: 64000 }), jest.fn());

			expect(StreamedSplit.open).toHaveBeenCalledWith(
				expect.any(ArrayBuffer),
				'mp3',
				64000,
			);
		});

		it('never holds a streamed source to the decode ceiling', async () => {
			// The ceiling bounds a whole-file decode, which a streamed split
			// never makes: a long recording past it splits all the same.
			streamingSource(25);
			const { isDecodableSize } = jest.requireMock<{
				isDecodableSize: jest.Mock;
			}>('src/platform/capabilities');

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome.status).toBe('completed');
			expect(isDecodableSize).not.toHaveBeenCalled();
		});

		it('releases the decoder once the parts are written', async () => {
			const { release } = streamingSource(25);

			await service.split(createRequest(), jest.fn());

			expect(release).toHaveBeenCalledTimes(1);
		});

		it('refuses a source shorter than one part and releases it', async () => {
			const { nextPart, release } = streamingSource(5);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(nextPart).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
			expect(noticeMessages()).toContain(
				'File is shorter than one part.',
			);
		});

		it('falls back to decoding the whole file when a part fails, after removing the parts it wrote', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			const { nextPart } = streamingSource(25);
			nextPart
				.mockResolvedValueOnce(new ArrayBuffer(8))
				.mockRejectedValueOnce(new StreamedSplitError('decoder lost'));

			const outcome = await service.split(createRequest(), jest.fn());

			// The decoded split starts from where the streamed one did: its
			// first part is gone, and the decode writes every part again.
			// Removed outright rather than trashed, since the split goes on
			// and the user's trash would otherwise keep a part of a split
			// that succeeded.
			expect(mockApp.vault.delete).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Audio/recording-part1.mp3' }),
			);
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(decode()).toHaveBeenCalledTimes(1);
			expect(outcome).toEqual({
				status: 'completed',
				partCount: 2,
				firstPartName: 'recording-part1.mp3',
			});
		});

		it('does not retry a failure in writing the parts', async () => {
			streamingSource(25);
			jest.mocked(mockApp.vault.createBinary).mockRejectedValueOnce(
				new Error('disk full'),
			);

			const outcome = await service.split(createRequest(), jest.fn());

			// A full disk is as full for the decoded split, so the user is
			// told rather than made to wait for the same failure twice.
			expect(outcome).toEqual({ status: 'aborted' });
			expect(decode()).not.toHaveBeenCalled();
			expect(noticeMessages()).toContain('Split failed: disk full');
		});

		it('sends the parts of a split that ends in failure to the trash', async () => {
			streamingSource(25);
			jest.mocked(mockApp.vault.createBinary)
				.mockImplementationOnce((path: string) =>
					Promise.resolve(Object.assign(new TFile(), { path })),
				)
				.mockRejectedValueOnce(new Error('disk full'));

			await service.split(createRequest(), jest.fn());

			// Nothing writes them again, so they stay recoverable where the
			// user's deletion preference puts them.
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Audio/recording-part1.mp3' }),
			);
			expect(mockApp.vault.delete).not.toHaveBeenCalled();
		});

		it('says once that the parts are written as WAV, even when it falls back', async () => {
			jest.spyOn(console, 'warn').mockImplementation();
			const { nextPart } = streamingSource(25);
			nextPart.mockRejectedValueOnce(new StreamedSplitError('lost'));

			await service.split(
				createRequest({ sourceFile: createSourceFile('aiff') }),
				jest.fn(),
			);

			expect(
				noticeMessages().filter((message) =>
					message.startsWith('Encoding to "aiff" is unavailable'),
				),
			).toHaveLength(1);
		});
	});

	// A device that cannot stream the source decodes it whole, and it has to
	// cut the recording into the parts a streaming device cuts, or the same
	// file splits differently on a phone and on a desktop.
	describe('planning the parts of a whole-file decode', () => {
		const RATE = 44100;

		/** Makes the next whole-file decode return a recording this long. */
		const decodedLength = (seconds: number): void => {
			const length = Math.round(seconds * RATE);
			jest.requireMock<{ decodeAudioBlob: jest.Mock }>(
				'src/audio/AudioFormatConverter',
			).decodeAudioBlob.mockResolvedValueOnce({
				length,
				sampleRate: RATE,
				numberOfChannels: 1,
				getChannelData: jest
					.fn()
					.mockReturnValue(new Float32Array(length)),
			});
		};

		/** The sample ranges the decoded parts were sliced out of. */
		const slicedRanges = (): [number, number][] =>
			jest
				.requireMock<{ sliceAudioBuffer: jest.Mock }>(
					'src/recording/AudioSplitter',
				)
				.sliceAudioBuffer.mock.calls.map(
					([, start, end]: [unknown, number, number]) => [start, end],
				);

		beforeEach(() => {
			jest.requireMock<{ sliceAudioBuffer: jest.Mock }>(
				'src/recording/AudioSplitter',
			).sliceAudioBuffer.mockClear();
		});

		it('refuses a recording whose only extra is shorter than the tail, as a streamed split does', async () => {
			// 10.1 s into 10 s parts: the streamed split plans 9.85 s and
			// refuses, so the decode must not write a 0.1 s second part.
			decodedLength(10.1);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(createdFiles).toEqual([]);
			expect(noticeMessages()).toContain(
				'File is shorter than one part.',
			);
		});

		it('lets a remainder shorter than the tail ride on the last part', async () => {
			decodedLength(20.1);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({
				status: 'completed',
				partCount: 2,
				firstPartName: 'recording-part1.mp3',
			});
			// The last part runs to the end of the decoded audio, the way the
			// streamed split's last part runs to the end of the decode.
			expect(slicedRanges()).toEqual([
				[0, 10 * RATE],
				[10 * RATE, Math.round(20.1 * RATE)],
			]);
		});

		it('opens no part for a chapter that starts inside the tail', async () => {
			decodedLength(20);

			await service.split(
				createRequest({
					cuts: [
						{ startSeconds: 0, title: 'Intro' },
						{ startSeconds: 19.9, title: 'Too late' },
					],
				}),
				jest.fn(),
			);

			expect(createdFiles).toEqual(['Audio/Intro.mp3']);
			expect(slicedRanges()).toEqual([[0, 20 * RATE]]);
		});
	});
});
