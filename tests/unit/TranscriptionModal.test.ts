/**
 * Unit tests for TranscriptionModal background/minimize behavior.
 * @module tests/unit/TranscriptionModal.test
 */

import { App, Notice, TFile } from 'obsidian';
import { noticeMessages } from '../mocks/obsidian';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import type { Profile, ProfileKindId } from 'src/settings/profiles';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import {
	transcribeFile,
	TranscriptionCancelledError,
} from 'src/transcription/api';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { createFile } from '../helpers/createApp';
import { allEls, maybeEl } from '../helpers/dom';
import {
	hasSettingRow,
	rowInput,
	rowSelect,
	rowToggle,
	rowToggleOn,
	settingRow,
} from '../helpers/settingRows';
import { setPlatform, useDesktopPlatform } from '../helpers/platform';
import { tick } from '../helpers/async';
import { internalsOf } from '../helpers/doubles';

// The run itself has its own suites (runTranscription, the providers); what
// this dialog owes is what it does with the outcome, so the run is recorded
// and its result scripted per test.
jest.mock('src/transcription/api', () => ({
	...jest.requireActual('src/transcription/api'),
	transcribeFile: jest.fn(),
}));

type TranscriptionModalInternals = {
	setRunning: (running: boolean) => void;
	updateProgress: (fraction: number, label: string) => void;
	startRun: () => Promise<void>;
	minimize: () => void;
	restore: () => void;
	cancellation: { token: { isCancelled: () => boolean } };
	minimized: boolean;
	busy: boolean;
};

function createAudioFile(): TFile {
	const file = createFile('Audio/meeting.webm');
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

/** One stored profile of a kind, as the unified model holds it. */
function storedProfile(
	kind: ProfileKindId,
	id: string,
	name: string,
	body: string,
): Profile {
	return { id, kind, name, body };
}

describe('TranscriptionModal minimize behavior', () => {
	it('publishes status-bar progress without cancelling the running job', () => {
		const callbacks = {
			show: jest.fn(),
			clear: jest.fn(),
		};
		const modal = createModal(callbacks);
		const internals = internalsOf<TranscriptionModalInternals>(modal);

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
		expect(internals.cancellation.token.isCancelled()).toBe(false);
		expect(internals.minimized).toBe(true);
		expect(modal.contentEl.textContent).toContain('Source: meeting.webm');
	});

	it('clears background progress when the minimized modal is restored', () => {
		const callbacks = {
			show: jest.fn(),
			clear: jest.fn(),
		};
		const modal = createModal(callbacks);
		const internals = internalsOf<TranscriptionModalInternals>(modal);

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
		const internals = internalsOf<TranscriptionModalInternals>(modal);

		modal.onOpen();
		internals.setRunning(true);
		modal.onClose();

		expect(internals.cancellation.token.isCancelled()).toBe(true);
		expect(callbacks.clear).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.textContent).toBe('');
	});
});

