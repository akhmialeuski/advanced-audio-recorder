/**
 * Tests the Preset row of the Transcribe dialog on the real dialog: a preset
 * picked sets the engine, the language and the switches the rows below show
 * and the run starts with, a second pick starts over from the settings, the
 * pick is remembered, a preset that cannot be read says why, and the options
 * as they stand are saved under a name.
 * @module tests/integration/TranscriptionModalPreset.test
 */

import { App } from 'obsidian';
import { TranscriptionModal } from 'src/ui/TranscriptionModal';
import type { TranscriptionModalOptions } from 'src/ui/TranscriptionModal';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import { ProfileKindId, type Profile } from 'src/settings/profiles';
import type { RecordingTranscriptionRequest } from 'src/transcription/api';
import { createFile } from '../helpers/createApp';
import { at, defined } from '../helpers/assertions';
import { tick } from '../helpers/async';
import { modalInstances } from '../mocks/obsidian';
import { el } from '../helpers/dom';
import { internalsOf } from '../helpers/doubles';
import { SETTING } from '../helpers/selectors';
import {
	rowDescription,
	rowInput,
	rowButton,
	rowOptions,
	rowSelect,
	settingRow,
} from '../helpers/settingRows';

/** A lesson: Gemini, two languages, speaker labels. */
const LESSON: Profile = {
	id: 'preset-lesson',
	kind: ProfileKindId.RunPreset,
	name: 'Polish lesson',
	body: 'engine: gemini\nlanguage: pl, uk\ndiarize: on',
};

/** A preset that sets the language and nothing else. */
const GERMAN: Profile = {
	id: 'preset-german',
	kind: ProfileKindId.RunPreset,
	name: 'German',
	body: 'language: de',
};

/** A preset naming a cleanup profile that was deleted since. */
const STALE: Profile = {
	id: 'preset-stale',
	kind: ProfileKindId.RunPreset,
	name: 'Lectures',
	body: 'engine: gemini\ncleanup: Lectures',
};

/** What the dialog under test is, and what it told the plugin. */
interface Sut {
	modal: TranscriptionModal;
	settings: AudioRecorderSettings;
	remembered: jest.Mock;
	saved: jest.Mock;
	transcribe: jest.Mock;
}

/**
 * Opens the dialog over everyday settings holding the three presets.
 * @param overrides - Settings a case varies
 * @returns The dialog and its doubles
 */
function open(overrides: Partial<AudioRecorderSettings> = {}): Sut {
	const settings = mergeSettings({
		transcriptionEnabled: true,
		transcriptionProvider: 'deepgram',
		deepgramApiKey: 'dg-test',
		geminiApiKey: 'gm-test',
		transcriptionLanguage: 'auto',
		transcriptionDiarize: false,
		transcriptionShowCostEstimates: false,
		...overrides,
	});
	settings.profiles = [...settings.profiles, LESSON, GERMAN, STALE];
	const remembered = jest.fn(() => Promise.resolve());
	const saved = jest.fn((name: string, body: string) => {
		const preset: Profile = {
			id: 'preset-saved',
			kind: ProfileKindId.RunPreset,
			name,
			body,
		};
		settings.profiles = [...settings.profiles, preset];
		return Promise.resolve(preset.id);
	});
	const transcribe = jest.fn(() =>
		Promise.resolve({ status: 'cancelled' as const }),
	);
	const options: TranscriptionModalOptions = {
		transcriber: { transcribe },
		onProfileSelected: remembered,
		onPresetSaved: saved,
	};
	const modal = new TranscriptionModal(
		new App(),
		createFile('Audio/lesson.mp4'),
		() => settings,
		options,
	);
	modal.onOpen();
	return { modal, settings, remembered, saved, transcribe };
}

/**
 * Picks a preset in the dialog's Preset row, by its name.
 * @param sut - The dialog
 * @param name - The option to pick, None for no preset
 */
function pick(sut: Sut, name: string): void {
	const select = rowSelect(settingRow(sut.modal.contentEl, 'Preset'));
	const option = Array.from(select.options).find(
		(one) => one.textContent === name,
	);
	select.value = option?.value ?? '';
	select.dispatchEvent(new Event('change'));
}

/**
 * What the rows below the preset show.
 * @param sut - The dialog
 * @returns The language typed and the engine picked
 */
function shown(sut: Sut): { language: string; engine: string } {
	const root = sut.modal.contentEl;
	return {
		language: rowInput(settingRow(root, 'Language')).value,
		engine: rowSelect(settingRow(root, 'Engine')).value,
	};
}

/**
 * Starts the run and answers the settings it was started with.
 * @param sut - The dialog
 * @returns The run's settings
 */
async function runSettings(sut: Sut): Promise<AudioRecorderSettings> {
	await internalsOf<{ startRun: () => Promise<void> }>(sut.modal).startRun();
	const [request] = at(sut.transcribe.mock.calls as unknown[][], 0) as [
		RecordingTranscriptionRequest,
	];
	return request.settings;
}

