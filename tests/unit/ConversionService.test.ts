/**
 * Unit tests for ConversionService module. The full pipeline is also
 * exercised end-to-end through the ConversionModal suite; this suite
 * covers the service-level contract.
 * @module tests/unit/ConversionService.test
 */

import { CancellationSource, NEVER_CANCELLED } from 'src/utils/cancellation';
import { ConversionService } from 'src/recording/ConversionService';
import type {
	ConversionOutcome,
	ConversionRequest,
} from 'src/recording/ConversionService';
import { App, TFile } from 'obsidian';
import { noticeMessages } from '../mocks/obsidian';
import { createMockApp } from '../helpers/createApp';
import { useDesktopPlatform, useMobilePlatform } from '../helpers/platform';
import {
	MOBILE_MAX_DECODE_BYTES,
	WAVEFORM_MAX_DECODE_BYTES,
} from 'src/constants';
import { convertBlobToFormatBuffer } from 'src/audio/AudioFormatConverter';
import type { EncodingWorkerClient } from 'src/audio/EncodingWorkerClient';
import { partial } from '../helpers/doubles';
import { updateLinksInVault } from 'src/utils/LinkUpdater';

jest.mock('src/audio/AudioFormatConverter', () => ({
	convertBlobToFormatBuffer: jest.fn().mockResolvedValue({
		data: new ArrayBuffer(8),
		sampleRateChange: null,
	}),
}));