describe('TranscriptionModal platform gating', () => {
	afterEach(() => {
		useDesktopPlatform();
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
		setPlatform({ isMobile: true });
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
		setPlatform({ isMobile: true });
		const modal = createLocalWhisperModal();
		modal.onOpen();

		expect(runButton(modal)?.disabled).toBe(true);
	});

	it('refuses to start a run for an unavailable stored engine', async () => {
		// Guards the run itself (including the auto-start path), so a
		// doomed local run never launches; it surfaces a clear notice
		// instead of failing later with a generic transcription error.
		setPlatform({ isMobile: true });
		const notice = jest.mocked(Notice);
		notice.mockClear();
		const modal = createLocalWhisperModal();
		const internals = internalsOf<TranscriptionModalInternals>(modal);
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

/**
 * The dropdown of the setting row with the given name, or null when that row
 * is not rendered. By name rather than by option text, since several pickers
 * offer a "None" option.
 */
function selectByName(
	modal: TranscriptionModal,
	name: string,
): HTMLSelectElement | null {
	if (!hasSettingRow(modal.contentEl, name)) {
		return null;
	}
	return maybeEl<HTMLSelectElement>(
		settingRow(modal.contentEl, name),
		'select',
	);
}

/** The Dictionary select, which must exist wherever it is asked for. */
function dictionarySelect(modal: TranscriptionModal): HTMLSelectElement {
	const select = selectByName(modal, 'Dictionary');
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
			profiles: [
				storedProfile('dictionary', 'a', 'Standup', 'gRPC'),
				storedProfile('dictionary', 'b', 'Legal', 'affidavit'),
			],
			selectedProfileIds: {
				...DEFAULT_SETTINGS.selectedProfileIds,
				dictionary: selectedId,
			},
		};
	}

	it('lists None plus each profile in the Dictionary dropdown', () => {
		const settings = settingsWithProfiles('a');
		const modal = openedOver(settings);

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

		expect(onProfileSelected).toHaveBeenCalledWith('dictionary', 'a');
		const runSettings = (
			modal as unknown as { runSettings: AudioRecorderSettings }
		).runSettings;
		expect(runSettings.selectedProfileIds.dictionary).toBe('a');
		// The saved settings object stays untouched: persistence rides on the
		// callback, not on mutating the shared settings from the dialog.
		expect(settings.selectedProfileIds.dictionary).toBe('');
	});
});

describe('TranscriptionModal participant profile selection', () => {
	/** Settings whose engine and toggle actually produce speaker labels. */
	function diarizingSettings(
		overrides: Partial<AudioRecorderSettings> = {},
	): AudioRecorderSettings {
		return {
			...DEFAULT_SETTINGS,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionDiarize: true,
			profiles: [
				storedProfile('participants', 's1', 'Weekly sync', 'Alex'),
				storedProfile('participants', 's2', 'Interviews', ''),
			],
			selectedProfileIds: DEFAULT_SETTINGS.selectedProfileIds,
			...overrides,
		};
	}

	it('lists None plus each profile when the run will diarize', () => {
		const settings = diarizingSettings();
		const modal = openedOver(settings);

		const select = selectByName(modal, 'Participant profile');
		expect(select).not.toBeNull();
		expect(
			Array.from(select?.options ?? []).map((o) => o.textContent),
		).toEqual(['None', 'Weekly sync', 'Interviews']);
	});

	it('hides the picker when the run produces no speakers', () => {
		// Nothing to name: without diarization the roster the profile fills is
		// never written.
		const withoutDiarize = diarizingSettings({
			transcriptionDiarize: false,
		});
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => withoutDiarize,
			{},
		);
		modal.onOpen();
		expect(selectByName(modal, 'Participant profile')).toBeNull();

		// Same for an engine that cannot diarize, even with the toggle stored on.
		const nonDiarizing = diarizingSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		});
		const other = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => nonDiarizing,
			{},
		);
		other.onOpen();
		expect(selectByName(other, 'Participant profile')).toBeNull();
	});

	it('persists the picked profile and updates the run snapshot', () => {
		const settings = diarizingSettings();
		const onProfileSelected = jest.fn().mockResolvedValue(undefined);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{ onProfileSelected },
		);
		modal.onOpen();

		const select = selectByName(modal, 'Participant profile');
		if (!select) {
			throw new Error('Participant profile select not rendered');
		}
		select.value = 's1';
		select.dispatchEvent(new Event('change'));

		expect(onProfileSelected).toHaveBeenCalledWith('participants', 's1');
		expect(runSettingsOf(modal).selectedProfileIds.participants).toBe('s1');
		// The shared settings object stays untouched: persistence rides on the
		// callback, matching the dictionary and chapter flows.
		expect(settings.selectedProfileIds.participants).toBe('');
	});

	it('shows a removed profile as None rather than a dangling selection', () => {
		const stored = diarizingSettings({
			selectedProfileIds: {
				...DEFAULT_SETTINGS.selectedProfileIds,
				participants: 's1',
			},
		});
		const selected = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => stored,
			{},
		);
		selected.onOpen();
		expect(selectByName(selected, 'Participant profile')?.value).toBe('s1');

		const stale = diarizingSettings({
			selectedProfileIds: {
				...DEFAULT_SETTINGS.selectedProfileIds,
				participants: 'gone',
			},
		});
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => stale,
			{},
		);
		modal.onOpen();
		expect(selectByName(modal, 'Participant profile')?.value).toBe('');
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
			profiles: [
				storedProfile(
					'chapterPrompt',
					'c1',
					'Agenda',
					'Split by agenda item.',
				),
				storedProfile(
					'chapterPrompt',
					'c2',
					'Topic',
					'Split by topic.',
				),
			],
			selectedProfileIds: {
				...DEFAULT_SETTINGS.selectedProfileIds,
				chapterPrompt: '',
			},
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
		const onProfileSelected = jest.fn().mockResolvedValue(undefined);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{ onProfileSelected },
		);
		modal.onOpen();

		const select = chapterProfileSelect(modal);
		expect(select).not.toBeNull();
		expect(
			Array.from(select?.options ?? []).map((o) => o.textContent),
		).toEqual(['None (base prompt)', 'Agenda', 'Topic']);
		(select as HTMLSelectElement).value = 'c1';
		select?.dispatchEvent(new Event('change'));

		expect(onProfileSelected).toHaveBeenCalledWith('chapterPrompt', 'c1');
		const runSettings = (
			modal as unknown as { runSettings: AudioRecorderSettings }
		).runSettings;
		expect(runSettings.selectedProfileIds.chapterPrompt).toBe('c1');
		// The shared settings object stays untouched: persistence rides on the
		// callback, matching the dictionary-profile flow.
		expect(settings.selectedProfileIds.chapterPrompt).toBe('');
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

