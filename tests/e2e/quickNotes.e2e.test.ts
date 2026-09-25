/**
 * Quick notes as a user meets them: a button that exists only while the
 * feature is switched on, appearing and disappearing the moment the setting
 * changes, and a command that follows the same switch.
 * @module tests/e2e/quickNotes.e2e.test
 */

import { COMMAND_IDS } from 'src/constants';
import {
	ICON_MIC,
	ICON_QUICK_NOTE,
	RIBBON_HIDDEN_CLASS,
} from 'src/ui/RibbonIcon';
import { at } from '../helpers/assertions';
import { asMockPlugin } from '../helpers/obsidianMock';
import { loadPlugin } from '../helpers/pluginHarness';
import { control, el } from '../helpers/dom';
import { STATUS } from '../helpers/selectors';
import { InputLevelMonitor } from 'src/recording/InputLevelMonitor';
import type { MockInputLevelMonitor } from '../mocks/modules/inputLevelMonitor';
import { useDesktopPlatform, useMobilePlatform } from '../helpers/platform';
import { noticeInstances, noticeMessages } from '../mocks/obsidian';
import { waitFor } from '../helpers/async';
import { installMicrophone } from '../helpers/memoryCapture';
import { createTranscriptionProvider } from 'src/transcription/factories';
import { fakeProvider } from '../helpers/providerFixtures';

// The engine factory is the plugin's one door to a paid service. Everything
// else it builds stays real, so only the provider it would hand out is a
// double.
// jsdom has no AudioContext, so the input meter is the shared double.
jest.mock('src/recording/InputLevelMonitor', () =>
	require('../mocks/modules/inputLevelMonitor'),
);
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

	it('appears and disappears with the setting, without a restart, from one registration', async () => {
		// The API has no way to take a ribbon action back short of unloading,
		// so the button is registered once and hidden, and a switch back on
		// must not register a second one.
		const { plugin } = await loadPlugin(TRANSCRIBING);
		const mock = asMockPlugin(plugin);

		plugin.settings.quickNotesEnabled = true;
		await plugin.saveSettings();

		const button = at(mock.ribbonIcons, 1);
		expect(button.icon).toBe(ICON_QUICK_NOTE);
		expect(button.el.classList.contains(RIBBON_HIDDEN_CLASS)).toBe(false);
		expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(true);

		plugin.settings.quickNotesEnabled = false;
		await plugin.saveSettings();

		expect(button.el.classList.contains(RIBBON_HIDDEN_CLASS)).toBe(true);
		expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(false);

		plugin.settings.quickNotesEnabled = true;
		await plugin.saveSettings();

		expect(mock.ribbonIcons.map((entry) => entry.icon)).toEqual([
			ICON_MIC,
			ICON_QUICK_NOTE,
		]);
		expect(button.el.classList.contains(RIBBON_HIDDEN_CLASS)).toBe(false);
	});

	it('leaves with transcription, which it dictates through', async () => {
		const { plugin } = await loadPlugin({
			...TRANSCRIBING,
			quickNotesEnabled: true,
		});
		const button = at(asMockPlugin(plugin).ribbonIcons, 1);

		plugin.settings.transcriptionEnabled = false;
		await plugin.saveSettings();

		expect(button.el.classList.contains(RIBBON_HIDDEN_CLASS)).toBe(true);
	});

	it('closes the microphone of a dictation under way when the plugin unloads', async () => {
		const microphone = installMicrophone();
		const { plugin } = await loadPlugin({
			...TRANSCRIBING,
			quickNotesEnabled: true,
		});
		const button = at(asMockPlugin(plugin).ribbonIcons, 1);
		expect(
			asMockPlugin(plugin).invokeCommand(COMMAND_IDS.startStopQuickNote),
		).toBe(true);
		await waitFor(() => button.el.classList.contains('is-recording'), {
			message: 'the dictation to start recording',
		});

		// Loading the plugin opened the microphone once already, to name the
		// default device, and released it.
		const releasedBefore = microphone.trackStop.mock.calls.length;

		plugin.onunload();

		// The audio had nowhere to go, so the device is released and nothing
		// is transcribed.
		expect(microphone.trackStop).toHaveBeenCalledTimes(releasedBefore + 1);
		expect(createTranscriptionProvider).not.toHaveBeenCalled();
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

		// The status bar says what is happening, the way it does for a
		// recording, and stops the dictation from there too.
		const bar = at(asMockPlugin(plugin).statusBarItems, 0);
		expect(el(bar, STATUS.recordingLabel).textContent).toBe(
			'Quick note...',
		);
		expect(bar).toHaveControl('Stop quick note');
		// The live indicators follow the capture on the same pump a recording
		// uses, the input meter included.
		const meter = jest.mocked(InputLevelMonitor).mock
			.instances[0] as unknown as MockInputLevelMonitor;
		meter.getLevel.mockReturnValue(0.5);
		await waitFor(
			() =>
				el(bar, STATUS.inputMeterFill).style.getPropertyValue(
					'--aar-meter-fill',
				) === '50%',
			{ message: 'the input meter to show the dictation level' },
		);
		control(bar, 'Stop quick note').click();
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
		expect(bar.textContent).toBe('');
	});

	it('says what it is doing in a notice where there is no status bar', async () => {
		// Mobile has neither the ribbon nor the status bar, so the command
		// and a notice that follows each stage carry the whole feedback.
		useMobilePlatform();
		try {
			installMicrophone();
			Object.assign(navigator, {
				clipboard: {
					writeText: jest.fn().mockResolvedValue(undefined),
				},
			});
			jest.mocked(createTranscriptionProvider).mockReturnValue(
				fakeProvider({
					transcribe: {
						segments: [{ start: 0, end: 1, text: 'buy milk' }],
					},
				}),
			);
			const { plugin } = await loadPlugin({
				...TRANSCRIBING,
				quickNotesEnabled: true,
			});
			const mock = asMockPlugin(plugin);

			expect(mock.invokeCommand(COMMAND_IDS.startStopQuickNote)).toBe(
				true,
			);
			await waitFor(
				() =>
					noticeMessages().includes(
						'Quick note: recording. Run the command again to stop.',
					),
				{ message: 'the recording notice' },
			);

			mock.invokeCommand(COMMAND_IDS.startStopQuickNote);
			await waitFor(
				() =>
					noticeInstances.some(
						(notice) => notice.message === 'Quick note: Done',
					),
				{ message: 'the notice to follow the stages to the end' },
			);

			// One notice follows the dictation from start to end, and it is
			// taken down once the dictation is over.
			const [notice] = noticeInstances.filter(
				(entry) =>
					entry.initialMessage ===
					'Quick note: recording. Run the command again to stop.',
			);
			await waitFor(() => (notice?.hide.mock.calls.length ?? 0) > 0, {
				message: 'the notice to be taken down',
			});
			expect(notice?.message).toBe('Quick note: Done');
		} finally {
			useDesktopPlatform();
		}
	});
});
