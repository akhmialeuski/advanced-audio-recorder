/**
 * Unit tests for SplitModal module.
 * @module tests/unit/SplitModal.test
 */
/** @jest-environment jsdom */

import { SplitModal } from '../../src/ui/SplitModal';
import { App, Notice, TFile } from 'obsidian';
import { createWavHeader } from '../../src/recording/WavEncoder';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting HTMLElement with Obsidian DOM methods
	(el as any).setText = function (text: string) {
		this.textContent = text;
	};
	return el;
}

/** Captured UI control handlers, filled while onOpen runs. */
const mockCapturedControls = {
	sliders: [] as ((value: number) => void)[],
	texts: [] as ((value: string) => void)[],
	toggles: [] as ((value: boolean) => void)[],
	dropdowns: [] as ((value: string) => void)[],
	buttons: [] as { click: () => void; setDisabled: jest.Mock }[],
};

// Mock obsidian with interactive Setting components so that the
// onChange/onClick wiring inside onOpen can be exercised by tests
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
	Setting: jest.fn().mockImplementation(() => {
		const chain = {
			setName: jest.fn(),
			setDesc: jest.fn(),
			setHeading: jest.fn(),
			addSlider: jest.fn(),
			addText: jest.fn(),
			addToggle: jest.fn(),
			addDropdown: jest.fn(),
			addButton: jest.fn(),
		};
		chain.setName.mockReturnValue(chain);
		chain.setDesc.mockReturnValue(chain);
		chain.setHeading.mockReturnValue(chain);
		chain.addSlider.mockImplementation((cb: (slider: unknown) => void) => {
			const slider = {
				setLimits: jest.fn(),
				setValue: jest.fn(),
				setDynamicTooltip: jest.fn(),
				onChange: jest.fn((handler: (value: number) => void) => {
					mockCapturedControls.sliders.push(handler);
					return slider;
				}),
			};
			slider.setLimits.mockReturnValue(slider);
			slider.setValue.mockReturnValue(slider);
			slider.setDynamicTooltip.mockReturnValue(slider);
			cb(slider);
			return chain;
		});
		chain.addText.mockImplementation((cb: (text: unknown) => void) => {
			const text = {
				setPlaceholder: jest.fn(),
				setValue: jest.fn(),
				onChange: jest.fn((handler: (value: string) => void) => {
					mockCapturedControls.texts.push(handler);
					return text;
				}),
			};
			text.setPlaceholder.mockReturnValue(text);
			text.setValue.mockReturnValue(text);
			cb(text);
			return chain;
		});
		chain.addToggle.mockImplementation((cb: (toggle: unknown) => void) => {
			const toggle = {
				setValue: jest.fn(),
				onChange: jest.fn((handler: (value: boolean) => void) => {
					mockCapturedControls.toggles.push(handler);
					return toggle;
				}),
			};
			toggle.setValue.mockReturnValue(toggle);
			cb(toggle);
			return chain;
		});
		chain.addDropdown.mockImplementation(
			(cb: (dropdown: unknown) => void) => {
				const dropdown = {
					addOption: jest.fn(),
					setValue: jest.fn(),
					onChange: jest.fn((handler: (value: string) => void) => {
						mockCapturedControls.dropdowns.push(handler);
						return dropdown;
					}),
				};
				dropdown.addOption.mockReturnValue(dropdown);
				dropdown.setValue.mockReturnValue(dropdown);
				cb(dropdown);
				return chain;
			},
		);
		chain.addButton.mockImplementation((cb: (button: unknown) => void) => {
			const setDisabled = jest.fn();
			const button = {
				setButtonText: jest.fn(),
				setCta: jest.fn(),
				setDisabled,
				onClick: jest.fn((handler: () => void) => {
					mockCapturedControls.buttons.push({
						click: handler,
						setDisabled,
					});
					return button;
				}),
			};
			button.setButtonText.mockReturnValue(button);
			button.setCta.mockReturnValue(button);
			cb(button);
			return chain;
		});
		return chain;
	}),
	TFile: jest.fn(),
	normalizePath: (path: string) =>
		path.replace(/\\/g, '/').replace(/\/+/g, '/'),
}));