/**
 * A dialog opened over the given settings with no run callbacks, which is the
 * arrangement most of these tests need and none of them vary.
 * @param settings - The settings the dialog reads
 * @returns The opened modal
 */
function openedOver(settings: AudioRecorderSettings): TranscriptionModal {
	const modal = new TranscriptionModal(
		new App(),
		createAudioFile(),
		() => settings,
		{},
	);
	modal.onOpen();
	return modal;
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
			profiles: [storedProfile('dictionary', 'a', 'Standup', 'gRPC')],
		};
		const modal = openedOver(settings);

		expect(toggleExists(modal, 'Advanced settings')).toBe(true);
		expect(toggleExists(modal, 'Advanced two-pass transcription')).toBe(
			false,
		);

		// Turning the master on reveals both the dictionary picker and the
		// two-pass sub-toggle for this run. The toggle's onChange re-renders the
		// config after an awaited save, so let that microtask settle.
		toggleByName(modal, 'Advanced settings').click();
		await tick();

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
		const modal = openedOver(settings);

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
		const modal = openedOver(settings);

		toggleByName(modal, 'Advanced two-pass transcription').click();

		expect(runSettingsOf(modal).transcriptionAdvancedEnabled).toBe(false);
		expect(settings.transcriptionAdvancedEnabled).toBe(true);
	});
});

