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
	Notice: jest.fn(),
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

// Mock AudioEncoder
jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/mp3' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
	getEncoderDescription: jest.fn().mockReturnValue('Test Encoder'),
}));

// Mock AudioCapabilityDetector
jest.mock('../../src/recording/AudioCapabilityDetector', () => ({
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

describe('ConversionModal', () => {
	let mockApp: App;
	let mockFile: TFile;

	beforeEach(() => {
		jest.clearAllMocks();

		mockApp = {
			vault: {
				adapter: {
					readBinary: jest
						.fn()
						.mockResolvedValue(new ArrayBuffer(100)),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
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
});
