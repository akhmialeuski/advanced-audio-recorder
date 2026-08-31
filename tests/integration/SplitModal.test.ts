/**
 * Unit tests for SplitModal module.
 * @module tests/unit/SplitModal.test
 */

import { SplitModal } from 'src/ui/SplitModal';
import { at } from '../helpers/assertions';
import { App, Notice, TFile } from 'obsidian';
import { createWavHeader } from 'src/audio/WavEncoder';
import { createMockAudioBuffer } from '../helpers/createMockAudioBuffer';

/**
 * Extends an HTMLElement with Obsidian's custom DOM methods.
 */
// The full obsidian mock with only Setting swapped for the recording double,
// which is what makes this dialog's dropdowns, toggles, and buttons reachable.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

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

import {
	encodeAudioBuffer,
	isOfflineEncodingSupported,
} from 'src/audio/AudioEncoder';
import { decodeAudioBlob } from 'src/audio/AudioFormatConverter';
import { updateLinksInVault } from 'src/utils/LinkUpdater';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { waitFor } from '../helpers/async';
import {
	allButtons,
	capturedSettings,
	type CapturedSetting,
	dropdownChanges,
	settingRow,
	textChanges,
	textInputs,
	toggleChanges,
} from '../helpers/captureSettings';
import { noticeInitialText, noticeInstances } from '../mocks/obsidian';
import { el } from '../helpers/dom';
import { MODAL } from '../helpers/selectors';
import { internalsOf } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { addObsidianDomExtensions } from '../mocks/domExtensions';
import type { PlayerMarker } from 'src/markers/markerModel';
import { defined } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { SplitService } from 'src/recording/SplitService';

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
	// Deliberately reaching past `private`: these tests assert the seeded
	// state a user cannot observe until they act on the dialog.
	return internalsOf<SplitModalInternals>(modal);
}