describe('TranscriptionModal per-run options', () => {
	/** A dialog open on its options, with everything revealed. */
	function openWithEverything(
		overrides: Partial<AudioRecorderSettings> = {},
	): {
		modal: TranscriptionModal;
		runSettings: AudioRecorderSettings;
		settings: AudioRecorderSettings;
	} {
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			// Deepgram so diarization (and the speaker options under it) is
			// available, and every optional block switched on so each control
			// is actually rendered.
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionDiarize: true,
			transcriptDestination: 'both',
			llmPostProcessEnabled: true,
			transcriptionAutoChaptersEnabled: true,
			transcriptionAdvancedSettingsEnabled: true,
			...overrides,
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			// A note to write into, so an in-note destination is not
			// downgraded to a file before anything is rendered.
			{ notePath: 'Notes/meeting.md' },
		);
		modal.onOpen();
		return {
			modal,
			runSettings: (
				modal as unknown as { runSettings: AudioRecorderSettings }
			).runSettings,
			settings,
		};
	}

	it.each([
		{
			name: 'Language',
			key: 'transcriptionLanguage',
			type: 'text',
			input: '  ru  ',
			expected: 'ru',
		},
		{
			name: 'Language',
			key: 'transcriptionLanguage',
			type: 'text',
			input: '   ',
			expected: 'auto',
		},
		{
			name: 'Destination',
			key: 'transcriptDestination',
			type: 'dropdown',
			input: 'note',
			expected: 'note',
		},
		{
			name: 'File format',
			key: 'transcriptFileFormat',
			type: 'dropdown',
			input: 'json',
			expected: 'json',
		},
		{
			name: 'LLM task',
			key: 'llmPostProcessTask',
			type: 'dropdown',
			input: 'summary',
			expected: 'summary',
		},
	])(
		'$name writes $expected into the run snapshot',
		({ name, key, type, input, expected }) => {
			const { modal, runSettings } = openWithEverything();
			const row = settingRow(modal.contentEl, name);

			if (type === 'text') {
				const field = rowInput(row);
				field.value = input;
				field.dispatchEvent(new Event('input'));
			} else {
				const field = rowSelect(row);
				field.value = input;
				field.dispatchEvent(new Event('change'));
			}

			expect(
				(runSettings as unknown as Record<string, unknown>)[key],
			).toBe(expected);
		},
	);

	it('leaves the saved settings alone when an option is changed', () => {
		// The dialog edits a copy: a per-run choice is for this run only.
		const { modal, settings } = openWithEverything();
		const language = rowInput(settingRow(modal.contentEl, 'Language'));

		language.value = 'ru';
		language.dispatchEvent(new Event('input'));

		expect(settings.transcriptionLanguage).toBe(
			DEFAULT_SETTINGS.transcriptionLanguage,
		);
	});

	it('writes to a file when there is no note to write into', () => {
		// The command can be run with the audio file itself in the active
		// pane. Saying "could not insert" after the run would be worse than
		// choosing the destination that works up front.
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptDestination: 'note',
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{},
		);

		modal.onOpen();

		expect(
			(modal as unknown as { runSettings: AudioRecorderSettings })
				.runSettings.transcriptDestination,
		).toBe('file');
	});

	it.each([
		{ name: 'Speaker diarization', key: 'transcriptionDiarize' },
		{ name: 'Include timestamps', key: 'transcriptIncludeTimestamps' },
		{ name: 'Include speakers', key: 'transcriptIncludeSpeakers' },
		{ name: 'LLM post-processing', key: 'llmPostProcessEnabled' },
		{
			name: 'Generate chapters',
			key: 'transcriptionAutoChaptersOnTranscribe',
		},
	])('$name flips $key on the run snapshot', ({ name, key }) => {
		const { modal, runSettings } = openWithEverything();
		const before = (runSettings as unknown as Record<string, unknown>)[key];

		rowToggle(settingRow(modal.contentEl, name)).click();

		expect((runSettings as unknown as Record<string, unknown>)[key]).toBe(
			!before,
		);
	});

	// Out of the table above, which opens on Deepgram: that engine returns
	// per-word timing whatever the switch says, so its switch is locked and
	// there is nothing to flip. Whisper API is where the choice is the user's.
	it('Word-level timestamps flips transcriptionWordTimestamps on the run snapshot', () => {
		const { modal, runSettings } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			transcriptionWordTimestamps: false,
		});

		rowToggle(settingRow(modal.contentEl, 'Word-level timestamps')).click();

		expect(runSettings.transcriptionWordTimestamps).toBe(true);
	});

	it('picks another engine for this run alone', () => {
		const { modal, runSettings, settings } = openWithEverything();
		const engine = rowSelect(settingRow(modal.contentEl, 'Engine'));

		engine.value = TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
		engine.dispatchEvent(new Event('change'));

		expect(runSettings.transcriptionProvider).toBe(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		);
		expect(settings.transcriptionProvider).toBe(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		);
	});

	it('offers no file-format choice when only the note is written', () => {
		// The format names a sidecar file that this destination never writes.
		const { modal } = openWithEverything({ transcriptDestination: 'note' });

		expect(hasSettingRow(modal.contentEl, 'File format')).toBe(false);
	});

	it.each([{ name: 'Include timestamps' }, { name: 'Include speakers' }])(
		'offers no $name when the transcript never reaches the note',
		({ name }) => {
			// For a file-only run those toggles would format nothing.
			const { modal } = openWithEverything({
				transcriptDestination: 'file',
			});

			expect(hasSettingRow(modal.contentEl, name)).toBe(false);
		},
	);

	it('offers no LLM task while post-processing is off', () => {
		const { modal } = openWithEverything({ llmPostProcessEnabled: false });

		expect(hasSettingRow(modal.contentEl, 'LLM task')).toBe(false);
	});

	it('offers no chapter toggle while the feature is off in settings', () => {
		const { modal } = openWithEverything({
			transcriptionAutoChaptersEnabled: false,
		});

		expect(hasSettingRow(modal.contentEl, 'Generate chapters')).toBe(false);
	});

	it('leaves the speaker toggle inert for an engine that cannot diarize', () => {
		// Whisper produces no speaker labels, so the toggle would promise
		// something the run cannot deliver.
		const { modal } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
		});

		const row = settingRow(modal.contentEl, 'Speaker diarization');

		// Disabled and off: a toggle left switched on but unclickable reads
		// as "diarization is happening", which is the promise Whisper cannot
		// keep.
		expect(rowToggle(row)).toBeDisabledControl();
		expect(rowToggleOn(row)).toBe(false);
	});

	it('leaves the speaker toggle on for an engine that can diarize', () => {
		const { modal } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionDiarize: true,
		});

		const row = settingRow(modal.contentEl, 'Speaker diarization');

		expect(rowToggleOn(row)).toBe(true);
	});

	it('leaves the word-timestamp toggle live on the engine that reads it', () => {
		const { modal } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			transcriptionWordTimestamps: true,
		});

		const row = settingRow(modal.contentEl, 'Word-level timestamps');

		expect(rowToggle(row)).not.toBeDisabledControl();
		expect(rowToggleOn(row)).toBe(true);
	});

	// Off and unclickable: the transcript will carry no words, so a switch
	// left on would promise a JSON field that never arrives.
	it('leaves the word-timestamp toggle inert for an engine that returns none', () => {
		const { modal } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			transcriptionWordTimestamps: true,
		});

		const row = settingRow(modal.contentEl, 'Word-level timestamps');

		expect(rowToggle(row)).toBeDisabledControl();
		expect(rowToggleOn(row)).toBe(false);
	});

	// On and unclickable: Deepgram returns the words whatever the stored
	// value says, so showing it off would be the same lie the other way.
	it('shows the word-timestamp toggle on for an engine that always returns words', () => {
		const { modal } = openWithEverything({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionWordTimestamps: false,
		});

		const row = settingRow(modal.contentEl, 'Word-level timestamps');

		expect(rowToggle(row)).toBeDisabledControl();
		expect(rowToggleOn(row)).toBe(true);
	});
});