// Mock AudioEncoder
jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
	getEncoderDescription: jest.fn().mockReturnValue('Test Encoder'),
}));

// Mock AudioCapabilityDetector
jest.mock('../../src/recording/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000, 256000, 320000]),
}));

// Mock the decoder: the compressed path decodes once via this function
jest.mock('../../src/recording/AudioFormatConverter', () => ({
	decodeAudioDataAtNativeRate: jest.fn(),
}));

// Mock the vault-wide link updater
jest.mock('../../src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue(1),
}));

import { encodeAudioBuffer } from '../../src/recording/AudioEncoder';
import { decodeAudioDataAtNativeRate } from '../../src/recording/AudioFormatConverter';
import { updateLinksInVault } from '../../src/utils/LinkUpdater';

/** WAV header size produced by createWavHeader. */
const WAV_HEADER_SIZE = 44;

/**
 * Builds a complete in-memory WAV file for the lossless split path.
 */
function buildTestWav(
	numChannels: number,
	sampleRate: number,
	dataBytes: number,
): ArrayBuffer {
	const header = createWavHeader(numChannels, sampleRate, dataBytes);
	const wav = new Uint8Array(WAV_HEADER_SIZE + dataBytes);
	wav.set(new Uint8Array(header), 0);
	return wav.buffer;
}

/** Typed access to the private split pipeline. */
interface SplitModalInternals {
	runSplit(progressEl: HTMLElement): Promise<void>;
	partMinutes: number;
	partSuffix: string;
	deleteSource: boolean;
	linkAction: string;
}

function internals(modal: SplitModal): SplitModalInternals {
	return modal as unknown as SplitModalInternals;
}

if (!Blob.prototype.arrayBuffer) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill
	(Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(8));
	};
}

