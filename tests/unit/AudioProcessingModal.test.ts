/**
 * Unit tests for AudioProcessingModal: the stage-selection dialog that
 * drives AudioProcessingService. Covers the no-stage guard, the happy
 * path (process, link, notice, close), the delete-source flow, and
 * failure reporting.
 * @module tests/unit/AudioProcessingModal.test
 */

import { App, Notice, TFile } from 'obsidian';
import { AudioProcessingModal } from 'src/cleanup/AudioProcessingModal';
import { AudioProcessingService } from 'src/cleanup/AudioProcessingService';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { createMockApp } from '../helpers/createApp';
import { tick } from '../helpers/async';

jest.mock('src/cleanup/AudioProcessingService');

const processMock = jest.fn();

function makeFile(): TFile {
	return Object.assign(Object.create(TFile.prototype), {
		path: 'recordings/take.wav',
		name: 'take.wav',
		basename: 'take',
		extension: 'wav',
	}) as TFile;
}

function makeApp(): App {
	return createMockApp().app;
}

/** Settings with the given cleanup stages enabled by default. */
function settingsWithStages(enabled: boolean): AudioRecorderSettings {
	return {
		...DEFAULT_SETTINGS,
		cleanupHighPassEnabled: enabled,
		cleanupNoiseGateEnabled: enabled,
		cleanupLevelingEnabled: enabled,
	};
}

/** Opens the modal and returns the rendered Process button. */
function openModal(
	app: App,
	settings: AudioRecorderSettings,
	onProcessed?: (result: {
		outputPath: string;
		replaceSource: boolean;
	}) => void | Promise<void>,
): { modal: AudioProcessingModal; processButton: HTMLButtonElement } {
	const modal = new AudioProcessingModal(
		app,
		makeFile(),
		() => settings,
		onProcessed,
	);
	modal.onOpen();
	const buttons = Array.from(modal.contentEl.querySelectorAll('button'));
	const processButton = buttons.find(
		(el) => el.textContent === 'Process',
	) as HTMLButtonElement;
	expect(processButton).toBeDefined();
	return { modal, processButton };
}

/** Finds a rendered setting row by its name text. */
function settingRowByName(container: HTMLElement, name: string): HTMLElement {
	const rows = Array.from(
		container.querySelectorAll<HTMLElement>('.setting-item'),
	);
	const row = rows.find(
		(el) => el.querySelector('.setting-item-name')?.textContent === name,
	);
	if (!row) {
		throw new Error(`setting row "${name}" not rendered`);
	}
	return row;
}

/** Clicks the toggle of the named setting row. */
function clickToggle(container: HTMLElement, name: string): void {
	const toggle = settingRowByName(container, name).querySelector<HTMLElement>(
		'.checkbox-container',
	);
	if (!toggle) {
		throw new Error(`toggle in "${name}" not rendered`);
	}
	toggle.click();
}

/** Lets the queued run() settle (one yield plus the async pipeline). */
async function settle(): Promise<void> {
	await tick();
	await tick();
}

