/**
 * Unit tests for ConversionModal module.
 * @module tests/unit/ConversionModal.test
 */

import { ConversionModal } from 'src/ui/ConversionModal';
import { App, TFile } from 'obsidian';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { tick } from '../helpers/async';
import { capturedSettings } from '../helpers/captureSettings';
import { noticeInstances, noticeText } from '../mocks/obsidian';

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

// The full obsidian mock with only Setting swapped for the recording double.
// The previous inline mock stubbed Setting out entirely - its add* methods
// never called back - so half of this dialog's wiring never ran under test.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

// Mock LinkUpdater: the vault-wide rewrite has its own suite
jest.mock('src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 1,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

// Mock AudioFormatConverter: conversion pipelines have their own suite
jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn().mockResolvedValue({}),
	convertBlobToFormatBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
}));

// Mock AudioEncoder
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
}));

// Mock AudioCapabilityDetector
jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000, 256000, 320000]),
	getSupportedSampleRates: jest
		.fn()
		.mockReturnValue([8000, 16000, 22050, 44100, 48000]),
}));

// Real settings rather than a two-field cast: the dialog seeds format,
// bitrate, and link action from them, so a partial fixture only type-checks
// by lying about what the modal actually reads.
const mockSettings = mergeSettings({
	deleteSourceAfterConversion: true,
	conversionLinkAction: 'replace',
});

describe('ConversionModal', () => {
	let mockApp: App;
	let mockFile: TFile;
	let createdFile: { path: string };

	beforeEach(() => {
		capturedSettings.length = 0;

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
			() => mockSettings,
		);
		expect(modal).toBeDefined();
	});

	it('initializes the channel preset through named options', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			() => mockSettings,
			{
				initialChannelMode: 'mono-right',
			},
		);

		expect((modal as unknown as { channelMode: string }).channelMode).toBe(
			'mono-right',
		);
	});

	it('should set up content on open', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			() => mockSettings,
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
			() => mockSettings,
		);
		modal.onOpen();

		const source = modal.contentEl.querySelector('.aar-conversion-source');
		expect(source?.textContent).toContain('recording.wav');
	});

	it('should clear content on close', () => {
		const modal = new ConversionModal(
			mockApp,
			mockFile,
			() => mockSettings,
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
			const modal = new ConversionModal(mockApp, mockFile, () => ({
				...mockSettings,
				...settings,
			}));
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
				'src/utils/LinkUpdater',
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
				'src/utils/LinkUpdater',
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
					noticeText(n).includes('Source file kept'),
				),
			).toBe(true);
		});

		it('should report frontmatter links that stay on the source', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'src/utils/LinkUpdater',
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
					noticeText(n).includes('frontmatter link'),
				),
			).toBe(true);
		});

		it('should skip link updates and deletion for the none action', async () => {
			const { updateLinksInVault } = jest.requireMock(
				'src/utils/LinkUpdater',
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
			const { convertBlobToFormatBuffer } = jest.requireMock(
				'src/audio/AudioFormatConverter',
			);
			let resolveConversion: (data: ArrayBuffer) => void = () =>
				undefined;
			convertBlobToFormatBuffer.mockReturnValueOnce(
				new Promise<ArrayBuffer>((resolve) => {
					resolveConversion = resolve;
				}),
			);
			const { modal, progressEl } = createModal();

			const conversionPromise = runConversion(modal, progressEl);
			// Let the pipeline reach the hanging conversion step
			await tick();

			modal.onClose();

			const background = noticeInstances.find((n) =>
				noticeText(n).includes('continues in the background'),
			);
			expect(background).toBeDefined();
			expect(background?.timeout).toBe(0);

			resolveConversion(new ArrayBuffer(8));
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
					noticeText(n).includes('continues in the background'),
				),
			).toBe(false);
		});

		it('should pass the selected channel mode into the conversion', async () => {
			const { convertBlobToFormatBuffer } = jest.requireMock(
				'src/audio/AudioFormatConverter',
			);
			const { modal, progressEl } = createModal();
			(modal as unknown as { channelMode: string }).channelMode =
				'mono-left';

			await runConversion(modal, progressEl);

			expect(convertBlobToFormatBuffer).toHaveBeenCalledWith(
				expect.any(Blob),
				'webm',
				expect.any(Number),
				expect.any(Function),
				expect.objectContaining({ channelMode: 'mono-left' }),
			);
		});
	});

	describe('target format options', () => {
		/** Dropdown double capturing the rebuilt option list. */
		interface DropdownDouble {
			selectEl: { empty: jest.Mock };
			addOption: jest.Mock;
			setValue: jest.Mock;
		}

		const withFormatDropdown = (modal: ConversionModal): DropdownDouble => {
			const dropdown: DropdownDouble = {
				selectEl: { empty: jest.fn() },
				addOption: jest.fn(),
				setValue: jest.fn(),
			};
			(
				modal as unknown as { formatDropdown: DropdownDouble }
			).formatDropdown = dropdown;
			return dropdown;
		};

		const rebuild = (modal: ConversionModal): void => {
			(
				modal as unknown as { rebuildFormatOptions(): void }
			).rebuildFormatOptions();
		};

		const offeredFormats = (dropdown: DropdownDouble): string[] =>
			dropdown.addOption.mock.calls.map((call) => String(call[0]));

		it('excludes the source format for channel-preserving conversions', () => {
			const modal = new ConversionModal(
				mockApp,
				mockFile,
				() => mockSettings,
			);
			const dropdown = withFormatDropdown(modal);

			rebuild(modal);

			expect(offeredFormats(dropdown)).not.toContain('wav');
		});

		it('offers the source format for mono downmixes', () => {
			const modal = new ConversionModal(
				mockApp,
				mockFile,
				() => mockSettings,
			);
			(modal as unknown as { channelMode: string }).channelMode =
				'mono-mix';
			const dropdown = withFormatDropdown(modal);

			rebuild(modal);

			expect(offeredFormats(dropdown)).toContain('wav');
		});

		it('falls back to the first offered format when the selection disappears', () => {
			const modal = new ConversionModal(
				mockApp,
				mockFile,
				() => mockSettings,
			);
			(modal as unknown as { targetFormat: string }).targetFormat = 'wav';
			const dropdown = withFormatDropdown(modal);

			// Channel mode is 'source', so wav (the source format) is gone
			rebuild(modal);

			expect(
				(modal as unknown as { targetFormat: string }).targetFormat,
			).not.toBe('wav');
			expect(dropdown.setValue).toHaveBeenCalledWith(
				(modal as unknown as { targetFormat: string }).targetFormat,
			);
		});

		it('keeps the current selection when it is still offered', () => {
			const modal = new ConversionModal(
				mockApp,
				mockFile,
				() => mockSettings,
			);
			(modal as unknown as { targetFormat: string }).targetFormat = 'mp3';
			const dropdown = withFormatDropdown(modal);

			rebuild(modal);

			expect(dropdown.setValue).toHaveBeenCalledWith('mp3');
		});
	});
});