describe('the Preset row of the Transcribe dialog', () => {
	it('offers None and every preset, and opens on None', () => {
		const sut = open();
		const row = settingRow(sut.modal.contentEl, 'Preset');

		expect(rowOptions(row)).toEqual([
			'None',
			'Language lesson',
			'Polish lesson',
			'German',
			'Lectures',
		]);
		expect(rowSelect(row).value).toBe('');
		expect(shown(sut)).toEqual({ language: 'auto', engine: 'deepgram' });
	});

	it('sets the rows below to what the picked preset states', () => {
		const sut = open();

		pick(sut, 'Polish lesson');

		expect(shown(sut)).toEqual({ language: 'pl, uk', engine: 'gemini' });
	});

	it('starts the run with the preset over the settings', async () => {
		const sut = open();
		pick(sut, 'Polish lesson');

		expect(await runSettings(sut)).toMatchObject({
			transcriptionProvider: 'gemini',
			transcriptionLanguage: 'pl, uk',
			transcriptionDiarize: true,
			deepgramModel: sut.settings.deepgramModel,
		});
	});

	it('starts over from the settings when another preset is picked', () => {
		const sut = open();
		pick(sut, 'Polish lesson');

		pick(sut, 'German');

		expect(shown(sut)).toEqual({ language: 'de', engine: 'deepgram' });
	});

	it('goes back to the settings as they stand with None', () => {
		const sut = open();
		pick(sut, 'Polish lesson');

		pick(sut, 'None');

		expect(shown(sut)).toEqual({ language: 'auto', engine: 'deepgram' });
	});

	it('leaves the plugin settings themselves untouched', () => {
		const sut = open();

		pick(sut, 'Polish lesson');

		expect(sut.settings.transcriptionProvider).toBe('deepgram');
		expect(sut.settings.transcriptionLanguage).toBe('auto');
	});

	it('keeps the focus on the list it was picked in, so the keys go on choosing', () => {
		const sut = open();
		activeDocument.body.appendChild(sut.modal.modalEl);
		rowSelect(settingRow(sut.modal.contentEl, 'Preset')).focus();

		pick(sut, 'Polish lesson');

		expect(activeDocument.activeElement).toBe(
			rowSelect(settingRow(sut.modal.contentEl, 'Preset')),
		);
		sut.modal.modalEl.remove();
	});

	it('has the pick remembered, as a picked profile is', () => {
		const sut = open();

		pick(sut, 'Polish lesson');

		expect(sut.remembered).toHaveBeenCalledWith(
			ProfileKindId.RunPreset,
			LESSON.id,
		);
	});

	it('opens on the preset that was picked last, already applied', () => {
		const sut = open({
			selectedProfileIds: {
				...mergeSettings({}).selectedProfileIds,
				runPreset: LESSON.id,
			},
		});

		expect(rowSelect(settingRow(sut.modal.contentEl, 'Preset')).value).toBe(
			LESSON.id,
		);
		expect(shown(sut)).toEqual({ language: 'pl, uk', engine: 'gemini' });
	});

	it('says why a preset cannot be applied and leaves the options alone', () => {
		const sut = open();

		pick(sut, 'Lectures');

		expect(
			rowDescription(settingRow(sut.modal.contentEl, 'Preset')),
		).toContain('No profile named "Lectures"');
		expect(shown(sut)).toEqual({ language: 'auto', engine: 'deepgram' });
	});

	it('carries a change made after the pick into this run alone', async () => {
		const sut = open();
		pick(sut, 'Polish lesson');
		const language = rowInput(settingRow(sut.modal.contentEl, 'Language'));
		language.value = 'pl, be';
		language.dispatchEvent(new Event('input'));

		expect((await runSettings(sut)).transcriptionLanguage).toBe('pl, be');
		expect(LESSON.body).toContain('language: pl, uk');
	});
});

describe('saving the options of the dialog as a preset', () => {
	/**
	 * Saves the dialog's options under a name, as confirming the name does.
	 * @param sut - The dialog
	 * @param name - The name given
	 */
	async function save(sut: Sut, name: string): Promise<void> {
		await internalsOf<{ savePreset: (name: string) => Promise<void> }>(
			sut.modal,
		).savePreset(name);
	}

	it('saves nothing on the button alone, before a name is confirmed', () => {
		const sut = open();

		el(
			settingRow(sut.modal.contentEl, 'Preset'),
			SETTING.extraButton,
		).click();

		expect(sut.saved).not.toHaveBeenCalled();
	});

	it('saves under the name confirmed in the name dialog', async () => {
		const sut = open();
		el(
			settingRow(sut.modal.contentEl, 'Preset'),
			SETTING.extraButton,
		).click();
		const naming = defined(modalInstances.at(-1), 'the name dialog');
		naming.onOpen();

		rowButton(naming.contentEl, 'Save').click();
		await tick();

		expect(sut.saved).toHaveBeenCalledWith(
			'New preset',
			expect.stringContaining('engine: deepgram'),
		);
	});

	it('hands the plugin the name and the options as they stand', async () => {
		const sut = open();
		pick(sut, 'Polish lesson');

		await save(sut, 'Tuesday lesson');

		const [name, body] = at(sut.saved.mock.calls as [string, string][], 0);
		expect(name).toBe('Tuesday lesson');
		expect(body.split('\n')).toEqual(
			expect.arrayContaining([
				'engine: gemini',
				'language: pl, uk',
				'diarize: on',
			]),
		);
	});

	it('shows the saved preset picked', async () => {
		const sut = open();

		await save(sut, 'Tuesday lesson');

		const row = settingRow(sut.modal.contentEl, 'Preset');
		expect(rowOptions(row)).toContain('Tuesday lesson');
		expect(rowSelect(row).value).toBe('preset-saved');
	});

	it('saves nothing where nothing can keep a preset', async () => {
		const sut = open();
		const bare = new TranscriptionModal(
			new App(),
			createFile('Audio/lesson.mp4'),
			() => sut.settings,
			{ transcriber: { transcribe: sut.transcribe } },
		);
		bare.onOpen();

		await internalsOf<{ savePreset: (name: string) => Promise<void> }>(
			bare,
		).savePreset('Tuesday lesson');

		expect(rowOptions(settingRow(bare.contentEl, 'Preset'))).not.toContain(
			'Tuesday lesson',
		);
	});
});