jest.mock('src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 0,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

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
				readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(64)),
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

	describe('a file written at another rate than its source', () => {
		beforeEach(() => {
			jest.mocked(convertBlobToFormatBuffer).mockResolvedValueOnce({
				data: new ArrayBuffer(8),
				sampleRateChange: { from: 16000, to: 44100 },
			});
		});

		it('says which rate the file was resampled to, and why', async () => {
			await service.convert(
				createRequest({ targetFormat: 'm4a' }),
				jest.fn(),
			);

			expect(getNotices()).toContain(
				'"recording.m4a" was resampled from 16 kHz to 44.1 kHz, because the M4A encoder on this device does not take 16 kHz.',
			);
		});

		it('says nothing about a file that was never written', async () => {
			jest.mocked(mockApp.vault.createBinary).mockRejectedValueOnce(
				new Error('disk full'),
			);

			await service.convert(
				createRequest({ targetFormat: 'm4a' }),
				jest.fn(),
			);

			expect(
				getNotices().some((message) => message.includes('resampled')),
			).toBe(false);
		});
	});

	it('converts a WAV target through the same ladder as a compressed one', async () => {
		// The streaming Conversion writes WAV too. Decoding the whole file
		// into an AudioBuffer first held the recording as 32-bit floats
		// beside the WAV being written, and skipped the worker entirely.
		const workerClient = partial<EncodingWorkerClient>({
			isAvailable: (): boolean => true,
		});
		const withWorker = new ConversionService(mockApp, () => workerClient);

		await withWorker.convert(
			createRequest({
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav',
			}),
			jest.fn(),
		);

		expect(jest.mocked(convertBlobToFormatBuffer)).toHaveBeenCalledWith(
			expect.any(Blob),
			'wav',
			128000,
			expect.any(Function),
			{
				workerClient,
				channelMode: 'source',
				cancellation: NEVER_CANCELLED,
			},
		);
	});

	it('reads the source through the vault, not its adapter', async () => {
		const request = createRequest();

		await service.convert(request, jest.fn());

		expect(mockApp.vault.readBinary).toHaveBeenCalledWith(
			request.sourceFile,
		);
		expect(mockApp.vault.adapter.readBinary).not.toHaveBeenCalled();
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

	// Every other feature that reads a whole file asks the platform first.
	// Conversion never did, so a phone was handed a whole recording and a full
	// PCM expansion of it, and the OS killed the WebView rather than raising
	// anything the plugin could report. The question asked here is about the
	// read, not the decode: the compressed path below remuxes or streams and
	// never expands the file, so a decode ceiling would refuse work the
	// converter does without allocating for it.
	/**
	 * Converts a file just over the mobile decode ceiling to WAV.
	 * @returns What the pipeline answered
	 */
	const convertOversized = (): Promise<ConversionOutcome> => {
		const sourceFile = createSourceFile('webm');
		sourceFile.stat.size = MOBILE_MAX_DECODE_BYTES + 1;
		return service.convert(
			createRequest({ sourceFile, targetFormat: 'wav' }),
			jest.fn(),
		);
	};

	it('refuses a file too large for this device before reading it', async () => {
		useMobilePlatform();

		expect(await convertOversized()).toEqual({ status: 'aborted' });
		expect(mockApp.vault.readBinary).not.toHaveBeenCalled();
		expect(getNotices()).toContain(
			'File is too large to convert on this device. Convert or split ' +
				'it on desktop instead.',
		);
	});

	it('converts that same file on desktop, where the ceiling is higher', async () => {
		useDesktopPlatform();

		expect(await convertOversized()).toEqual({
			status: 'completed',
			newFileName: 'recording.wav',
			newPath: 'Audio/recording.wav',
		});
	});

	// Desktop reads a source of any size, and the compressed path converts it
	// without ever expanding it to PCM. Refusing here on the decode ceiling
	// turned away the long recordings the feature exists to compress: a
	// two-hour stereo WAV is past that ceiling and streams through fine.
	it('converts a source past the decode ceiling to a compressed format', async () => {
		useDesktopPlatform();
		const sourceFile = createSourceFile('wav');
		sourceFile.stat.size = WAVEFORM_MAX_DECODE_BYTES + 1;

		const outcome = await service.convert(
			createRequest({ sourceFile, targetFormat: 'mp3' }),
			jest.fn(),
		);

		expect(outcome).toEqual({
			status: 'completed',
			newFileName: 'recording.mp3',
			newPath: 'Audio/recording.mp3',
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
		jest.mocked(mockApp.vault.readBinary).mockRejectedValue(
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

	it('keeps the source and reports partial success when the links cannot be updated', async () => {
		// The converted file already exists by then, so this is not a failed
		// conversion; deleting the source on top of it would leave every link
		// that was not rewritten pointing at nothing.
		const { updateLinksInVault } = jest.requireMock<{
			updateLinksInVault: jest.Mock;
		}>('src/utils/LinkUpdater');
		updateLinksInVault.mockRejectedValueOnce(new Error('index busy'));

		const outcome = await service.convert(
			createRequest({ linkAction: 'replace', deleteSource: true }),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'partial' });
		expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		expect(getNotices()).toContain(
			'"recording.webm" was created, but updating links failed: index busy. The source file was kept.',
		);
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
			name: 'a WAV target',
			request: {
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav' as const,
			},
		},
		{ name: 'a compressed target', request: {} },
	])('relays the percentage while converting $name', async ({ request }) => {
		// The dialog shows this text and nothing else while a long
		// conversion runs. It is a one-line closure the converter calls
		// back into, so no test had ever executed it - a wrong format
		// string here is a progress line that reads "Converting...
		// [object Object]" for the whole run.
		jest.mocked(convertBlobToFormatBuffer).mockImplementationOnce(
			(_blob, _format, _bitrate, report) => {
				report?.(40);
				return Promise.resolve({
					data: new ArrayBuffer(8),
					sampleRateChange: null,
				});
			},
		);
		const onProgress = jest.fn();

		await service.convert(createRequest(request), onProgress);

		expect(onProgress).toHaveBeenCalledWith('Converting... 40%');
	});

	describe('a cancel that arrives while the converted file is written', () => {
		/** Cancels the conversion from inside the write, as a click would. */
		function cancelDuringWrite(): CancellationSource {
			const source = new CancellationSource();
			jest.mocked(mockApp.vault.createBinary).mockImplementationOnce(
				(path: string) => {
					source.cancel();
					return Promise.resolve(
						Object.assign(new TFile(), { path }),
					);
				},
			);
			return source;
		}

		it('trashes the file and touches no link', async () => {
			const source = cancelDuringWrite();

			const outcome = await service.convert(
				createRequest({ linkAction: 'replace', deleteSource: true }),
				jest.fn(),
				source.token,
			);

			expect(outcome).toEqual({ status: 'cancelled' });
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledTimes(1);
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: 'Audio/recording.webm' }),
			);
			expect(jest.mocked(updateLinksInVault)).not.toHaveBeenCalled();
			expect(getNotices()).toEqual([]);
		});

		// The cancel still stands: the user asked to stop, and a file that
		// would not go is a cleanup failure for the log, not a failed
		// conversion to report.
		it('logs a file that cannot be trashed and still answers cancelled', async () => {
			const source = cancelDuringWrite();
			const error = jest.spyOn(console, 'error').mockImplementation();
			jest.mocked(mockApp.fileManager.trashFile).mockRejectedValueOnce(
				new Error('locked'),
			);

			const outcome = await service.convert(
				createRequest(),
				jest.fn(),
				source.token,
			);

			expect(outcome).toEqual({ status: 'cancelled' });
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('after a cancel'),
				expect.objectContaining({ path: 'Audio/recording.webm' }),
			);
			expect(getNotices()).toEqual([]);
		});
	});
});
