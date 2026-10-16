/**
 * Tests for the recording-session actions as the command line runs them:
 * the state they answer with, the markers they drop with the label typed
 * instead of the naming dialog, and the input device they list or choose.
 * @module tests/integration/sessionActionsCli.test
 */

import type { CliData } from 'obsidian';
import {
	SESSION_ACTIONS,
	sessionActionFamily,
} from 'src/actions/sessionActions';
import type {
	RecordingSessionPort,
	SessionServices,
} from 'src/actions/PluginAction';
import { COMMAND_IDS } from 'src/constants';
import { RecordingStatus } from 'src/types';
import type { RecordingMarkerHandle } from 'src/recording/recordingMarkers';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';
import { mediaDevice, withMediaDevices } from '../helpers/mediaMocks';

/** A marker handle whose commit is a spy. */
function makeHandle(): jest.Mocked<RecordingMarkerHandle> {
	return {
		initialKind: 'chapter',
		defaultLabelFor: jest.fn((kind) => `${kind} 3`),
		commit: jest.fn(),
		cancel: jest.fn(),
	};
}

/**
 * The session services over a recorder and a quick note that report the
 * given states, every call a spy.
 * @param options - What the recorder and the quick note report
 */
function createSut(
	options: {
		status?: RecordingStatus;
		quickNote?: RecordingStatus;
		handle?: RecordingMarkerHandle | null;
	} = {},
): SessionServices & {
	recording: jest.Mocked<RecordingSessionPort>;
	saveSettings: jest.Mock;
} {
	const settings = mergeSettings({ recordingFormat: 'mp3' });
	return {
		app: createMockApp().app,
		getSettings: () => settings,
		saveSettings: jest.fn().mockResolvedValue(undefined),
		recording: partial<jest.Mocked<RecordingSessionPort>>({
			toggleRecording: jest.fn().mockResolvedValue(null),
			togglePauseResume: jest.fn(),
			getStatus: jest.fn(
				() => options.status ?? RecordingStatus.Recording,
			),
			captureMarkerDraft: jest.fn(() =>
				options.handle === undefined ? makeHandle() : options.handle,
			),
		}),
		quickNote: {
			toggle: jest.fn().mockResolvedValue(undefined),
			getStatus: jest.fn(() => options.quickNote ?? RecordingStatus.Idle),
		},
		openMarkerModal: jest.fn(),
	};
}

/**
 * Runs one session action the way the command line runs it.
 * @param services - The session
 * @param commandId - The action
 * @param args - What was typed
 */
function execute(
	services: SessionServices,
	commandId: string,
	args: CliData = {},
): Promise<string> {
	const action = SESSION_ACTIONS.find(
		(entry) => entry.commandId === commandId,
	);
	if (!action) {
		throw new Error(`No session action ${commandId}`);
	}
	return Promise.resolve(action.cli.execute(services, args));
}