describe('AudioProcessingModal', () => {
	beforeEach(() => {
		processMock.mockReset();
		(AudioProcessingService as unknown as jest.Mock).mockImplementation(
			() => ({ process: processMock }),
		);
	});

	it('renders the three stage rows with sliders and toggles', () => {
		const { modal } = openModal(makeApp(), settingsWithStages(true));

		const text = modal.contentEl.textContent ?? '';
		expect(text).toContain('Source: take.wav');
		for (const stage of [
			'High-pass filter',
			'Noise gate',
			'Loudness leveling',
		]) {
			const row = settingRowByName(modal.contentEl, stage);
			expect(row.querySelector('.checkbox-container')).not.toBeNull();
			expect(row.querySelector('input')).not.toBeNull();
		}
	});

	it('refuses to run when no stage is enabled', async () => {
		const { processButton } = openModal(
			makeApp(),
			settingsWithStages(false),
		);

		processButton.click();
		await settle();

		expect(processMock).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			'Enable at least one processing stage, or choose a mono channel option.',
		);
	});

	it('runs a pure mono downmix with no DSP stage enabled', async () => {
		processMock.mockResolvedValue('recordings/take-processed.wav');
		const { modal, processButton } = openModal(
			makeApp(),
			settingsWithStages(false),
		);
		jest.spyOn(modal, 'close').mockImplementation();

		// Pick a mono mode via the Channels dropdown
		const channelsSelect = settingRowByName(
			modal.contentEl,
			'Channels',
		).querySelector<HTMLSelectElement>('select');
		if (!channelsSelect) {
			throw new Error('channels dropdown not rendered');
		}
		channelsSelect.value = 'mono-left';
		channelsSelect.dispatchEvent(new Event('change'));

		processButton.click();
		await settle();

		expect(processMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ channelMode: 'mono-left' }),
		);
	});

	it('processes the file and links the result before closing', async () => {
		processMock.mockResolvedValue('recordings/take-processed.wav');
		const onProcessed = jest.fn();
		const app = makeApp();
		const { modal, processButton } = openModal(
			app,
			settingsWithStages(true),
			onProcessed,
		);
		const closeSpy = jest.spyOn(modal, 'close').mockImplementation();

		processButton.click();
		await settle();

		expect(processMock).toHaveBeenCalledTimes(1);
		expect(onProcessed).toHaveBeenCalledWith({
			outputPath: 'recordings/take-processed.wav',
			replaceSource: false,
		});
		expect(app.fileManager.trashFile).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith(
			'Processed audio saved to recordings/take-processed.wav',
		);
		expect(closeSpy).toHaveBeenCalled();
	});

	it('trashes the source when delete-source is enabled', async () => {
		processMock.mockResolvedValue('recordings/take-processed.wav');
		const onProcessed = jest.fn();
		const app = makeApp();
		const { modal, processButton } = openModal(
			app,
			settingsWithStages(true),
			onProcessed,
		);
		jest.spyOn(modal, 'close').mockImplementation();

		// Flip the delete-source toggle the way a user would
		clickToggle(modal.contentEl, 'Delete source after processing');

		processButton.click();
		await settle();

		expect(onProcessed).toHaveBeenCalledWith({
			outputPath: 'recordings/take-processed.wav',
			replaceSource: true,
		});
		expect(app.fileManager.trashFile).toHaveBeenCalledTimes(1);
	});

	it('keeps the result and notifies when deleting the source fails', async () => {
		processMock.mockResolvedValue('recordings/take-processed.wav');
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
		const app = makeApp();
		(app.fileManager.trashFile as jest.Mock).mockRejectedValue(
			new Error('locked'),
		);
		const { modal, processButton } = openModal(
			app,
			settingsWithStages(true),
		);
		jest.spyOn(modal, 'close').mockImplementation();
		clickToggle(modal.contentEl, 'Delete source after processing');

		processButton.click();
		await settle();

		expect(Notice).toHaveBeenCalledWith(
			'Processed audio saved to recordings/take-processed.wav, but the source could not be deleted.',
		);
		warnSpy.mockRestore();
	});

	it('reports a processing failure and keeps the modal open', async () => {
		processMock.mockRejectedValue(new Error('decode failed'));
		const { modal, processButton } = openModal(
			makeApp(),
			settingsWithStages(true),
		);
		const closeSpy = jest.spyOn(modal, 'close').mockImplementation();

		processButton.click();
		await settle();

		expect(Notice).toHaveBeenCalledWith(
			'Audio processing failed: decode failed',
		);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(modal.contentEl.textContent).toContain('Failed: decode failed');
	});

	it('links the note best-effort: a linking failure does not block the save', async () => {
		processMock.mockResolvedValue('recordings/take-processed.wav');
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
		const onProcessed = jest.fn().mockRejectedValue(new Error('note gone'));
		const { modal, processButton } = openModal(
			makeApp(),
			settingsWithStages(true),
			onProcessed,
		);
		const closeSpy = jest.spyOn(modal, 'close').mockImplementation();

		processButton.click();
		await settle();

		expect(Notice).toHaveBeenCalledWith(
			'Processed audio saved to recordings/take-processed.wav',
		);
		expect(closeSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