describe('SplitModal', () => {
	let mockApp: App;
	let mockFile: TFile;
	let progressEl: HTMLElement;
	const mockSettings = {
		splitChunkMinutes: 1,
		splitPartSuffix: 'part',
		bitrate: 128000,
		deleteSourceAfterSplit: false,
	} as unknown as AudioRecorderSettings;

	/**
	 * Configures the mock file as a WAV in a subdirectory.
	 */
	function configureFile(name: string, extension: string): void {
		const basename = name.replace(`.${extension}`, '');
		Object.defineProperty(mockFile, 'name', {
			value: name,
			configurable: true,
		});
		Object.defineProperty(mockFile, 'basename', {
			value: basename,
			configurable: true,
		});
		Object.defineProperty(mockFile, 'extension', {
			value: extension,
			configurable: true,
		});
		Object.defineProperty(mockFile, 'path', {
			value: `Recordings/${name}`,
			configurable: true,
		});
		Object.defineProperty(mockFile, 'parent', {
			value: { path: 'Recordings' },
			configurable: true,
		});
	}

	beforeEach(() => {
		jest.clearAllMocks();
		mockCapturedControls.sliders.length = 0;
		mockCapturedControls.texts.length = 0;
		mockCapturedControls.toggles.length = 0;
		mockCapturedControls.dropdowns.length = 0;
		mockCapturedControls.buttons.length = 0;

		// activeWindow is an Obsidian global; map it to the jsdom window
		(global as Record<string, unknown>).activeWindow = window;

		mockApp = {
			vault: {
				adapter: {
					readBinary: jest.fn(),
					exists: jest.fn().mockResolvedValue(false),
					remove: jest.fn().mockResolvedValue(undefined),
				},
				createBinary: jest.fn().mockResolvedValue(undefined),
			},
			fileManager: {
				trashFile: jest.fn().mockResolvedValue(undefined),
			},
		} as unknown as App;

		mockFile = new TFile();
		configureFile('recording.wav', 'wav');

		progressEl = addObsidianDomMethods(document.createElement('div'));
	});

	it('should instantiate with defaults from settings', () => {
		const modal = new SplitModal(mockApp, mockFile, mockSettings);

		expect(internals(modal).partMinutes).toBe(1);
		expect(internals(modal).partSuffix).toBe('part');
		expect(internals(modal).deleteSource).toBe(false);
		expect(internals(modal).linkAction).toBe('replace');
	});

	it('should fall back to the default suffix for an invalid configured suffix', () => {
		const modal = new SplitModal(mockApp, mockFile, {
			...mockSettings,
			splitPartSuffix: 'bad/suffix',
		} as unknown as AudioRecorderSettings);

		expect(internals(modal).partSuffix).toBe('part');
	});

	it('should render source file info on open and clear on close', () => {
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		const source = modal.contentEl.querySelector('.aar-split-source');
		expect(source?.textContent).toContain('recording.wav');

		modal.onClose();
		expect(modal.contentEl.children.length).toBe(0);
	});

	it('should update split options from UI controls', () => {
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		// WAV source: one slider, one suffix text, one delete toggle,
		// one link-action dropdown (no bitrate dropdown)
		expect(mockCapturedControls.dropdowns).toHaveLength(1);

		mockCapturedControls.sliders[0](5);
		expect(internals(modal).partMinutes).toBe(5);

		mockCapturedControls.texts[0]('seg');
		expect(internals(modal).partSuffix).toBe('seg');

		mockCapturedControls.toggles[0](true);
		expect(internals(modal).deleteSource).toBe(true);

		mockCapturedControls.dropdowns[0]('after');
		expect(internals(modal).linkAction).toBe('after');
	});

	it('should show the bitrate dropdown only for compressed sources', () => {
		configureFile('recording.webm', 'webm');
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		// Compressed source: bitrate dropdown plus link-action dropdown
		expect(mockCapturedControls.dropdowns).toHaveLength(2);

		mockCapturedControls.dropdowns[0]('192000');
		expect((modal as unknown as { bitrate: number }).bitrate).toBe(192000);
	});

	it('should run the split when the split button is clicked', async () => {
		(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
			buildTestWav(1, 1000, 250000),
		);
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		const button = mockCapturedControls.buttons[0];
		button.click();
		// The click handler runs the async pipeline in the background
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(3);
		expect(button.setDisabled).toHaveBeenCalledWith(true);
		expect(button.setDisabled).toHaveBeenLastCalledWith(false);
	});

	describe('WAV fast path', () => {
		beforeEach(() => {
			// 1000 Hz mono 16-bit: byteRate 2000 B/s; 1-minute part = 120000 B
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				buildTestWav(1, 1000, 250000),
			);
		});

		it('should split WAV bytes without decoding', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(decodeAudioDataAtNativeRate).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(3);
			const paths = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.map((call: unknown[]) => call[0]);
			expect(paths).toEqual([
				'Recordings/recording-part1.wav',
				'Recordings/recording-part2.wav',
				'Recordings/recording-part3.wav',
			]);
		});

		it('should write standalone WAV parts with patched sizes', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			const calls = (mockApp.vault.createBinary as jest.Mock).mock
				.calls as [string, ArrayBuffer][];
			const firstPart = calls[0][1];
			const lastPart = calls[2][1];
			expect(firstPart.byteLength).toBe(WAV_HEADER_SIZE + 120000);
			expect(lastPart.byteLength).toBe(WAV_HEADER_SIZE + 10000);
			expect(new DataView(lastPart).getUint32(40, true)).toBe(10000);
		});

		it('should update links in the vault with all part names', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).toHaveBeenCalledWith(
				mockApp,
				mockFile,
				[
					'recording-part1.wav',
					'recording-part2.wav',
					'recording-part3.wav',
				],
				'replace',
			);
		});

		it('should not update links for the none action', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).linkAction = 'none';

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).not.toHaveBeenCalled();
		});

		it('should not delete the source by default', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		});

		it('should delete the source only after all parts are written', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				mockFile,
			);
			const lastWriteOrder = Math.max(
				...(mockApp.vault.createBinary as jest.Mock).mock
					.invocationCallOrder,
			);
			const trashOrder = (mockApp.fileManager.trashFile as jest.Mock).mock
				.invocationCallOrder[0];
			expect(trashOrder).toBeGreaterThan(lastWriteOrder);
		});

		it('should abort when a target part file already exists', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockImplementation(
				(path: string) =>
					Promise.resolve(path === 'Recordings/recording-part2.wav'),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('already exists'),
			);
		});

		it('should abort when the file is shorter than one part', async () => {
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				buildTestWav(1, 1000, 60000),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'File is shorter than one part.',
			);
		});

		it('should remove written parts and keep the source when a write fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('disk full'));
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.adapter.remove).toHaveBeenCalledWith(
				'Recordings/recording-part1.wav',
			);
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Split failed'),
			);
		});

		it('should write parts next to a file in the vault root', async () => {
			Object.defineProperty(mockFile, 'parent', {
				value: null,
				configurable: true,
			});
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'recording-part1.wav',
				expect.anything(),
			);
		});

		it('should stringify non-Error failures', async () => {
			(mockApp.vault.adapter.readBinary as jest.Mock).mockRejectedValue(
				'raw failure',
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith('Split failed: raw failure');
		});

		it('should log and continue when rollback of a written part fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('disk full'));
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const consoleSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {});
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(consoleSpy).toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Split failed'),
			);
			consoleSpy.mockRestore();
		});
	});

	describe('compressed path', () => {
		beforeEach(() => {
			configureFile('recording.webm', 'webm');
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				new ArrayBuffer(100),
			);
			// 150 s at 44100 Hz with 1-minute parts -> 3 parts
			(decodeAudioDataAtNativeRate as jest.Mock).mockResolvedValue(
				createMockAudioBuffer(1, 150 * 44100, 44100),
			);
			(global as Record<string, unknown>).AudioBuffer = class {
				numberOfChannels: number;
				length: number;
				sampleRate: number;
				constructor(options: {
					numberOfChannels: number;
					length: number;
					sampleRate: number;
				}) {
					this.numberOfChannels = options.numberOfChannels;
					this.length = options.length;
					this.sampleRate = options.sampleRate;
				}
				copyToChannel = jest.fn();
				getChannelData = jest.fn(() => new Float32Array(this.length));
			};
		});

		it('should decode once and encode each part', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(decodeAudioDataAtNativeRate).toHaveBeenCalledTimes(1);
			expect(encodeAudioBuffer).toHaveBeenCalledTimes(3);
			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.objectContaining({ length: 60 * 44100 }),
				{ format: 'webm', bitrate: 128000 },
			);
			const paths = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.map((call: unknown[]) => call[0]);
			expect(paths).toEqual([
				'Recordings/recording-part1.webm',
				'Recordings/recording-part2.webm',
				'Recordings/recording-part3.webm',
			]);
		});

		it('should abort when the audio is shorter than one part', async () => {
			(decodeAudioDataAtNativeRate as jest.Mock).mockResolvedValue(
				createMockAudioBuffer(1, 30 * 44100, 44100),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'File is shorter than one part.',
			);
		});

		it('should fall back to WAV when the source format cannot be encoded', async () => {
			const { isOfflineEncodingSupported } = jest.requireMock(
				'../../src/recording/AudioEncoder',
			);
			(isOfflineEncodingSupported as jest.Mock).mockReturnValue(false);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(encodeAudioBuffer).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ format: 'wav' }),
			);
			const paths = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.map((call: unknown[]) => call[0]);
			expect(paths[0]).toBe('Recordings/recording-part1.wav');
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('parts are saved as WAV'),
			);
		});

		it('should report errors from decoding', async () => {
			(decodeAudioDataAtNativeRate as jest.Mock).mockRejectedValue(
				new Error('decode failed'),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Split failed: decode failed'),
			);
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});
	});
});
