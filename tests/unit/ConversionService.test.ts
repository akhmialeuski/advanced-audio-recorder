/**
 * Unit tests for ConversionService module. The full pipeline is also
 * exercised end-to-end through the ConversionModal suite; this suite
 * covers the service-level contract.
 * @module tests/unit/ConversionService.test
 */

import { ConversionService } from 'src/recording/ConversionService';
import type { ConversionRequest } from 'src/recording/ConversionService';
import { App, TFile } from 'obsidian';
import { noticeMessages } from '../mocks/obsidian';
import { createMockApp } from '../helpers/createApp';
import {
	useDesktopPlatform,
	useMobilePlatform,
} from '../helpers/platform';
import { MOBILE_MAX_DECODE_BYTES } from 'src/constants';
import {
	convertBlobToFormatBuffer,
	decodeAudioBlob,
} from 'src/audio/AudioFormatConverter';
import { encodeAudioBuffer } from 'src/audio/AudioEncoder';
import { downmixAudioBuffer } from 'src/audio/downmix';

jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/wav' })),
}));

jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({}),
	convertBlobToFormatBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
}));

jest.mock('src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 0,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

jest.mock('src/audio/downmix', () => {
	const actual: object = jest.requireActual('src/audio/downmix');
	return {
		...actual,
		downmixAudioBuffer: jest.fn((buffer: AudioBuffer) => buffer),
	};
});

const createSourceFile = (extension = 'wav'): TFile => {
	const file = new TFile();
	Object.assign(file, {
		path: `Audio/recording.${extension}`,
		name: `recording.${extension}`,
		basename: 'recording',
		extension,
		parent: { path: 'Audio' },
	});
	return file;
};

describe('ConversionService', () => {
	let service: ConversionService;
	let mockApp: App;

	const createRequest = (
		overrides: Partial<ConversionRequest> = {},
	): ConversionRequest => ({
		sourceFile: createSourceFile(),
		targetFormat: 'webm',
		bitrate: 128000,
		deleteSource: false,
		linkAction: 'none',
		...overrides,
	});

	const getNotices = (): string[] => noticeMessages();

	beforeEach(() => {
		mockApp = createMockApp({
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					readBinary: jest
						.fn()
						.mockResolvedValue(new ArrayBuffer(64)),
				},
				createBinary: jest.fn((path: string) => {
					const file = new TFile();
					Object.assign(file, { path });
					return Promise.resolve(file);
				}),
			},
			fileManager: {
				trashFile: jest.fn().mockResolvedValue(undefined),
			},
		}).app;
		service = new ConversionService(mockApp);
	});

	it('converts through the streaming pipeline and complete', async () => {
		const outcome = await service.convert(createRequest(), jest.fn());

		expect(outcome).toEqual({
			status: 'completed',
			newFileName: 'recording.webm',
			newPath: 'Audio/recording.webm',
		});
		expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
			'Audio/recording.webm',
			expect.any(ArrayBuffer),
		);
	});

	it('uses the decode-and-encode path for WAV targets', async () => {
		await service.convert(
			createRequest({
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav',
			}),
			jest.fn(),
		);

		expect(jest.mocked(decodeAudioBlob)).toHaveBeenCalled();
		expect(jest.mocked(encodeAudioBuffer)).toHaveBeenCalledWith(
			expect.anything(),
			{ format: 'wav', bitrate: 128000 },
			expect.any(Function),
		);
	});

	it('downmixes on the WAV decode path when a mono mode is requested', async () => {
		await service.convert(
			createRequest({
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav',
				channelMode: 'mono-left',
			}),
			jest.fn(),
		);

		expect(jest.mocked(downmixAudioBuffer)).toHaveBeenCalledWith(
			expect.anything(),
			'mono-left',
		);
	});

	it('passes the channel mode to the streaming conversion', async () => {
		await service.convert(
			createRequest({ channelMode: 'mono-mix' }),
			jest.fn(),
		);

		expect(jest.mocked(convertBlobToFormatBuffer)).toHaveBeenCalledWith(
			expect.any(Blob),
			'webm',
			128000,
			expect.any(Function),
			expect.objectContaining({ channelMode: 'mono-mix' }),
		);
	});

	it('refuses a same-format conversion without a mono mode', async () => {
		const outcome = await service.convert(
			createRequest({ targetFormat: 'wav' }),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'aborted' });
		expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		expect(
			getNotices().some((message) =>
				message.includes('requires a mono channels option'),
			),
		).toBe(true);
	});

	it('writes a -mono file for a same-format mono downmix', async () => {
		const outcome = await service.convert(
			createRequest({ targetFormat: 'wav', channelMode: 'mono-left' }),
			jest.fn(),
		);

		expect(outcome).toEqual({
			status: 'completed',
			newFileName: 'recording-mono.wav',
			newPath: 'Audio/recording-mono.wav',
		});
		expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
			'Audio/recording-mono.wav',
			expect.any(ArrayBuffer),
		);
	});

	it('treats an uppercase source extension as the same format', async () => {
		// A .WAV source converting to wav differs from the source path
		// only in case - still the same format, so it must get the
		// -mono name instead of colliding on Windows or creating a
		// case-twin file on case-sensitive systems
		const outcome = await service.convert(
			createRequest({
				sourceFile: createSourceFile('WAV'),
				targetFormat: 'wav',
				channelMode: 'mono-right',
			}),
			jest.fn(),
		);

		expect(outcome).toEqual({
			status: 'completed',
			newFileName: 'recording-mono.wav',
			newPath: 'Audio/recording-mono.wav',
		});
	});

	it('refuses an uppercase same-format conversion without a mono mode', async () => {
		const outcome = await service.convert(
			createRequest({
				sourceFile: createSourceFile('WAV'),
				targetFormat: 'wav',
			}),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'aborted' });
		expect(
			getNotices().some((message) =>
				message.includes('requires a mono channels option'),
			),
		).toBe(true);
	});

	// Every other decode-heavy feature asks the platform before it reads the
	// file. Conversion never did, so a phone was handed a whole recording and
	// a full PCM expansion of it, and the OS killed the WebView rather than
	// raising anything the plugin could report.
	it('refuses a file too large for this device before reading it', async () => {
		useMobilePlatform();
		const sourceFile = createSourceFile('webm');
		sourceFile.stat.size = MOBILE_MAX_DECODE_BYTES + 1;

		const outcome = await service.convert(
			createRequest({ sourceFile, targetFormat: 'wav' }),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'aborted' });
		expect(mockApp.vault.adapter.readBinary).not.toHaveBeenCalled();
		expect(getNotices()).toContain(
			'File is too large to convert on this device. Convert or split ' +
				'it on desktop instead.',
		);
	});

	it('converts that same file on desktop, where the ceiling is higher', async () => {
		useDesktopPlatform();
		const sourceFile = createSourceFile('webm');
		sourceFile.stat.size = MOBILE_MAX_DECODE_BYTES + 1;

		const outcome = await service.convert(
			createRequest({ sourceFile, targetFormat: 'wav' }),
			jest.fn(),
		);

		expect(outcome).toEqual({
			status: 'completed',
			newFileName: 'recording.wav',
			newPath: 'Audio/recording.wav',
		});
	});

	it('aborts when the target file already exists', async () => {
		jest.mocked(mockApp.vault.adapter.exists).mockResolvedValue(true);

		const outcome = await service.convert(createRequest(), jest.fn());

		expect(outcome).toEqual({ status: 'aborted' });
		expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		expect(
			getNotices().some((message) => message.includes('already exists')),
		).toBe(true);
	});

	it('aborts with a notice when the pipeline fails', async () => {
		jest.mocked(mockApp.vault.adapter.readBinary).mockRejectedValue(
			new Error('missing'),
		);
		const onProgress = jest.fn();

		const outcome = await service.convert(createRequest(), onProgress);

		expect(outcome).toEqual({ status: 'aborted' });
		expect(onProgress).toHaveBeenCalledWith('Error: missing');
		expect(
			getNotices().some((message) =>
				message.includes('Conversion failed'),
			),
		).toBe(true);
	});

	it('reports partial success when the source cannot be deleted', async () => {
		jest.mocked(mockApp.fileManager.trashFile).mockRejectedValue(
			new Error('locked'),
		);

		const outcome = await service.convert(
			createRequest({ deleteSource: true }),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'partial' });
	});

	it.each([
		{
			name: 'encoding a WAV target',
			request: {
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav' as const,
			},
			collaborator: (): jest.Mock => jest.mocked(encodeAudioBuffer),
			reportArg: 2,
			expected: 'Encoding... 40%',
		},
		{
			name: 'streaming a compressed target',
			request: {},
			collaborator: (): jest.Mock =>
				jest.mocked(convertBlobToFormatBuffer),
			reportArg: 3,
			expected: 'Converting... 40%',
		},
	])(
		'relays the percentage while $name',
		async ({ request, collaborator, reportArg, expected }) => {
			// The dialog shows this text and nothing else while a long
			// conversion runs. It is a one-line closure the encoder calls
			// back into, so no test had ever executed it - a wrong format
			// string here is a progress line that reads "Encoding...
			// [object Object]" for the whole run.
			collaborator().mockImplementationOnce(
				(...args: unknown[]): Promise<unknown> => {
					(args[reportArg] as (percent: number) => void)(40);
					return Promise.resolve(
						reportArg === 2
							? new Blob(['encoded'])
							: new ArrayBuffer(8),
					);
				},
			);
			const onProgress = jest.fn();

			await service.convert(createRequest(request), onProgress);

			expect(onProgress).toHaveBeenCalledWith(expected);
		},
	);
});
