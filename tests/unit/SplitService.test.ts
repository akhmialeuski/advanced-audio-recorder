/**
 * Unit tests for SplitService module. The full pipeline is also
 * exercised end-to-end through the SplitModal suite; this suite covers
 * the service-level contract.
 * @module tests/unit/SplitService.test
 */

import { SplitService } from 'src/recording/SplitService';
import type { SplitRequest } from 'src/recording/SplitService';
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
		jest.clearAllMocks();
		createdFiles = [];
		mockApp = {
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
		} as unknown as App;
		service = new SplitService(mockApp);
	});

	describe('getTargetExtension', () => {
		it('should keep WAV sources as WAV', () => {
			expect(service.getTargetExtension(createSourceFile('wav'))).toBe(
				'wav',
			);
		});

		it('should keep encodable compressed formats', () => {
			expect(service.getTargetExtension(createSourceFile('mp3'))).toBe(
				'mp3',
			);
		});

		it('should fall back to WAV for unencodable formats', () => {
			expect(service.getTargetExtension(createSourceFile('aiff'))).toBe(
				'wav',
			);
		});
	});

	describe('split', () => {
		it('should write all parts and complete', async () => {
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

		it('should abort on a name collision before writing anything', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);

			const outcome = await service.split(createRequest(), jest.fn());

			expect(outcome).toEqual({ status: 'aborted' });
			expect(createdFiles).toEqual([]);
			const { Notice } = jest.requireMock('obsidian');
			expect(
				(Notice as jest.Mock).mock.calls.some((call) =>
					String(call[0]).includes('already exists'),
				),
			).toBe(true);
		});

		it('should report partial success when the source cannot be deleted', async () => {
			(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);

			const outcome = await service.split(
				createRequest({ deleteSource: true }),
				jest.fn(),
			);

			expect(outcome).toEqual({ status: 'partial' });
			expect(createdFiles).toHaveLength(2);
		});

		it('should abort with a notice when reading the source fails', async () => {
			(mockApp.vault.adapter.readBinary as jest.Mock).mockRejectedValue(
				new Error('missing'),
			);
			const onProgress = jest.fn();

			const outcome = await service.split(createRequest(), onProgress);

			expect(outcome).toEqual({ status: 'aborted' });
			expect(onProgress).toHaveBeenCalledWith('Error: missing');
		});
	});
});
