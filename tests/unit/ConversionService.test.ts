/**
 * Unit tests for ConversionService module. The full pipeline is also
 * exercised end-to-end through the ConversionModal suite; this suite
 * covers the service-level contract.
 * @module tests/unit/ConversionService.test
 */
/** @jest-environment jsdom */

import { ConversionService } from '../../src/recording/ConversionService';
import type { ConversionRequest } from '../../src/recording/ConversionService';
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

jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/wav' })),
}));

jest.mock('../../src/recording/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({}),
	convertBlobToFormat: jest
		.fn()
		.mockResolvedValue(new Blob(['converted'], { type: 'audio/webm' })),
}));

jest.mock('../../src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 0,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill for jsdom
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	};
}

const createSourceFile = (): TFile => {
	const file = new TFile();
	Object.assign(file, {
		path: 'Audio/recording.wav',
		name: 'recording.wav',
		basename: 'recording',
		extension: 'wav',
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
		});
		expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
			'Audio/recording.webm',
			expect.any(ArrayBuffer),
		);
	});

	it('should use the decode-and-encode path for WAV targets', async () => {
		const { decodeAudioBlob } = jest.requireMock(
			'../../src/recording/AudioFormatConverter',
		);
		const { encodeAudioBuffer } = jest.requireMock(
			'../../src/recording/AudioEncoder',
		);

		await service.convert(
			createRequest({ targetFormat: 'wav' }),
			jest.fn(),
		);

		expect(decodeAudioBlob).toHaveBeenCalled();
		expect(encodeAudioBuffer).toHaveBeenCalledWith(
			expect.anything(),
			{ format: 'wav', bitrate: 128000 },
			expect.any(Function),
		);
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
