/**
 * Unit tests for SplitModal module.
 * @module tests/unit/SplitModal.test
 */

import { SplitModal } from 'src/ui/SplitModal';
import { App, Notice, TFile } from 'obsidian';
import { createWavHeader } from 'src/audio/WavEncoder';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

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
	textInputs: [] as { toggleClass: jest.Mock }[],
	toggles: [] as ((value: boolean) => void)[],
	dropdowns: [] as ((value: string) => void)[],
	buttons: [] as { click: () => void; setDisabled: jest.Mock }[],
};

// Mock obsidian with interactive Setting components so that the
// onChange/onClick wiring inside onOpen can be exercised by tests
jest.mock('obsidian', () => ({
	App: jest.fn(),
	Platform: { isMobile: false, isMobileApp: false },
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
	// Notice instances expose the methods used by the background
	// progress notice (setMessage/hide)
	Notice: jest.fn().mockImplementation(() => ({
		setMessage: jest.fn(),
		hide: jest.fn(),
	})),
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
				// onChange validation feedback toggles a CSS class here
				inputEl: { toggleClass: jest.fn() },
				setPlaceholder: jest.fn(),
				setValue: jest.fn(),
				onChange: jest.fn((handler: (value: string) => void) => {
					mockCapturedControls.texts.push(handler);
					mockCapturedControls.textInputs.push(text.inputEl);
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
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest
		.fn()
		.mockResolvedValue(new Blob(['encoded'], { type: 'audio/webm' })),
	isOfflineEncodingSupported: jest.fn().mockReturnValue(true),
}));

// Mock AudioCapabilityDetector
jest.mock('src/audio/AudioCapabilityDetector', () => ({
	getSupportedBitrates: jest
		.fn()
		.mockReturnValue([64000, 96000, 128000, 192000, 256000, 320000]),
}));

// Mock the decoder: the compressed path decodes once via this function
jest.mock('src/audio/AudioFormatConverter', () => ({
	decodeAudioBlob: jest.fn(),
}));

// Mock the vault-wide link updater
jest.mock('src/utils/LinkUpdater', () => ({
	updateLinksInVault: jest.fn().mockResolvedValue({
		updatedNotes: 1,
		skippedReferences: 0,
		frontmatterReferences: 0,
	}),
}));

import { encodeAudioBuffer } from 'src/audio/AudioEncoder';
import { decodeAudioBlob } from 'src/audio/AudioFormatConverter';
import { updateLinksInVault } from 'src/utils/LinkUpdater';

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

/**
 * Creates a TFile instance (of the mocked class) for a created part path,
 * mirroring what vault.createBinary returns in production.
 */
function makePartFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split('/').pop() ?? path;
	return file;
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
	return modal;
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
		conversionLinkAction: 'replace',
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
		mockCapturedControls.textInputs.length = 0;
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
				// createBinary returns the created TFile, like the real vault
				createBinary: jest
					.fn()
					.mockImplementation((path: string) =>
						Promise.resolve(makePartFile(path)),
					),
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

	it('should seed the link action from the conversion link action setting', () => {
		const modal = new SplitModal(mockApp, mockFile, {
			...mockSettings,
			conversionLinkAction: 'after',
		});

		expect(internals(modal).linkAction).toBe('after');
	});

	it('should snap an unsupported configured bitrate to the closest option', () => {
		configureFile('recording.webm', 'webm');
		const modal = new SplitModal(mockApp, mockFile, {
			...mockSettings,
			bitrate: 100000,
		});
		modal.onOpen();

		expect((modal as unknown as { bitrate: number }).bitrate).toBe(96000);
	});

	it('should refresh the part name example when the suffix changes', () => {
		const { Setting } = jest.requireMock('obsidian');
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		const collectDescs = (): string[] =>
			(Setting as jest.Mock).mock.results.flatMap(
				(result: { value: { setDesc: jest.Mock } }) =>
					result.value.setDesc.mock.calls.map((call: unknown[]) =>
						String(call[0]),
					),
			);
		expect(collectDescs()).toContainEqual(
			expect.stringContaining('"recording-part1.wav"'),
		);

		mockCapturedControls.texts[0]('seg');
		expect(collectDescs()).toContainEqual(
			expect.stringContaining('"recording-seg1.wav"'),
		);
	});

	it('should show the WAV extension in the example when encoding falls back', () => {
		const { isOfflineEncodingSupported } = jest.requireMock(
			'src/audio/AudioEncoder',
		);
		(isOfflineEncodingSupported as jest.Mock).mockReturnValue(false);
		configureFile('recording.webm', 'webm');
		const { Setting } = jest.requireMock('obsidian');
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		const descs = (Setting as jest.Mock).mock.results.flatMap(
			(result: { value: { setDesc: jest.Mock } }) =>
				result.value.setDesc.mock.calls.map((call: unknown[]) =>
					String(call[0]),
				),
		);
		expect(descs).toContainEqual(
			expect.stringContaining('"recording-part1.wav"'),
		);
		(isOfflineEncodingSupported as jest.Mock).mockReturnValue(true);
	});

	it('should clear the progress text when aborting on a collision', async () => {
		(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
			buildTestWav(1, 1000, 250000),
		);
		(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
		const modal = new SplitModal(mockApp, mockFile, mockSettings);

		await internals(modal).runSplit(progressEl);

		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('already exists'),
		);
		expect(progressEl.textContent).toBe('');
	});

	it('should keep reporting progress in a notice when the modal closes mid-split', async () => {
		let resolveRead!: (bytes: ArrayBuffer) => void;
		(mockApp.vault.adapter.readBinary as jest.Mock).mockReturnValue(
			new Promise<ArrayBuffer>((resolve) => {
				resolveRead = resolve;
			}),
		);
		const modal = new SplitModal(mockApp, mockFile, mockSettings);

		const split = internals(modal).runSplit(progressEl);
		modal.onClose();
		// A repeated close must not spawn a second background notice
		modal.onClose();
		resolveRead(buildTestWav(1, 1000, 250000));
		await split;

		const backgroundNotices = (Notice as jest.Mock).mock.calls.filter(
			(call: unknown[]) =>
				String(call[0]).includes('continues in the background'),
		);
		expect(backgroundNotices).toHaveLength(1);
		const backgroundIndex = (Notice as jest.Mock).mock.calls.findIndex(
			(call: unknown[]) =>
				String(call[0]).includes('continues in the background'),
		);
		expect(backgroundIndex).toBeGreaterThanOrEqual(0);
		// The notice mirrors pipeline progress and is hidden at the end
		const notice = (Notice as jest.Mock).mock.results[backgroundIndex]
			.value as { setMessage: jest.Mock; hide: jest.Mock };
		expect(notice.setMessage).toHaveBeenCalledWith(
			expect.stringContaining('Writing part'),
		);
		expect(notice.hide).toHaveBeenCalled();
	});

	it.each([
		['an invalid configured suffix', 'bad/suffix', 'part'],
		['a blank configured suffix', '', 'part'],
		['a valid configured suffix (kept)', 'track', 'track'],
	])('normalizes %s', (_case, splitPartSuffix, expected) => {
		const modal = new SplitModal(mockApp, mockFile, {
			...mockSettings,
			splitPartSuffix,
		});

		expect(internals(modal).partSuffix).toBe(expected);
	});

	it.each([
		['an oversized duration', 10000, 180],
		['a non-finite duration', Number.NaN, 15],
		['a zero duration', 0, 1],
	])('clamps %s', (_case, splitChunkMinutes, expected) => {
		const modal = new SplitModal(mockApp, mockFile, {
			...mockSettings,
			splitChunkMinutes,
		});
		expect(internals(modal).partMinutes).toBe(expected);
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

	it.each([
		['an invalid suffix', 'bad/suffix', true],
		['a valid suffix', 'good-suffix', false],
		// Empty input is valid: it falls back to the default suffix
		['a blank suffix', '', false],
	])('toggles the invalid-input class for %s', (_case, input, invalid) => {
		const modal = new SplitModal(mockApp, mockFile, mockSettings);
		modal.onOpen();

		const handler = mockCapturedControls.texts[0];
		const inputEl = mockCapturedControls.textInputs[0];

		handler(input);
		expect(inputEl.toggleClass).toHaveBeenLastCalledWith(
			'aar-input-invalid',
			invalid,
		);
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
		// The click handler runs the async pipeline in the background;
		// the button is re-enabled in its finally block, so wait for that
		// instead of a fixed delay (slow under coverage instrumentation)
		for (let i = 0; i < 400; i++) {
			if (
				button.setDisabled.mock.calls.some(
					(call: unknown[]) => call[0] === false,
				)
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

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

			expect(decodeAudioBlob).not.toHaveBeenCalled();
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

		it('should update links in the vault with the created part files', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).toHaveBeenCalledWith(
				mockApp,
				mockFile,
				expect.arrayContaining([
					expect.objectContaining({
						path: 'Recordings/recording-part1.wav',
					}),
					expect.objectContaining({
						path: 'Recordings/recording-part2.wav',
					}),
					expect.objectContaining({
						path: 'Recordings/recording-part3.wav',
					}),
				]),
				'replace',
			);
			const partFiles = (updateLinksInVault as jest.Mock).mock
				.calls[0][2] as unknown[];
			expect(partFiles).toHaveLength(3);
			expect(partFiles.every((file) => file instanceof TFile)).toBe(true);
		});

		it('should pass only TFile results from createBinary to the link updater', async () => {
			// Simulate an adapter that does not resolve to a TFile
			(mockApp.vault.createBinary as jest.Mock).mockResolvedValue(
				undefined,
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).toHaveBeenCalledWith(
				mockApp,
				mockFile,
				[],
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

		it('should abort with the suffix rule before reading the source for an invalid suffix', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).partSuffix = 'bad suffix';

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				'Part suffix may contain only letters, digits, hyphens, and underscores.',
			);
			expect(mockApp.vault.adapter.readBinary).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('should fall back to the default suffix when the field is blank', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).partSuffix = '   ';

			await internals(modal).runSplit(progressEl);

			const paths = (
				mockApp.vault.createBinary as jest.Mock
			).mock.calls.map((call: unknown[]) => call[0]);
			expect(paths).toEqual([
				'Recordings/recording-part1.wav',
				'Recordings/recording-part2.wav',
				'Recordings/recording-part3.wav',
			]);
		});

		it('should clamp a zero part duration up to one minute', async () => {
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).partMinutes = 0;

			await internals(modal).runSplit(progressEl);

			// An unclamped zero-length part would abort the split;
			// one-minute parts of the 250000-byte file yield three parts
			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(3);
		});

		it('should clamp an oversized part duration down to 180 minutes', async () => {
			// 10 Hz mono 16-bit: byteRate 20 B/s; a 180-minute part = 216000 B
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				buildTestWav(1, 10, 250000),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).partMinutes = 10000;

			await internals(modal).runSplit(progressEl);

			// Unclamped 10000-minute parts would exceed the file and abort
			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(2);
			const calls = (mockApp.vault.createBinary as jest.Mock).mock
				.calls as [string, ArrayBuffer][];
			expect(calls[0][1].byteLength).toBe(WAV_HEADER_SIZE + 216000);
			expect(calls[1][1].byteLength).toBe(WAV_HEADER_SIZE + 34000);
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

		it('should roll back written parts by trashing them when a write fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockImplementationOnce((path: string) =>
					Promise.resolve(makePartFile(path)),
				)
				.mockRejectedValueOnce(new Error('disk full'));
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			// trashFile keeps the rollback recoverable; the raw adapter
			// path is only a fallback for non-TFile createBinary results
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(
				expect.objectContaining({
					path: 'Recordings/recording-part1.wav',
				}),
			);
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
		});

		it('should report partial success when updating links fails after parts are written', async () => {
			(updateLinksInVault as jest.Mock).mockRejectedValueOnce(
				new Error('cache busy'),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(3);
			// The parts are kept: no rollback after a post-write failure
			expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'Parts were created, but updating links failed',
				),
			);
			const totalFailures = (Notice as jest.Mock).mock.calls.filter(
				(call: unknown[]) => String(call[0]).startsWith('Split failed'),
			);
			expect(totalFailures).toHaveLength(0);
		});

		it('should report partial success when deleting the source fails', async () => {
			(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValueOnce(
				new Error('locked'),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('the source file could not be deleted'),
			);
		});

		it('should stringify non-Error post-write failures', async () => {
			(updateLinksInVault as jest.Mock).mockRejectedValueOnce(
				'raw link failure',
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			await internals(modal).runSplit(progressEl);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('raw link failure'),
			);

			(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValueOnce(
				'raw delete failure',
			);
			const second = new SplitModal(mockApp, mockFile, mockSettings);
			internals(second).deleteSource = true;
			await internals(second).runSplit(progressEl);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('raw delete failure'),
			);
		});

		it('should keep the source when some links could not be updated', async () => {
			(updateLinksInVault as jest.Mock).mockResolvedValueOnce({
				updatedNotes: 1,
				skippedReferences: 2,
				frontmatterReferences: 0,
			});
			const modal = new SplitModal(mockApp, mockFile, mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'Source file kept: 2 link(s) could not be updated.',
			);
		});

		it('should warn about frontmatter links that stay on the source', async () => {
			(updateLinksInVault as jest.Mock).mockResolvedValueOnce({
				updatedNotes: 1,
				skippedReferences: 0,
				frontmatterReferences: 1,
			});
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'frontmatter link(s) still point to the source file',
				),
			);
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
			(decodeAudioBlob as jest.Mock).mockResolvedValue(
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

			expect(decodeAudioBlob).toHaveBeenCalledTimes(1);
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
			(decodeAudioBlob as jest.Mock).mockResolvedValue(
				createMockAudioBuffer(1, 30 * 44100, 44100),
			);
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'File is shorter than one part.',
			);
		});

		it('should decode a WAV file without a raw sample data chunk', async () => {
			// readBinary returns a non-RIFF buffer, so the lossless WAV
			// path is rejected and the decode pipeline takes over
			configureFile('recording.wav', 'wav');
			const modal = new SplitModal(mockApp, mockFile, mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(decodeAudioBlob).toHaveBeenCalledTimes(1);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'Recordings/recording-part1.wav',
				expect.anything(),
			);
		});

		it('should fall back to WAV when the source format cannot be encoded', async () => {
			const { isOfflineEncodingSupported } = jest.requireMock(
				'src/audio/AudioEncoder',
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
			(decodeAudioBlob as jest.Mock).mockRejectedValue(
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
