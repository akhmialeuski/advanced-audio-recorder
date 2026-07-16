/**
 * Unit tests for TranscriptionModal background/minimize behavior.
 * @module tests/unit/TranscriptionModal.test
 */

import { App, Platform, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';

type TranscriptionModalInternals = {
	setRunning: (running: boolean) => void;
	updateProgress: (fraction: number, label: string) => void;
	minimize: () => void;
	restore: () => void;
	cancelled: boolean;
	minimized: boolean;
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
});