/** What a finished transcription run resolves to. */
type RunResult = Awaited<ReturnType<typeof transcribeFile>>;

describe('TranscriptionModal running the job', () => {
	/** A finished run, with whatever the test needs to differ. */
	function runResult(overrides: Partial<RunResult> = {}): RunResult {
		return {
			transcript: { segments: [], speakers: [] },
			markdown: '# Transcript',
			cost: { engineId: 'deepgram', usd: 0.12 },
			...overrides,
		} as RunResult;
	}

	/** A dialog ready to run, with the cost tracker and chapter hook spied. */
	function openRunnable(
		overrides: Partial<AudioRecorderSettings> = {},
		options: Record<string, unknown> = {},
	): {
		modal: TranscriptionModal;
		internals: TranscriptionModalInternals;
		addCost: jest.Mock;
		generateChapters: jest.Mock;
	} {
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			transcriptionShowCostEstimates: true,
			...overrides,
		};
		const addCost = jest.fn();
		// The dialog also reads the tracker to draw the session total line, so
		// the double answers the whole surface it uses, not only add().
		const costTracker = {
			add: addCost,
			hasEntries: (): boolean => false,
			unpricedRuns: (): number => 0,
			totalUsd: (): number => 0.12,
			total: (): number => 0,
			entries: (): unknown[] => [],
		};
		const generateChapters = jest.fn().mockResolvedValue(undefined);
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{
				notePath: 'Notes/meeting.md',
				costTracker: costTracker as never,
				generateChapters,
				...options,
			},
		);
		modal.onOpen();
		return {
			modal,
			internals: internalsOf<TranscriptionModalInternals>(modal),
			addCost,
			generateChapters,
		};
	}

	beforeEach(() => {
		jest.mocked(transcribeFile).mockResolvedValue(runResult());
	});

	it('closes itself when the run finishes', async () => {
		const { modal, internals } = openRunnable();
		const close = jest.spyOn(modal, 'close');

		await internals.startRun();

		expect(transcribeFile).toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});

	it('counts what the run cost against the session total', async () => {
		const { internals, addCost } = openRunnable();

		await internals.startRun();

		expect(addCost).toHaveBeenCalledWith('deepgram', 0.12);
	});

	it('counts nothing for a local run, which is billed to nobody', async () => {
		jest.mocked(transcribeFile).mockResolvedValue(
			runResult({ cost: { engineId: 'local-whisper', usd: 0 } as never }),
		);
		const { internals, addCost } = openRunnable();

		await internals.startRun();

		expect(addCost).not.toHaveBeenCalled();
	});

	it('counts nothing while cost estimates are switched off', () => {
		const { internals, addCost } = openRunnable({
			transcriptionShowCostEstimates: false,
		});

		return internals.startRun().then(() => {
			expect(addCost).not.toHaveBeenCalled();
		});
	});

	it('generates chapters from the transcript it just produced', async () => {
		const { internals, generateChapters } = openRunnable({
			transcriptionAutoChaptersEnabled: true,
			transcriptionAutoChaptersOnTranscribe: true,
		});

		await internals.startRun();

		expect(generateChapters).toHaveBeenCalled();
	});

	it('generates no chapters when the run was not asked to', async () => {
		const { internals, generateChapters } = openRunnable({
			transcriptionAutoChaptersOnTranscribe: false,
		});

		await internals.startRun();

		expect(generateChapters).not.toHaveBeenCalled();
	});

	it('says the run was cancelled rather than that it failed', async () => {
		jest.mocked(transcribeFile).mockRejectedValue(
			new TranscriptionCancelledError(),
		);
		const { internals } = openRunnable();

		await internals.startRun();

		expect(noticeMessages()).toContain('Transcription cancelled.');
		expect(internals.busy).toBe(false);
	});

	it('names what went wrong when the run fails', async () => {
		jest.mocked(transcribeFile).mockRejectedValue(
			new Error('the endpoint refused the key'),
		);
		const { internals } = openRunnable();

		await internals.startRun();

		expect(
			noticeMessages().some((message) =>
				message.includes('the endpoint refused the key'),
			),
		).toBe(true);
	});

	it('reports a failure that was not thrown as an Error', async () => {
		jest.mocked(transcribeFile).mockRejectedValue('upstream exploded');
		const { internals } = openRunnable();

		await internals.startRun();

		expect(
			noticeMessages().some((message) =>
				message.includes('upstream exploded'),
			),
		).toBe(true);
	});

	it('still counts a run that was billed before the write failed', async () => {
		// The provider charged for the audio; a read-only vault losing the
		// transcript afterwards does not refund it.
		let reportCost: ((cost: unknown) => void) | undefined;
		jest.mocked(transcribeFile).mockImplementation(
			async (_app, _settings, _file, runOptions) => {
				reportCost = (
					runOptions as unknown as { onCost: (cost: unknown) => void }
				).onCost;
				reportCost({ engineId: 'deepgram', usd: 0.5 });
				throw new Error('vault is read-only');
			},
		);
		const { internals, addCost } = openRunnable();

		await internals.startRun();

		expect(addCost).toHaveBeenCalledWith('deepgram', 0.5);
	});

	it('runs once however often the button is pressed', async () => {
		// A long run leaves the dialog open; a second press must not start a
		// second billed job.
		const { internals } = openRunnable();

		await Promise.all([internals.startRun(), internals.startRun()]);

		expect(transcribeFile).toHaveBeenCalledTimes(1);
	});

	it('comes back into view when a minimized run fails', async () => {
		// A notice alone would leave the failure unexplained behind a status
		// bar the user has stopped watching.
		jest.mocked(transcribeFile).mockRejectedValue(new Error('no network'));
		const { internals } = openRunnable();
		internals.minimize();

		await internals.startRun();

		expect(internals.minimized).toBe(false);
	});
});

