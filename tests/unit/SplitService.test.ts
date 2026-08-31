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
import { createWavHeader } from 'src/audio/WavEncoder';

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
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					readBinary: jest
						.fn()
						.mockResolvedValue(new ArrayBuffer(64)),
					remove: jest.fn().mockResolvedValue(undefined),
				},
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
			// before adapter.readBinary
			const { isReadableSize } = jest.requireMock<{
				isReadableSize: jest.Mock;
			}>('src/platform/capabilities');
			isReadableSize.mockReturnValueOnce(false);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(mockApp.vault.adapter.readBinary).not.toHaveBeenCalled();
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
			jest.mocked(mockApp.vault.adapter.readBinary).mockRejectedValue(
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
			jest.mocked(mockApp.vault.adapter.readBinary).mockResolvedValue(
				wav.buffer,
			);
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
	});
});
