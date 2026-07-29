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
	busy: boolean;
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

		expect(internals.busy).toBe(false);
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

/** The Dictionary select is the one carrying a None option. */
function dictionarySelect(modal: TranscriptionModal): HTMLSelectElement {
	const selects = Array.from(modal.contentEl.querySelectorAll('select'));
	const select = selects.find((el) =>
		Array.from(el.options).some((option) => option.textContent === 'None'),
	);
	if (!select) {
		throw new Error('Dictionary select not rendered');
	}
	return select;
}

describe('TranscriptionModal dictionary profile selection', () => {
	function settingsWithProfiles(selectedId: string): AudioRecorderSettings {
		return {
			...DEFAULT_SETTINGS,
			// The dictionary picker lives under the advanced master switch.
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Standup', terms: 'gRPC' },
				{ id: 'b', name: 'Legal', terms: 'affidavit' },
			],
			transcriptionDictionaryProfileId: selectedId,
		};
	}

	it('lists None plus each profile in the Dictionary dropdown', () => {
		const settings = settingsWithProfiles('a');
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{},
		);
		modal.onOpen();

		const select = dictionarySelect(modal);
		expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
			'None',
			'Standup',
			'Legal',
		]);
		expect(Array.from(select.options).map((o) => o.value)).toEqual([
			'',
			'a',
			'b',
		]);
	});

	it('persists the picked profile and updates the run snapshot', () => {
		const settings = settingsWithProfiles('');
		const onProfileSelected = jest.fn().mockResolvedValue(undefined);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{ onProfileSelected },
		);
		modal.onOpen();

		const select = dictionarySelect(modal);
		select.value = 'a';
		select.dispatchEvent(new Event('change'));

		expect(onProfileSelected).toHaveBeenCalledWith('a');
		const runSettings = (
			modal as unknown as { runSettings: AudioRecorderSettings }
		).runSettings;
		expect(runSettings.transcriptionDictionaryProfileId).toBe('a');
		// The saved settings object stays untouched: persistence rides on the
		// callback, not on mutating the shared settings from the dialog.
		expect(settings.transcriptionDictionaryProfileId).toBe('');
	});
});

/** The chapter-profile select is the one carrying the base-prompt option. */
function chapterProfileSelect(
	modal: TranscriptionModal,
): HTMLSelectElement | null {
	const selects = Array.from(modal.contentEl.querySelectorAll('select'));
	return (
		selects.find((el) =>
			Array.from(el.options).some(
				(option) => option.textContent === 'None (base prompt)',
			),
		) ?? null
	);
}

describe('TranscriptionModal chapter profile selection', () => {
	function settingsWithChapterProfiles(
		onTranscribe: boolean,
	): AudioRecorderSettings {
		return {
			...DEFAULT_SETTINGS,
			transcriptionAutoChaptersEnabled: true,
			transcriptionAutoChaptersOnTranscribe: onTranscribe,
			transcriptionChapterPromptProfiles: [
				{ id: 'c1', name: 'Agenda', prompt: 'Split by agenda item.' },
				{ id: 'c2', name: 'Topic', prompt: 'Split by topic.' },
			],
			transcriptionChapterPromptProfileId: '',
		};
	}

	it('shows the chapter-profile picker only when generate-after is on', () => {
		const off = settingsWithChapterProfiles(false);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => off,
			{},
		);
		modal.onOpen();
		expect(chapterProfileSelect(modal)).toBeNull();
	});

	it('persists the picked chapter profile and updates the run snapshot', () => {
		const settings = settingsWithChapterProfiles(true);
		const onChapterProfileSelected = jest.fn().mockResolvedValue(undefined);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{ onChapterProfileSelected },
		);
		modal.onOpen();

		const select = chapterProfileSelect(modal);
		expect(select).not.toBeNull();
		expect(
			Array.from(select?.options ?? []).map((o) => o.textContent),
		).toEqual(['None (base prompt)', 'Agenda', 'Topic']);
		(select as HTMLSelectElement).value = 'c1';
		select?.dispatchEvent(new Event('change'));

		expect(onChapterProfileSelected).toHaveBeenCalledWith('c1');
		const runSettings = (
			modal as unknown as { runSettings: AudioRecorderSettings }
		).runSettings;
		expect(runSettings.transcriptionChapterPromptProfileId).toBe('c1');
		// The shared settings object stays untouched: persistence rides on the
		// callback, matching the dictionary-profile flow.
		expect(settings.transcriptionChapterPromptProfileId).toBe('');
	});
});