describe('driving the recorder from the command line', () => {
	it('toggles recording and answers with the state it left', async () => {
		const services = createSut({ status: RecordingStatus.Idle });

		await expect(
			execute(services, COMMAND_IDS.startStopRecording),
		).resolves.toBe('Idle. A recording started now is saved as MP3.');
		expect(services.recording.toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('answers with the reason a start was refused, not the idle state', async () => {
		// The recorder stays idle after a refused start, and its status line
		// alone would tell a script that nothing went wrong.
		const services = createSut({ status: RecordingStatus.Idle });
		services.recording.toggleRecording.mockResolvedValue(
			'The quick note is using the microphone.',
		);

		await expect(
			execute(services, COMMAND_IDS.startStopRecording),
		).resolves.toBe('The quick note is using the microphone.');
	});

	it('pauses and answers with the state it left', async () => {
		const services = createSut({ status: RecordingStatus.Paused });

		await expect(
			execute(services, COMMAND_IDS.pauseResumeRecording),
		).resolves.toBe('Recording, paused.');
		expect(services.recording.togglePauseResume).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			status: RecordingStatus.Recording,
			said: 'Quick note recording. Run the command again to stop.',
		},
		{
			status: RecordingStatus.Idle,
			said: 'Quick note stopped; its text goes into the note it was started in.',
		},
	])(
		'answers a quick note toggle with what it is doing now',
		async ({ status, said }) => {
			await expect(
				execute(
					createSut({ quickNote: status }),
					COMMAND_IDS.startStopQuickNote,
				),
			).resolves.toBe(said);
		},
	);

	it('targets the one recorder on every surface', async () => {
		const services = createSut();
		const family = sessionActionFamily(services);

		expect(family.activeTargets()).toEqual([services]);
		await expect(
			Promise.resolve(family.cliTarget.resolve({})),
		).resolves.toEqual([services]);
		expect(family.describe(services)).toBe('the recorder');
	});
});

describe('marking the recording from the command line', () => {
	it.each([
		{ commandId: COMMAND_IDS.addRecordingBookmark, kind: 'bookmark' },
		{ commandId: COMMAND_IDS.addRecordingChapter, kind: 'chapter' },
	])('drops a $kind with the label typed', async ({ commandId, kind }) => {
		const handle = makeHandle();
		const services = createSut({ handle });

		await expect(
			execute(services, commandId, { label: 'Decision' }),
		).resolves.toBe(`Decision added to the recording as a ${kind}.`);
		expect(handle.commit).toHaveBeenCalledWith('Decision', kind);
		expect(services.openMarkerModal).not.toHaveBeenCalled();
	});

	it('numbers the label when none is typed', async () => {
		const handle = makeHandle();

		await execute(createSut({ handle }), COMMAND_IDS.addRecordingBookmark);

		expect(handle.commit).toHaveBeenCalledWith('bookmark 3', 'bookmark');
	});

	it('drops the kind typed with the chooser command', async () => {
		const handle = makeHandle();

		await execute(createSut({ handle }), COMMAND_IDS.addRecordingMarker, {
			kind: 'bookmark',
		});

		expect(handle.commit).toHaveBeenCalledWith('bookmark 3', 'bookmark');
	});

	it('drops the kind used last when the chooser is given none', async () => {
		const handle = makeHandle();

		await execute(createSut({ handle }), COMMAND_IDS.addRecordingMarker);

		expect(handle.commit).toHaveBeenCalledWith('chapter 3', 'chapter');
	});

	it('refuses a kind that is not one', async () => {
		await expect(
			execute(createSut(), COMMAND_IDS.addRecordingMarker, {
				kind: 'note',
			}),
		).resolves.toBe('kind=note is not one of: bookmark, chapter.');
	});

	it('says why when no marker can be dropped', async () => {
		await expect(
			execute(
				createSut({ handle: null }),
				COMMAND_IDS.addRecordingChapter,
			),
		).resolves.toBe(
			'Nothing is recording, or markers are switched off in settings.',
		);
	});
});

describe('choosing the input device from the command line', () => {
	const devices = withMediaDevices(() => ({
		enumerateDevices: jest
			.fn()
			.mockResolvedValue([
				mediaDevice('default', 'Default - Microphone'),
				mediaDevice('usb-1', 'USB Headset'),
				mediaDevice('out-1', 'Speakers', 'audiooutput'),
			]),
	}));

	it('lists the inputs, the one chosen marked', async () => {
		const services = createSut();
		services.getSettings().audioDeviceId = 'usb-1';

		await expect(
			execute(services, COMMAND_IDS.selectAudioInputDevice),
		).resolves.toBe(
			'  Default - Microphone  id=default\n* USB Headset  id=usb-1',
		);
	});

	it.each([
		{ name: 'its id', args: { id: 'usb-1' } },
		{ name: 'a part of its name', args: { name: 'headset' } },
	])('chooses a device by $name', async ({ args }) => {
		const services = createSut();

		await expect(
			execute(services, COMMAND_IDS.selectAudioInputDevice, args),
		).resolves.toBe('Selected audio device: USB Headset');
		expect(services.getSettings().audioDeviceId).toBe('usb-1');
		expect(services.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('says no device matched', async () => {
		const services = createSut();

		await expect(
			execute(services, COMMAND_IDS.selectAudioInputDevice, {
				name: 'Zoom',
			}),
		).resolves.toBe(
			'No audio input device matches "Zoom". Run the command without id or name to list them.',
		);
		expect(services.saveSettings).not.toHaveBeenCalled();
	});

	it('says there are none', async () => {
		devices().enumerateDevices.mockResolvedValue([]);

		await expect(
			execute(createSut(), COMMAND_IDS.selectAudioInputDevice),
		).resolves.toBe('No audio input devices found.');
	});
});

describe('the session actions the command line cannot run now', () => {
	it.each([
		{
			commandId: COMMAND_IDS.startStopQuickNote,
			said: 'Quick notes are switched off in settings.',
		},
		{
			commandId: COMMAND_IDS.pauseResumeRecording,
			said: 'Nothing is recording.',
		},
		{
			commandId: COMMAND_IDS.selectAudioInputDevice,
			said: 'This platform records from its default microphone.',
		},
	])('says why for $commandId', ({ commandId, said }) => {
		const action = SESSION_ACTIONS.find(
			(entry) => entry.commandId === commandId,
		);

		expect(action?.cli.unavailable?.(createSut())).toBe(said);
	});
});