describe('SplitModal', () => {
	let mockApp: App;
	let mockFile: TFile;
	let progressEl: HTMLElement;
	// Real settings rather than a five-field cast: the dialog seeds its part
	// duration, suffix, bitrate, and link action from them, and the cast hid
	// which of the remaining fields it also reads.
	const mockSettings = mergeSettings({
		splitChunkMinutes: 1,
		splitPartSuffix: 'part',
		bitrate: 128000,
		deleteSourceAfterSplit: false,
		conversionLinkAction: 'replace',
	});

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
		Object.defineProperty(mockFile, 'stat', {
			value: { size: 64, ctime: 0, mtime: 0 },
			configurable: true,
		});
	}

	/**
	 * The description text of every rendered row, as it currently reads.
	 * @returns One string per row
	 */
	function renderedDescriptions(): string[] {
		return capturedSettings.map((row) => row.desc);
	}

	beforeEach(() => {
		// clearMocks wipes recorded calls but keeps return values, so a test
		// that makes a format unencodable would otherwise leave every later
		// test taking the WAV fallback. Re-seed the module default per test.
		(
			jest.requireMock('src/audio/AudioEncoder')
				.isOfflineEncodingSupported as jest.Mock
		).mockReturnValue(true);
		capturedSettings.length = 0;

		// activeWindow is an Obsidian global; map it to the jsdom window
		(global as Record<string, unknown>).activeWindow = window;

		mockApp = createMockApp({
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
		}).app;

		mockFile = new TFile();
		configureFile('recording.wav', 'wav');

		progressEl = addObsidianDomExtensions(document.createElement('div'));
	});

	it('instantiates with defaults from settings', () => {
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

		expect(internals(modal).partMinutes).toBe(1);
		expect(internals(modal).partSuffix).toBe('part');
		expect(internals(modal).deleteSource).toBe(false);
		expect(internals(modal).linkAction).toBe('replace');
	});

	it('seeds the link action from the conversion link action setting', () => {
		const modal = new SplitModal(mockApp, mockFile, () => ({
			...mockSettings,
			conversionLinkAction: 'after',
		}));

		expect(internals(modal).linkAction).toBe('after');
	});

	it('snaps an unsupported configured bitrate to the closest option', () => {
		configureFile('recording.webm', 'webm');
		const modal = new SplitModal(mockApp, mockFile, () => ({
			...mockSettings,
			bitrate: 100000,
		}));
		modal.onOpen();

		expect((modal as unknown as { bitrate: number }).bitrate).toBe(96000);
	});

	it('refreshes the part name example when the suffix changes', () => {
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		expect(renderedDescriptions()).toContainEqual(
			expect.stringContaining('"recording-part1.wav"'),
		);

		at(textChanges(), 0)('seg');

		expect(renderedDescriptions()).toContainEqual(
			expect.stringContaining('"recording-seg1.wav"'),
		);
	});

	it('shows the WAV extension in the example when encoding falls back', () => {
		(isOfflineEncodingSupported as jest.Mock).mockReturnValue(false);
		configureFile('recording.webm', 'webm');
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		expect(renderedDescriptions()).toContainEqual(
			expect.stringContaining('"recording-part1.wav"'),
		);
		(isOfflineEncodingSupported as jest.Mock).mockReturnValue(true);
	});

	it('clears the progress text when aborting on a collision', async () => {
		(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
			buildTestWav(1, 1000, 250000),
		);
		(mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

		await internals(modal).runSplit(progressEl);

		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('already exists'),
		);
		expect(progressEl.textContent).toBe('');
	});

	it('keeps reporting progress in a notice when the modal closes mid-split', async () => {
		let resolveRead!: (bytes: ArrayBuffer) => void;
		(mockApp.vault.adapter.readBinary as jest.Mock).mockReturnValue(
			new Promise<ArrayBuffer>((resolve) => {
				resolveRead = resolve;
			}),
		);
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

		const split = internals(modal).runSplit(progressEl);
		modal.onClose();
		// A repeated close must not spawn a second background notice
		modal.onClose();
		resolveRead(buildTestWav(1, 1000, 250000));
		await split;

		const background = noticeInstances.filter((notice) =>
			noticeInitialText(notice).includes('continues in the background'),
		);
		expect(background).toHaveLength(1);
		// The notice mirrors pipeline progress and is hidden at the end
		const notice = at(background, 0);
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
		const modal = new SplitModal(mockApp, mockFile, () => ({
			...mockSettings,
			splitPartSuffix,
		}));

		expect(internals(modal).partSuffix).toBe(expected);
	});

	it.each([
		['an oversized duration', 10000, 180],
		['a non-finite duration', Number.NaN, 15],
		['a zero duration', 0, 1],
	])('clamps %s', (_case, splitChunkMinutes, expected) => {
		const modal = new SplitModal(mockApp, mockFile, () => ({
			...mockSettings,
			splitChunkMinutes,
		}));
		expect(internals(modal).partMinutes).toBe(expected);
	});

	it('renders source file info on open and clear on close', () => {
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		expect(el(modal.contentEl, MODAL.splitSource).textContent).toContain(
			'recording.wav',
		);

		modal.onClose();
		expect(modal.contentEl.children).toHaveLength(0);
	});

	it('updates split options from UI controls', () => {
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		// WAV source: one duration number input, one suffix text, one delete
		// toggle, one link-action dropdown (no bitrate dropdown)
		expect(dropdownChanges()).toHaveLength(1);

		const durationInput = at(textInputs(), 0);
		durationInput.value = '5';
		durationInput.dispatchEvent(new Event('change'));
		expect(internals(modal).partMinutes).toBe(5);

		at(textChanges(), 0)('seg');
		expect(internals(modal).partSuffix).toBe('seg');

		at(toggleChanges(), 0)(true);
		expect(internals(modal).deleteSource).toBe(true);

		at(dropdownChanges(), 0)('after');
		expect(internals(modal).linkAction).toBe('after');
	});

	it.each([
		{ name: 'an invalid suffix', suffix: 'bad/suffix', flagged: true },
		{ name: 'a valid suffix', suffix: 'good-suffix', flagged: false },
		// Empty input is valid: it falls back to the default suffix
		{ name: 'a blank suffix', suffix: '', flagged: false },
	])('marks $name as invalid: $flagged', ({ suffix, flagged }) => {
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();
		const row = settingRow('Part name suffix');

		row.changes.text?.(suffix);

		// The rendered class, not the call that set it: what the user sees is
		// the field being flagged, however the production code got there.
		expect(row.text?.inputEl?.classList.contains('aar-input-invalid')).toBe(
			flagged,
		);
	});

	it('shows the bitrate dropdown only for compressed sources', () => {
		configureFile('recording.webm', 'webm');
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		// Compressed source: bitrate dropdown plus link-action dropdown
		expect(dropdownChanges()).toHaveLength(2);

		at(dropdownChanges(), 0)('192000');
		expect((modal as unknown as { bitrate: number }).bitrate).toBe(192000);
	});

	it('runs the split when the split button is clicked', async () => {
		(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
			buildTestWav(1, 1000, 250000),
		);
		const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
		modal.onOpen();

		const button = at(allButtons(), 0);
		button.click();
		// The click handler runs the async pipeline in the background and
		// re-enables the button in its finally block, so wait for that rather
		// than a fixed delay (slow under coverage instrumentation).
		await waitFor(
			() =>
				button.setDisabled.mock.calls.some(
					(call: unknown[]) => call[0] === false,
				),
			{ timeout: 2000, message: 'the Split button was never re-enabled' },
		);

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

		it('splits WAV bytes without decoding', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

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

		it('writes standalone WAV parts with patched sizes', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			const calls = (mockApp.vault.createBinary as jest.Mock).mock
				.calls as [string, ArrayBuffer][];
			const firstPart = at(calls, 0)[1];
			const lastPart = at(calls, 2)[1];
			expect(firstPart.byteLength).toBe(WAV_HEADER_SIZE + 120000);
			expect(lastPart.byteLength).toBe(WAV_HEADER_SIZE + 10000);
			expect(new DataView(lastPart).getUint32(40, true)).toBe(10000);
		});

		it('updates links in the vault with the created part files', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

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

		it('passes only TFile results from createBinary to the link updater', async () => {
			// Simulate an adapter that does not resolve to a TFile
			(mockApp.vault.createBinary as jest.Mock).mockResolvedValue(
				undefined,
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).toHaveBeenCalledWith(
				mockApp,
				mockFile,
				[],
				'replace',
			);
		});

		it('does not update links for the none action', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).linkAction = 'none';

			await internals(modal).runSplit(progressEl);

			expect(updateLinksInVault).not.toHaveBeenCalled();
		});

		it('does not delete the source by default', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		});

		it('deletes the source only after all parts are written', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
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

		it('aborts with the suffix rule before reading the source for an invalid suffix', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).partSuffix = 'bad suffix';

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				'Part suffix may contain only letters, digits, hyphens, and underscores.',
			);
			expect(mockApp.vault.adapter.readBinary).not.toHaveBeenCalled();
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});

		it('falls back to the default suffix when the field is blank', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
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

		it('clamps a zero part duration up to one minute', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).partMinutes = 0;

			await internals(modal).runSplit(progressEl);

			// An unclamped zero-length part would abort the split;
			// one-minute parts of the 250000-byte file yield three parts
			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(3);
		});

		it('clamps an oversized part duration down to 180 minutes', async () => {
			// 10 Hz mono 16-bit: byteRate 20 B/s; a 180-minute part = 216000 B
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				buildTestWav(1, 10, 250000),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).partMinutes = 10000;

			await internals(modal).runSplit(progressEl);

			// Unclamped 10000-minute parts would exceed the file and abort
			expect(mockApp.vault.createBinary).toHaveBeenCalledTimes(2);
			const calls = (mockApp.vault.createBinary as jest.Mock).mock
				.calls as [string, ArrayBuffer][];
			expect(at(calls, 0)[1].byteLength).toBe(WAV_HEADER_SIZE + 216000);
			expect(at(calls, 1)[1].byteLength).toBe(WAV_HEADER_SIZE + 34000);
		});

		it('aborts when a target part file already exists', async () => {
			(mockApp.vault.adapter.exists as jest.Mock).mockImplementation(
				(path: string) =>
					Promise.resolve(path === 'Recordings/recording-part2.wav'),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('already exists'),
			);
		});

		it('aborts when the file is shorter than one part', async () => {
			(mockApp.vault.adapter.readBinary as jest.Mock).mockResolvedValue(
				buildTestWav(1, 1000, 60000),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'File is shorter than one part.',
			);
		});

		it('removes written parts and keep the source when a write fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('disk full'));
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
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

		it('writes parts next to a file in the vault root', async () => {
			Object.defineProperty(mockFile, 'parent', {
				value: null,
				configurable: true,
			});
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'recording-part1.wav',
				expect.anything(),
			);
		});

		it('stringifies non-Error failures', async () => {
			(mockApp.vault.adapter.readBinary as jest.Mock).mockRejectedValue(
				'raw failure',
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith('Split failed: raw failure');
		});

		it('rolls back written parts by trashing them when a write fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockImplementationOnce((path: string) =>
					Promise.resolve(makePartFile(path)),
				)
				.mockRejectedValueOnce(new Error('disk full'));
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

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

		it('reports partial success when updating links fails after parts are written', async () => {
			(updateLinksInVault as jest.Mock).mockRejectedValueOnce(
				new Error('cache busy'),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
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

		it('reports partial success when deleting the source fails', async () => {
			(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValueOnce(
				new Error('locked'),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('the source file could not be deleted'),
			);
		});

		it('stringifies non-Error post-write failures', async () => {
			(updateLinksInVault as jest.Mock).mockRejectedValueOnce(
				'raw link failure',
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			await internals(modal).runSplit(progressEl);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('raw link failure'),
			);

			(mockApp.fileManager.trashFile as jest.Mock).mockRejectedValueOnce(
				'raw delete failure',
			);
			const second = new SplitModal(
				mockApp,
				mockFile,
				() => mockSettings,
			);
			internals(second).deleteSource = true;
			await internals(second).runSplit(progressEl);
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('raw delete failure'),
			);
		});

		it('keeps the source when some links could not be updated', async () => {
			(updateLinksInVault as jest.Mock).mockResolvedValueOnce({
				updatedNotes: 1,
				skippedReferences: 2,
				frontmatterReferences: 0,
			});
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			internals(modal).deleteSource = true;

			await internals(modal).runSplit(progressEl);

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'Source file kept: 2 link(s) could not be updated.',
			);
		});

		it('warns about frontmatter links that stay on the source', async () => {
			(updateLinksInVault as jest.Mock).mockResolvedValueOnce({
				updatedNotes: 1,
				skippedReferences: 0,
				frontmatterReferences: 1,
			});
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining(
					'frontmatter link(s) still point to the source file',
				),
			);
		});

		it('logs and continue when rollback of a written part fails', async () => {
			(mockApp.vault.createBinary as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('disk full'));
			(mockApp.vault.adapter.remove as jest.Mock).mockRejectedValue(
				new Error('locked'),
			);
			const consoleSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => {});
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(consoleSpy).toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Split failed'),
			);
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

		it('decodes once and encode each part', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

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

		it('aborts when the audio is shorter than one part', async () => {
			(decodeAudioBlob as jest.Mock).mockResolvedValue(
				createMockAudioBuffer(1, 30 * 44100, 44100),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
			expect(Notice).toHaveBeenCalledWith(
				'File is shorter than one part.',
			);
		});

		it('decodes a WAV file without a raw sample data chunk', async () => {
			// readBinary returns a non-RIFF buffer, so the lossless WAV
			// path is rejected and the decode pipeline takes over
			configureFile('recording.wav', 'wav');
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(decodeAudioBlob).toHaveBeenCalledTimes(1);
			expect(mockApp.vault.createBinary).toHaveBeenCalledWith(
				'Recordings/recording-part1.wav',
				expect.anything(),
			);
		});

		it('falls back to WAV when the source format cannot be encoded', async () => {
			(isOfflineEncodingSupported as jest.Mock).mockReturnValue(false);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

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

		it('reports errors from decoding', async () => {
			(decodeAudioBlob as jest.Mock).mockRejectedValue(
				new Error('decode failed'),
			);
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);

			await internals(modal).runSplit(progressEl);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining('Split failed: decode failed'),
			);
			expect(mockApp.vault.createBinary).not.toHaveBeenCalled();
		});
	});

	// Cutting at the recording's own chapters is offered only once the
	// chapters are known to exist: a toggle that cuts at nothing is worse
	// than no toggle at all.
	describe('cutting at chapters', () => {
		/** A markers double answering with the given chapters. */
		function markers(
			answer: Promise<PlayerMarker[]> = Promise.resolve([]),
		): { getMarkers: jest.Mock } {
			return { getMarkers: jest.fn(() => answer) };
		}

		/**
		 * Opens the dialog over a recording whose markers answer as given,
		 * and waits for the sidecar read the chapter row waits on.
		 * @param answer - What the sidecar answers with, or how it fails
		 * @returns The open dialog
		 */
		async function openOver(
			answer: Promise<PlayerMarker[]>,
		): Promise<SplitModal> {
			const modal = new SplitModal(
				mockApp,
				mockFile,
				() => mockSettings,
				markers(answer),
			);
			modal.onOpen();
			await tick();
			return modal;
		}

		/**
		 * Opens the dialog over a recording carrying the given chapters.
		 * @param chapters - The recording's chapters
		 * @returns The open dialog
		 */
		function openWithChapters(
			chapters: PlayerMarker[],
		): Promise<SplitModal> {
			return openOver(Promise.resolve(chapters));
		}

		/** The captured row named "Cut at chapters". */
		function chapterRow(): CapturedSetting {
			return defined(
				capturedSettings.find((row) => row.name === 'Cut at chapters'),
			);
		}

		it('hides the option for a recording with no chapters', async () => {
			await openWithChapters([]);

			expect(chapterRow().el.style.display).toBe('none');
			expect(chapterRow().toggle).toBeNull();
		});

		it('offers it once the recording is known to have chapters', async () => {
			await openWithChapters([
				{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				{ id: 'b', time: 60, label: 'Middle', kind: 'chapter' },
			]);

			expect(chapterRow().el.style.display).not.toBe('none');
			expect(chapterRow().desc).toContain('2 chapters');
		});

		it('leaves the bookmarks out, which mark a point and not a division', async () => {
			await openWithChapters([
				{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				{ id: 'b', time: 60, label: 'Note', kind: 'bookmark' },
			]);

			expect(chapterRow().desc).toContain('1 chapters');
		});

		it('hides the length and suffix rows once it is on', async () => {
			// Neither applies: the parts are as long as the chapters and are
			// named after them
			const modal = await openWithChapters([
				{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
			]);
			const duration = defined(
				capturedSettings.find((row) => row.name === 'Part duration'),
			);

			chapterRow().changes.toggle?.(true);

			expect(duration.el.style.display).toBe('none');
			expect(internalsOf<{ byChapters: boolean }>(modal).byChapters).toBe(
				true,
			);
		});

		it('sends the chapters to the split when the option is on', async () => {
			const modal = await openWithChapters([
				{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
				{ id: 'b', time: 60, label: 'Middle', kind: 'chapter' },
			]);
			chapterRow().changes.toggle?.(true);

			const split = jest
				.spyOn(SplitService.prototype, 'split')
				.mockResolvedValue({ status: 'aborted' });

			await internals(modal).runSplit(progressEl);

			expect(split).toHaveBeenCalledWith(
				expect.objectContaining({
					cuts: [
						{ startSeconds: 0, title: 'Intro' },
						{ startSeconds: 60, title: 'Middle' },
					],
				}),
				expect.any(Function),
			);
			split.mockRestore();
		});

		it('sends no chapters while the option is off', async () => {
			const modal = await openWithChapters([
				{ id: 'a', time: 0, label: 'Intro', kind: 'chapter' },
			]);

			const split = jest
				.spyOn(SplitService.prototype, 'split')
				.mockResolvedValue({ status: 'aborted' });

			await internals(modal).runSplit(progressEl);

			expect(split).toHaveBeenCalledWith(
				expect.not.objectContaining({ cuts: expect.anything() }),
				expect.any(Function),
			);
			split.mockRestore();
		});

		it('offers no chapter split when the sidecar cannot be read', async () => {
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
				// The hidden row is the assertion.
			});
			await openOver(Promise.reject(new Error('unreadable')));

			expect(chapterRow().el.style.display).toBe('none');
			warn.mockRestore();
		});

		it('offers none at all where no markers are reachable', async () => {
			const modal = new SplitModal(mockApp, mockFile, () => mockSettings);
			modal.onOpen();
			await tick();

			expect(chapterRow().el.style.display).toBe('none');
		});
	});
});
