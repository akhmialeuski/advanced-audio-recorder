/**
 * A quick note and a recording never hold the microphone together. The quick
 * note refuses to start over a recording, and the recording refuses to start
 * over a dictation; both sides are the plugin's real objects here, because the
 * second refusal lives in the recording manager and is wired in the plugin.
 * @module tests/e2e/quickNoteRecordingExclusion.e2e.test
 */

import { COMMAND_IDS } from 'src/constants';
import { at } from '../helpers/assertions';
import { asMockPlugin } from '../helpers/obsidianMock';
import { loadPlugin } from '../helpers/pluginHarness';
import { noticeMessages } from '../mocks/obsidian';
import { waitFor } from '../helpers/async';
import { installMicrophone } from '../helpers/memoryCapture';

// The shared e2e setup records the recording manager; the refusal under test
// is inside it, so this suite runs the real one.
jest.mock('src/recording/RecordingManager', () =>
	jest.requireActual('src/recording/RecordingManager'),
);
// jsdom has no AudioContext, so the input meter is the shared double.
jest.mock('src/recording/InputLevelMonitor', () =>
	require('../mocks/modules/inputLevelMonitor'),
);

describe('a recording started during a quick note', () => {
	it('is refused before it opens the microphone', async () => {
		// Two captures of one microphone record the same speech twice, and
		// the recording's status bar would hide the dictation's stop button.
		const microphone = installMicrophone();
		const { plugin } = await loadPlugin({
			transcriptionEnabled: true,
			whisperApiKey: 'sk-test',
			quickNotesEnabled: true,
		});
		const mock = asMockPlugin(plugin);
		const quickNoteButton = at(mock.ribbonIcons, 1);
		mock.invokeCommand(COMMAND_IDS.startStopQuickNote);
		await waitFor(
			() => quickNoteButton.el.classList.contains('is-recording'),
			{ message: 'the dictation to start recording' },
		);
		const opensBefore = microphone.getUserMedia.mock.calls.length;

		mock.invokeCommand(COMMAND_IDS.startStopRecording);
		await waitFor(
			() =>
				noticeMessages().includes(
					'Stop the quick note before starting a recording.',
				),
			{ message: 'the recording to be refused' },
		);

		expect(microphone.getUserMedia).toHaveBeenCalledTimes(opensBefore);
		expect(at(mock.ribbonIcons, 0).el.classList).not.toContain(
			'is-recording',
		);
		expect(quickNoteButton.el.classList).toContain('is-recording');
	});

	it('is not refused while no dictation records', async () => {
		// The refusal is for a held microphone only; with quick notes on and
		// idle, a recording goes on to open its streams as it always did.
		const microphone = installMicrophone();
		// A session checks the selected devices before it opens them.
		Object.assign(navigator.mediaDevices, {
			enumerateDevices: jest.fn().mockResolvedValue([]),
		});
		const { plugin } = await loadPlugin({
			transcriptionEnabled: true,
			whisperApiKey: 'sk-test',
			quickNotesEnabled: true,
		});
		const opensBefore = microphone.getUserMedia.mock.calls.length;

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.startStopRecording);
		await waitFor(
			() => microphone.getUserMedia.mock.calls.length > opensBefore,
			{ message: 'the recording to open its streams' },
		);

		expect(noticeMessages()).not.toContain(
			'Stop the quick note before starting a recording.',
		);
	});
});