describe('TranscriptionModal buttons', () => {
	/** A dialog whose action buttons are all rendered. */
	function open(): {
		modal: TranscriptionModal;
		internals: TranscriptionModalInternals;
	} {
		const settings: AudioRecorderSettings = {
			...DEFAULT_SETTINGS,
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
		};
		const modal = new TranscriptionModal(
			new App(),
			createAudioFile(),
			() => settings,
			{ notePath: 'Notes/meeting.md' },
		);
		modal.onOpen();
		return {
			modal,
			internals: internalsOf<TranscriptionModalInternals>(modal),
		};
	}

	/** The action button with the given label. */
	function button(modal: TranscriptionModal, text: string): HTMLElement {
		const match = allEls(modal.contentEl, 'button').find(
			(candidate) => candidate.textContent?.trim() === text,
		);
		if (!match) {
			throw new Error(
				`No "${text}" button. Rendered: ` +
					allEls(modal.contentEl, 'button')
						.map((one) => `"${one.textContent ?? ''}"`)
						.join(', '),
			);
		}
		return match;
	}

	beforeEach(() => {
		jest.mocked(transcribeFile).mockImplementation(
			() => new Promise(() => undefined),
		);
	});

	it('starts the run from the Transcribe button', () => {
		const { modal } = open();

		button(modal, 'Transcribe').click();

		expect(transcribeFile).toHaveBeenCalled();
	});

	it('offers no Minimize until there is a run to minimize', () => {
		const { modal } = open();

		expect(button(modal, 'Minimize')).toBeDisabledControl();
	});

	it('minimizes a running job into the status bar', () => {
		const { modal, internals } = open();
		button(modal, 'Transcribe').click();

		button(modal, 'Minimize').click();

		expect(internals.minimized).toBe(true);
	});

	it('closes the dialog when nothing is running', () => {
		const { modal } = open();
		const close = jest.spyOn(modal, 'close');

		button(modal, 'Close').click();

		expect(close).toHaveBeenCalled();
	});

	it('cancels the run instead of closing while one is in flight', () => {
		// Closing on a running job would leave it billing in the background
		// with nothing left to report to.
		const { modal, internals } = open();
		button(modal, 'Transcribe').click();

		button(modal, 'Cancel').click();

		expect(internals.cancellation.token.isCancelled()).toBe(true);
	});
});
