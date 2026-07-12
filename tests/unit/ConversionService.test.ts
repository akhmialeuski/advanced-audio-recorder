/**
 * Unit tests for ConversionService module. The full pipeline is also
 * exercised end-to-end through the ConversionModal suite; this suite
 * covers the service-level contract.
 * @module tests/unit/ConversionService.test
 */

import { ConversionService } from 'src/recording/ConversionService';
import type { ConversionRequest } from 'src/recording/ConversionService';
import { TFile, App } from 'obsidian';

jest.mock('obsidian', () => ({
	App: jest.fn(),
	Notice: jest.fn(),
	TFile: class {
		path = '';
		name = '';
		basename = '';
		extension = '';
		parent: { path: string } | null = null;
	},
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));

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

	const getNotices = (): string[] => {
		const { Notice } = jest.requireMock('obsidian');
		return (Notice as jest.Mock).mock.calls.map((call) => String(call[0]));
	};

	beforeEach(() => {
		jest.clearAllMocks();
		mockApp = {
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
		} as unknown as App;
		service = new ConversionService(mockApp);
	});

	it('should convert through the streaming pipeline and complete', async () => {
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

	it('should use the decode-and-encode path for WAV targets', async () => {
		const { decodeAudioBlob } = jest.requireMock(
			'src/audio/AudioFormatConverter',
		);
		const { encodeAudioBuffer } = jest.requireMock(
			'src/audio/AudioEncoder',
		);

		await service.convert(
			createRequest({
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav',
			}),
			jest.fn(),
		);

		expect(decodeAudioBlob).toHaveBeenCalled();
		expect(encodeAudioBuffer).toHaveBeenCalledWith(
			expect.anything(),
			{ format: 'wav', bitrate: 128000 },
			expect.any(Function),
		);
	});

	it('should downmix on the WAV decode path when a mono mode is requested', async () => {
		const { downmixAudioBuffer } = jest.requireMock('src/audio/downmix');

		await service.convert(
			createRequest({
				sourceFile: createSourceFile('webm'),
				targetFormat: 'wav',
				channelMode: 'mono-left',
			}),
			jest.fn(),
		);

		expect(downmixAudioBuffer).toHaveBeenCalledWith(
			expect.anything(),
			'mono-left',
		);
	});

	it('should pass the channel mode to the streaming conversion', async () => {
		const { convertBlobToFormatBuffer } = jest.requireMock(
			'src/audio/AudioFormatConverter',
		);

		await service.convert(
			createRequest({ channelMode: 'mono-mix' }),
			jest.fn(),
		);

		expect(convertBlobToFormatBuffer).toHaveBeenCalledWith(
			expect.any(Blob),
			'webm',
			128000,
			expect.any(Function),
			expect.objectContaining({ channelMode: 'mono-mix' }),
		);
	});

	it('should refuse a same-format conversion without a mono mode', async () => {
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

	it('should write a -mono file for a same-format mono downmix', async () => {
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

	it('should treat an uppercase source extension as the same format', async () => {
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

	it('should refuse an uppercase same-format conversion without a mono mode', async () => {
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

	it('should abort when the target file already exists', async () => {
		(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);

		const outcome = await service.convert(createRequest(), jest.fn());

		expect(outcome).toEqual({ status: 'aborted' });
		expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		expect(
			getNotices().some((message) => message.includes('already exists')),
		).toBe(true);
	});

	it('should abort with a notice when the pipeline fails', async () => {
		(mockApp.vault.adapter.readBinary as jest.Mock).mockRejectedValue(
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

	it('should report partial success when the source cannot be deleted', async () => {
		(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValue(
			new Error('locked'),
		);

		const outcome = await service.convert(
			createRequest({ deleteSource: true }),
			jest.fn(),
		);

		expect(outcome).toEqual({ status: 'partial' });
	});
});
