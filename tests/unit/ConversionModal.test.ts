/**
 * Unit tests for ConversionModal module.
 * @module tests/unit/ConversionModal.test
 */
/** @jest-environment jsdom */

import { ConversionModal } from '../../src/ui/ConversionModal';
import { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from '../../src/settings/Settings';

/**
 * Extends an HTMLElement with Obsidian's custom DOM methods.
 */
function addObsidianDomMethods(el: HTMLElement): HTMLElement {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
	(el as any).empty = function () {
		while (this.firstChild) {
			this.removeChild(this.firstChild);
		}
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
	(el as any).createEl = function (
		tag: string,
		opts?: { text?: string; cls?: string; attr?: Record<string, string> },
	) {
		const child = document.createElement(tag);
		if (opts?.text) child.textContent = opts.text;
		if (opts?.cls) child.className = opts.cls;
		if (opts?.attr) {
			for (const [k, v] of Object.entries(opts.attr)) {
				child.setAttribute(k, v);
			}
		}
		addObsidianDomMethods(child);
		this.appendChild(child);
		return child;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
	(el as any).createDiv = function (opts?: { cls?: string }) {
		return this.createEl('div', opts);
	};
	return el;
}

/** Captured Notice instances for assertions on setMessage/hide. */
interface NoticeInstance {
	message: string;
	timeout?: number;
	setMessage: jest.Mock;
	hide: jest.Mock;
}
const noticeInstances: NoticeInstance[] = [];

// Mock obsidian
jest.mock('obsidian', () => ({
	App: jest.fn(),
	Modal: class {
		app: unknown;
		contentEl: HTMLElement;
		constructor(app: unknown) {
			this.app = app;
			this.contentEl = addObsidianDomMethods(
				document.createElement('div'),
			);
		}
		open = jest.fn();
		close = jest.fn();
	},
	Notice: jest.fn().mockImplementation(function (
		message: string,
		timeout?: number,
	) {
		const instance = {
			message,
			timeout,
			setMessage: jest.fn(),
			hide: jest.fn(),
		};
		noticeInstances.push(instance);
		return instance;
	}),
	normalizePath: (path: string) => path.replace(/\\/g, '/'),
	Setting: jest.fn().mockImplementation(() => ({
		setName: jest.fn().mockReturnThis(),
		setDesc: jest.fn().mockReturnThis(),
		setHeading: jest.fn().mockReturnThis(),
		addDropdown: jest.fn().mockReturnThis(),
		addButton: jest.fn().mockReturnThis(),
		addToggle: jest.fn().mockReturnThis(),
	})),
	TFile: jest.fn(),
}));

// Mock LinkUpdater: the vault-wide rewrite has its own suite
jest.mock('../../src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 1,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

// Mock AudioFormatConverter: conversion pipelines have their own suite
jest.mock('../../src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({}),
	convertBlobToFormat: jest
		.fn()
		.mockResolvedValue(new Blob(['converted'], { type: 'audio/webm' })),
}));

// Mock AudioEncoder
jest.mock('../../src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
	getEncoderDescription: jest.fn().mockReturnValue('Test Encoder'),
}));

// Mock AudioCapabilityDetector
jest.mock('../../src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000, 256000, 320000]),
	getSupportedSampleRates: jest
		.fn()
		.mockReturnValue([8000, 16000, 22050, 44100, 48000]),
}));

const mockSettings = {
	deleteSourceAfterConversion: true,
	conversionLinkAction: 'replace',
};

// Polyfill Blob.prototype.arrayBuffer for jsdom
if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill for jsdom
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	};
}

