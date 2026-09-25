/**
 * Quick notes as a user meets them: a button that exists only while the
 * feature is switched on, appearing and disappearing the moment the setting
 * changes, and a command that follows the same switch.
 * @module tests/e2e/quickNotes.e2e.test
 */

import { COMMAND_IDS } from 'src/constants';
import { ICON_MIC, ICON_QUICK_NOTE } from 'src/ui/RibbonIcon';
import { at } from '../helpers/assertions';
import { asMockPlugin } from '../helpers/obsidianMock';
import { loadPlugin } from '../helpers/pluginHarness';
import { waitFor } from '../helpers/async';
import { installMicrophone } from '../helpers/memoryCapture';
import { createTranscriptionProvider } from 'src/transcription/factories';
import { fakeProvider } from '../helpers/providerFixtures';

// The engine factory is the plugin's one door to a paid service. Everything
// else it builds stays real, so only the provider it would hand out is a
// double.
jest.mock('src/transcription/factories', () => ({
	...jest.requireActual<object>('src/transcription/factories'),
	createTranscriptionProvider: jest.fn(),
}));

/** Settings that transcribe, so quick notes have an engine to dictate to. */
const TRANSCRIBING = {
	transcriptionEnabled: true,
	whisperApiKey: 'sk-test',
};

describe('the quick note button', () => {
	it('is absent on a fresh install, where quick notes start switched off', async () => {
		const { plugin } = await loadPlugin();
		const mock = asMockPlugin(plugin);

		expect(mock.ribbonIcons.map((entry) => entry.icon)).toEqual([ICON_MIC]);
		expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(false);
	});

	it('sits beside the recorder button, with an icon of its own, when quick notes are on', async () => {
		const { plugin } = await loadPlugin({
			...TRANSCRIBING,
			quickNotesEnabled: true,
		});
		const mock = asMockPlugin(plugin);

		expect(mock.ribbonIcons.map((entry) => entry.icon)).toEqual([
			ICON_MIC,
			ICON_QUICK_NOTE,
		]);
		expect(at(mock.ribbonIcons, 1).title).toBe(
			'Advanced Audio Recorder: start/stop quick note',
		);
	});

	it('appears and disappears with the setting, without a restart', async () => {
		const { plugin } = await loadPlugin(TRANSCRIBING);
		const mock = asMockPlugin(plugin);

		plugin.settings.quickNotesEnabled = true;
		await plugin.saveSettings();

		const button = at(mock.ribbonIcons, 1);
		expect(button.icon).toBe(ICON_QUICK_NOTE);
		expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(true);

		const removed = jest.spyOn(button.el, 'remove');
		plugin.settings.quickNotesEnabled = false;
		await plugin.saveSettings();

		expect(removed).toHaveBeenCalledTimes(1);
		expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(false);

		// Switched on again, the button comes back rather than staying lost.
		plugin.settings.quickNotesEnabled = true;
		await plugin.saveSettings();
		expect(mock.ribbonIcons.map((entry) => entry.icon)).toEqual([
			ICON_MIC,
			ICON_QUICK_NOTE,
			ICON_QUICK_NOTE,
		]);
	});

	it('leaves with transcription, which it dictates through', async () => {
		const { plugin } = await loadPlugin({
			...TRANSCRIBING,
			quickNotesEnabled: true,
		});
		const removed = jest.spyOn(
			at(asMockPlugin(plugin).ribbonIcons, 1).el,
			'remove',
		);

		plugin.settings.transcriptionEnabled = false;
		await plugin.saveSettings();

		expect(removed).toHaveBeenCalledTimes(1);
	});

	it('records while pressed, then puts the text on the clipboard when no note is open', async () => {
		// The engine is the one collaborator recorded here: the dictation run,
		// the settings it reads and the insertion are the plugin's own.
		installMicrophone();
		const writeText = jest.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		const engine = fakeProvider({
			transcribe: { segments: [{ start: 0, end: 1, text: 'buy milk' }] },
		});
		jest.mocked(createTranscriptionProvider).mockReturnValue(engine);
		const { plugin } = await loadPlugin({
			...TRANSCRIBING,
			quickNotesEnabled: true,
		});
		const button = at(asMockPlugin(plugin).ribbonIcons, 1);

		button.callback(new MouseEvent('click'));
		await waitFor(() => button.el.classList.contains('is-recording'), {
			message: 'the button to show the dictation recording',
		});

		button.callback(new MouseEvent('click'));
		await waitFor(() => writeText.mock.calls.length > 0, {
			message: 'the dictated text to reach the clipboard',
		});

		// The engine was built from the settings as they stand, and sent the
		// clip in the container it was recorded in.
		expect(createTranscriptionProvider).toHaveBeenCalledWith(
			expect.objectContaining({ quickNotesEnabled: true }),
		);
		expect(engine.transcribe).toHaveBeenCalledWith(
			expect.objectContaining({ filename: 'quick-note.webm' }),
			expect.objectContaining({ diarize: false }),
		);
		expect(writeText).toHaveBeenCalledWith('buy milk');
		expect(button.el.classList.contains('is-recording')).toBe(false);
		expect(button.el.classList.contains('is-saving')).toBe(false);
	});
});