/**
 * Finds the toggle (checkbox container) of the setting row with the given
 * name, so a test can flip a specific toggle among the many the dialog renders.
 */
function toggleByName(modal: TranscriptionModal, name: string): HTMLElement {
	const items = Array.from(modal.contentEl.querySelectorAll('.setting-item'));
	const item = items.find(
		(el) => el.querySelector('.setting-item-name')?.textContent === name,
	);
	if (!item) {
		throw new Error(`Setting "${name}" not rendered`);
	}
	const toggle = item.querySelector<HTMLElement>('.checkbox-container');
	if (!toggle) {
		throw new Error(`Toggle for "${name}" not rendered`);
	}
	return toggle;
}

function runSettingsOf(modal: TranscriptionModal): AudioRecorderSettings {
	return (modal as unknown as { runSettings: AudioRecorderSettings })
		.runSettings;
}

function toggleExists(modal: TranscriptionModal, name: string): boolean {
	return Array.from(
		modal.contentEl.querySelectorAll('.setting-item-name'),
	).some((el) => el.textContent === name);
}

describe('TranscriptionModal advanced settings master toggle', () => {
	it('hides the dictionary and two-pass controls until the master is on', async () => {
		// Advanced settings off: a plain run, so neither the dictionary picker
		// nor the two-pass sub-toggle is offered.
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptionAdvancedSettingsEnabled: false,
			transcriptionDictionaryProfiles: [
				{ id: 'a', name: 'Standup', terms: 'gRPC' },
			],
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{},
		);
		modal.onOpen();

		expect(toggleExists(modal, 'Advanced settings')).toBe(true);
		expect(toggleExists(modal, 'Advanced two-pass transcription')).toBe(
			false,
		);

		// Turning the master on reveals both the dictionary picker and the
		// two-pass sub-toggle for this run. The toggle's onChange re-renders the
		// config after an awaited save, so let that microtask settle.
		toggleByName(modal, 'Advanced settings').click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runSettingsOf(modal).transcriptionAdvancedSettingsEnabled).toBe(
			true,
		);
		expect(toggleExists(modal, 'Advanced two-pass transcription')).toBe(
			true,
		);
		const selects = Array.from(modal.contentEl.querySelectorAll('select'));
		expect(
			selects.some((el) =>
				Array.from(el.options).some((o) => o.textContent === 'Standup'),
			),
		).toBe(true);
	});
});

describe('TranscriptionModal advanced two-pass toggle', () => {
	it('overrides the advanced mode for this run without mutating saved settings', () => {
		// The saved default is off; enabling it in the dialog must affect only
		// the run snapshot the transcription reads, never the persisted settings.
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: false,
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{},
		);
		modal.onOpen();

		toggleByName(modal, 'Advanced two-pass transcription').click();

		expect(runSettingsOf(modal).transcriptionAdvancedEnabled).toBe(true);
		expect(settings.transcriptionAdvancedEnabled).toBe(false);
	});

	it('defaults the toggle from the saved setting', () => {
		// With the mode on in settings, the dialog toggle starts on; a single
		// click therefore turns it off for this run, proving it mirrored the
		// saved value rather than a hardcoded default.
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{},
		);
		modal.onOpen();

		toggleByName(modal, 'Advanced two-pass transcription').click();

		expect(runSettingsOf(modal).transcriptionAdvancedEnabled).toBe(false);
		expect(settings.transcriptionAdvancedEnabled).toBe(true);
	});
});