describe('ConversionModal', () => {
	let mockApp: App;
	let mockFile: TFile;
	let createdFile: { path: string };

	beforeEach(() => {
		jest.clearAllMocks();
		noticeInstances.length = 0;

		createdFile = { path: 'Recordings/recording.webm' };
		mockApp = {
			vault: {
				adapter: {
					exists: jest.fn().mockResolvedValue(false),
					readBinary: jest
						.fn()
						.mockResolvedValue(new ArrayBuffer(100)),
				},
				createBinary: jest.fn().mockResolvedValue(createdFile),
			},
			fileManager: {
				trashFile: jest.fn().mockResolvedValue(undefined),
			},
		} as unknown as App;

		mockFile = new TFile();
		Object.defineProperty(mockFile, 'name', { value: 'recording.wav' });
		Object.defineProperty(mockFile, 'basename', { value: 'recording' });
		Object.defineProperty(mockFile, 'extension', { value: 'wav' });
		Object.defineProperty(mockFile, 'path', {
			value: 'Recordings/recording.wav',
		});
		Object.defineProperty(mockFile, 'parent', {
			value: { path: 'Recordings' },
		});
	});

	it('should instantiate with source file', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			mockSettings as unknown as AudioRecorderSettings,
		);
		expect(modal).toBeDefined();
	});

	it('should set up content on open', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			mockSettings as unknown as AudioRecorderSettings,
		);
		modal.onOpen();

		// Heading is rendered via Setting.setHeading(); source file info is a <p>
		const source = modal.contentEl.querySelector('.aar-conversion-source');
		expect(source).not.toBeNull();
		expect(source?.textContent).toContain('recording.wav');
	});

	it('should show source file name', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			mockSettings as unknown as AudioRecorderSettings,
		);
		modal.onOpen();

		const source = modal.contentEl.querySelector('.aar-conversion-source');
		expect(source?.textContent).toContain('recording.wav');
	});

	it('should clear content on close', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			mockSettings as unknown as AudioRecorderSettings,
		);
		modal.onOpen();
		modal.onClose();

		expect(modal.contentEl.children.length).toBe(0);
	});

	describe('runConversion', () => {
		const runConversion = (
			modal: ConversionModal,
			progressEl: HTMLElement,
		): Promise<void> =>
			(
				modal as unknown as {
					runConversion(el: HTMLElement): Promise<void>;
				}
			).runConversion(progressEl);

		const createModal = (
			settings: Partial<AudioRecorderSettings> = {},
		): { modal: ConversionModal; progressEl: HTMLElement } => {
			const modal = new ConversionModal(mockApp, mockFile, {
				...mockSettings,
				...settings,
			} as unknown as AudioRecorderSettings);
			modal.onOpen();
			// The Setting mock never invokes dropdown callbacks, so the
			// format selection from onOpen does not run; pick the target
			// format directly like the dropdown would
			(modal as unknown as { targetFormat: string }).targetFormat =
				'webm';
			const progressEl = document.createElement('div');
			addObsidianDomMethods(progressEl);
			(progressEl as unknown as Record<string, unknown>).setText = (
				text: string,
			): void => {
				progressEl.textContent = text;
			};
			return { modal, progressEl };
		};

		it('should update links vault-wide with the created file', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'../../src/utils/LinkUpdater',
			);
			const { modal, progressEl } = createModal();

			await runConversion(modal, progressEl);

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'Recordings/recording.webm',
				expect.any(ArrayBuffer),
			);
			expect(updateLinksInVault).toHaveBeenCalledWith(
				mockApp,
				mockFile,
				[createdFile],
				'replace',
			);
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				mockFile,
			);
		});

		it('should keep the source when some links could not be updated', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'../../src/utils/LinkUpdater',
			);
			updateLinksInVault.mockResolvedValueOnce({
				updatedNotes: 1,
				skippedReferences: 2,
				frontmatterReferences: 0,
			});
			const { modal, progressEl } = createModal();

			await runConversion(modal, progressEl);

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(
				noticeInstances.some((n) =>
					n.message.includes('Source file kept'),
				),
			).toBe(true);
		});

		it('should report frontmatter links that stay on the source', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'../../src/utils/LinkUpdater',
			);
			updateLinksInVault.mockResolvedValueOnce({
				updatedNotes: 0,
				skippedReferences: 0,
				frontmatterReferences: 1,
			});
			const { modal, progressEl } = createModal();

			await runConversion(modal, progressEl);

			expect(
				noticeInstances.some((n) =>
					n.message.includes('frontmatter link'),
				),
			).toBe(true);
		});

		it('should skip link updates and deletion for the none action', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'../../src/utils/LinkUpdater',
			);
			const { modal, progressEl } = createModal({
				conversionLinkAction: 'none',
				deleteSourceAfterConversion: false,
			});

			await runConversion(modal, progressEl);

			expect(updateLinksInVault).not.toHaveBeenCalled();
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		});

		it('should show a background notice when closed mid-conversion', async () => {
			const { convertBlobToFormat } = jest.requireMock(
				'../../src/audio/AudioFormatConverter',
			);
			let resolveConversion: (blob: Blob) => void = () => undefined;
			convertBlobToFormat.mockReturnValueOnce(
				new Promise<Blob>((resolve) => {
					resolveConversion = resolve;
				}),
			);
			const { modal, progressEl } = createModal();

			const conversionPromise = runConversion(modal, progressEl);
			// Let the pipeline reach the hanging conversion step
			await new Promise((resolve) => setTimeout(resolve, 0));

			modal.onClose();

			const background = noticeInstances.find((n) =>
				n.message.includes('continues in the background'),
			);
			expect(background).toBeDefined();
			expect(background?.timeout).toBe(0);

			resolveConversion(new Blob(['converted']));
			await conversionPromise;

			// Progress was mirrored into the notice and it was hidden
			expect(background?.setMessage).toHaveBeenCalled();
			expect(background?.hide).toHaveBeenCalled();
		});

		it('should not show a background notice when closed while idle', () => {
			const { modal } = createModal();

			modal.onClose();

			expect(
				noticeInstances.some((n) =>
					n.message.includes('continues in the background'),
				),
			).toBe(false);
		});
	});
});
