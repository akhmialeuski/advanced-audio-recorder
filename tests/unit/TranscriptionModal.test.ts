/**
 * Unit tests for TranscriptionModal background/minimize behavior.
 * @module tests/unit/TranscriptionModal.test
 */

import { App, Notice, Platform, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

type TranscriptionModalInternals = {
	setRunning: (running: boolean) => void;
	updateProgress: (fraction: number, label: string) => void;
	startRun: () => Promise<void>;
	minimize: () => void;
	restore: () => void;
	cancelled: boolean;
	minimized: boolean;
	running: boolean;
};

function createAudioFile(): TFile {
	const file = new TFile('Audio/meeting.webm');
	Object.defineProperty(file, 'name', { value: 'meeting.webm' });
	return file;
}

function getSettings(): AudioRecorderSettings {
	return { ...DEFAULT_SETTINGS };
}

function createModal(callbacks: {
	show: jest.Mock;
	clear: jest.Mock;
}): TranscriptionModal {
	return new TranscriptionModal(new App(), createAudioFile(), getSettings, {
		backgroundProgress: callbacks,
	});
}

describe('TranscriptionModal minimize behavior', () => {
	it('publishes status-bar progress without cancelling the running job', () => {
		const callbacks = {
			show: jest.fn(),
			clear: jest.fn(),
		};
		const modal = createModal(callbacks);
		const internals = modal as unknown as TranscriptionModalInternals;

		modal.onOpen();
		internals.setRunning(true);
		internals.updateProgress(0.42, 'Uploading audio...');
		internals.minimize();
		modal.onClose();

		expect(callbacks.show).toHaveBeenCalledWith(
			{
				percent: 42,
				description: 'Uploading audio...',
			},
			expect.any(Function),
		);
		expect(callbacks.clear).not.toHaveBeenCalled();
		expect(internals.cancelled).toBe(false);
		expect(internals.minimized).toBe(true);
		expect(modal.contentEl.textContent).toContain('Source: meeting.webm');
	});

	it('clears background progress when the minimized modal is restored', () => {
		const callbacks = {
			show: jest.fn(),
			clear: jest.fn(),
		};
		const modal = createModal(callbacks);
		const internals = modal as unknown as TranscriptionModalInternals;

		modal.onOpen();
		internals.setRunning(true);
		internals.updateProgress(0.25, 'Transcribing chunk...');
		internals.minimize();

		const lastShowCall =
			callbacks.show.mock.calls[callbacks.show.mock.calls.length - 1];
		const restore = lastShowCall?.[1] as (() => void) | undefined;
		restore?.();

		// Cleared exactly twice: once by restore() itself and once by the
		// rendered-modal branch of onOpen (Modal.open() invokes onOpen,
		// in Obsidian and in the mock alike); the callback is idempotent
		expect(callbacks.clear).toHaveBeenCalledTimes(2);
		expect(internals.minimized).toBe(false);
	});

	it('cancels a running transcription when the modal is closed directly', () => {
		const callbacks = {
			show: jest.fn(),
			clear: jest.fn(),
		};
		const modal = createModal(callbacks);
		const internals = modal as unknown as TranscriptionModalInternals;

		modal.onOpen();
		internals.setRunning(true);
		modal.onClose();

		expect(internals.cancelled).toBe(true);
		expect(callbacks.clear).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.textContent).toBe('');
	});
});

describe('TranscriptionModal platform gating', () => {
	afterEach(() => {
		Platform.isMobile = false;
		Platform.isMobileApp = false;
	});

	/** The rendered engine select and its options, from the modal DOM. */
	function engineOptions(modal: TranscriptionModal): HTMLOptionElement[] {
		const selects = Array.from(modal.contentEl.querySelectorAll('select'));
		const engineSelect = selects.find((select) =>
			Array.from(select.options).some(
				(option) =>
					option.value === TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			),
		);
		expect(engineSelect).toBeDefined();
		return Array.from(engineSelect?.options ?? []);
	}

	it('blocks the local whisper.cpp engine option on mobile', () => {
		// The per-run dialog must gate engines exactly like the settings
		// tab: a doomed local run should not be selectable on mobile
		Platform.isMobile = true;
		const modal = createModal({ show: jest.fn(), clear: jest.fn() });
		modal.onOpen();

		const options = new Map(
			engineOptions(modal).map((option) => [
				option.value,
				option.disabled,
			]),
		);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER)).toBe(
			true,
		);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API)).toBe(false);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM)).toBe(false);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.GEMINI)).toBe(false);
	});

	it('keeps every engine selectable on desktop', () => {
		const modal = createModal({ show: jest.fn(), clear: jest.fn() });
		modal.onOpen();

		for (const option of engineOptions(modal)) {
			expect(option.disabled).toBe(false);
		}
	});

	/** The rendered Transcribe button, located by its label. */
	function runButton(
		modal: TranscriptionModal,
	): HTMLButtonElement | undefined {
		return Array.from(modal.contentEl.querySelectorAll('button')).find(
			(button) => button.textContent === 'Transcribe',
		);
	}

	function createLocalWhisperModal(): TranscriptionModal {
		return new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => ({
				...DEFAULT_SETTINGS,
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
			{ backgroundProgress: { show: jest.fn(), clear: jest.fn() } },
		);
	}

	it('disables the Transcribe button when the stored engine is unavailable on mobile', () => {
		// A local whisper.cpp selection synced from desktop stays the active
		// value on mobile; the run must read as blocked, not merely the
		// option, so the disabled selection cannot be launched by a click.
		Platform.isMobile = true;
		const modal = createLocalWhisperModal();
		modal.onOpen();

		expect(runButton(modal)?.disabled).toBe(true);
	});

	it('refuses to start a run for an unavailable stored engine', async () => {
		// Guards the run itself (including the auto-start path), so a
		// doomed local run never launches; it surfaces a clear notice
		// instead of failing later with a generic transcription error.
		Platform.isMobile = true;
		const notice = jest.mocked(Notice);
		notice.mockClear();
		const modal = createLocalWhisperModal();
		const internals = modal as unknown as TranscriptionModalInternals;
		modal.onOpen();

		await internals.startRun();

		expect(internals.running).toBe(false);
		expect(notice).toHaveBeenCalledWith(
			expect.stringContaining('not available on this device'),
		);
	});

	it('leaves the Transcribe button enabled on desktop', () => {
		const modal = createLocalWhisperModal();
		modal.onOpen();

		expect(runButton(modal)?.disabled).toBe(false);
	});
});
