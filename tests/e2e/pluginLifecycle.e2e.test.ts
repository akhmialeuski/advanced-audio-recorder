/**
 * The plugin from load to unload, driven the way Obsidian drives it.
 *
 * Every other suite starts partway in: it builds a service and exercises it.
 * Nothing had ever loaded the plugin, run a command out of the palette, and
 * unloaded it again - which is why main.ts sat at 51% functions with its
 * command callbacks, its teardown, and the closures it hands to its services
 * all unexecuted.
 *
 * These tests reach the plugin only through what Obsidian offers a user: the
 * command palette, the ribbon icon, the settings tab, and the lifecycle hooks.
 * @module tests/e2e/pluginLifecycle.e2e.test
 */

import { COMMAND_IDS } from 'src/constants';
import { at } from '../helpers/assertions';
import { asMockPlugin } from '../helpers/obsidianMock';
import { setPlatform } from '../helpers/platform';
import { showDeviceSelectionModal } from 'src/ui/DeviceSelectionModal';
import { RecordingManager } from 'src/recording/RecordingManager';
import { App } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { validateSettings } from 'src/settings/settingsValidation';
import { loadPlugin, MANIFEST } from '../helpers/pluginHarness';

// The plugin's collaborators are each covered by their own suite. What is
// under test here is the wiring between them, so they are recorded rather
// than reproduced.
jest.mock('src/ui/DeviceSelectionModal', () => ({
	showDeviceSelectionModal: jest.fn().mockResolvedValue(undefined),
}));

/** The methods the recording-manager double offers, all of them spies. */
interface RecorderDouble {
	toggleRecording: jest.Mock;
	togglePauseResume: jest.Mock;
	stopRecording: jest.Mock;
	cleanup: jest.Mock;
	updateSettings: jest.Mock;
	getStatus: jest.Mock;
	canDropMarker: jest.Mock;
	captureMarkerDraft: jest.Mock;
	getElapsedMs: jest.Mock;
	getRecordedBytes: jest.Mock;
	getInputLevel: jest.Mock;
}

/**
 * The recording manager the plugin built.
 * @returns The double, so a test can script it or assert on it
 */
function recorder(): RecorderDouble {
	return at(jest.mocked(RecordingManager).mock.results, 0)
		.value as RecorderDouble;
}

describe('loading the plugin', () => {
	it('registers the recording commands in the palette', async () => {
		const { plugin } = await loadPlugin();

		const ids = asMockPlugin(plugin).registeredCommands.map(
			(command) => command.id,
		);
		expect(ids).toContain(COMMAND_IDS.startStopRecording);
		expect(ids).toContain(COMMAND_IDS.pauseResumeRecording);
		expect(ids).toContain(COMMAND_IDS.addRecordingMarker);
		expect(ids).toContain(COMMAND_IDS.selectAudioInputDevice);
	});

	it('registers every file action as a command, so each is hotkey-assignable', async () => {
		const { plugin } = await loadPlugin();

		const ids = asMockPlugin(plugin).registeredCommands.map(
			(command) => command.id,
		);
		expect(ids).toContain(COMMAND_IDS.convertAudioFormat);
		expect(ids).toContain(COMMAND_IDS.splitAudio);
		expect(ids).toContain(COMMAND_IDS.transcribeAudio);
	});

	it('gives every command a name', async () => {
		const { plugin } = await loadPlugin();

		for (const command of asMockPlugin(plugin).registeredCommands) {
			expect(command.name).not.toBe('');
		}
	});

	it('registers no command twice', async () => {
		const { plugin } = await loadPlugin();

		const ids = asMockPlugin(plugin).registeredCommands.map(
			(command) => command.id,
		);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('adds the ribbon icon, the status bar item, and the settings tab', async () => {
		const { plugin } = await loadPlugin();
		const mock = asMockPlugin(plugin);

		expect(mock.ribbonIcons).toHaveLength(1);
		expect(mock.statusBarItems).toHaveLength(1);
		expect(mock.settingTabs).toHaveLength(1);
	});

	it('keeps the live-stats pump on an interval it can release', async () => {
		const { plugin } = await loadPlugin();

		expect(asMockPlugin(plugin).registeredIntervals.length).toBeGreaterThan(
			0,
		);
	});
});

describe('the recording commands', () => {
	it('starts and stops recording from the palette', async () => {
		const { plugin } = await loadPlugin();

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.startStopRecording);

		expect(recorder().toggleRecording).toHaveBeenCalled();
	});

	it('pauses and resumes from the palette', async () => {
		const { plugin } = await loadPlugin();

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.pauseResumeRecording);

		expect(recorder().togglePauseResume).toHaveBeenCalled();
	});

	it('hides the marker command while no recording can take one', async () => {
		const { plugin } = await loadPlugin();
		recorder().canDropMarker.mockReturnValue(false);

		const available = asMockPlugin(plugin).invokeCommand(
			COMMAND_IDS.addRecordingMarker,
		);

		// A palette entry that does nothing is worse than no entry.
		expect(available).toBe(false);
		expect(recorder().captureMarkerDraft).not.toHaveBeenCalled();
	});

	it('offers the marker command once a recording can take one', async () => {
		const { plugin } = await loadPlugin();
		recorder().canDropMarker.mockReturnValue(true);

		const available = asMockPlugin(plugin).invokeCommand(
			COMMAND_IDS.addRecordingMarker,
		);

		expect(available).toBe(true);
		expect(recorder().captureMarkerDraft).toHaveBeenCalled();
	});

	it('drops the marker command when the recorder has no draft to give', async () => {
		const { plugin } = await loadPlugin();
		recorder().canDropMarker.mockReturnValue(true);
		recorder().captureMarkerDraft.mockReturnValue(null);

		expect(() => {
			asMockPlugin(plugin).invokeCommand(COMMAND_IDS.addRecordingMarker);
		}).not.toThrow();
	});
});

describe('the device selection command', () => {
	it('is hidden on a device that records from the default microphone', async () => {
		const { plugin } = await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });

		const available = asMockPlugin(plugin).invokeCommand(
			COMMAND_IDS.selectAudioInputDevice,
		);

		expect(available).toBe(false);
		expect(showDeviceSelectionModal).not.toHaveBeenCalled();
	});

	it('opens the picker on a device that can choose an input', async () => {
		const { plugin } = await loadPlugin();
		setPlatform({ isMobile: false, isMobileApp: false });

		const available = asMockPlugin(plugin).invokeCommand(
			COMMAND_IDS.selectAudioInputDevice,
		);

		expect(available).toBe(true);
		expect(showDeviceSelectionModal).toHaveBeenCalled();
	});

	it('remembers the device that was picked', async () => {
		const { plugin } = await loadPlugin();
		setPlatform({ isMobile: false, isMobileApp: false });
		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.selectAudioInputDevice);
		const [, onPicked] = at(
			jest.mocked(showDeviceSelectionModal).mock.calls,
			0,
		);

		await onPicked('usb-mic', 'USB Microphone');

		expect(plugin.settings.audioDeviceId).toBe('usb-mic');
		expect(
			(plugin as unknown as { saveData: jest.Mock }).saveData,
		).toHaveBeenCalled();
	});
});

describe('unloading the plugin', () => {
	it('releases the recorder and the player registrar', async () => {
		const { plugin } = await loadPlugin();

		plugin.onunload();

		expect(recorder().cleanup).toHaveBeenCalled();
	});

	it('leaves the ribbon icon and status bar in their idle state', async () => {
		const { plugin } = await loadPlugin();
		const mock = asMockPlugin(plugin);

		plugin.onunload();

		// A plugin that unloads mid-recording must not leave a red dot behind.
		expect(at(mock.ribbonIcons, 0).el.classList).not.toContain(
			'is-recording',
		);
		expect(at(mock.statusBarItems, 0).textContent).toBe('');
	});

	it('can be unloaded twice without complaint', async () => {
		const { plugin } = await loadPlugin();

		plugin.onunload();

		expect(() => {
			plugin.onunload();
		}).not.toThrow();
	});
});

describe('loading the plugin when its stored settings are unusable', () => {
	/**
	 * Loads the plugin over a data.json read that misbehaves.
	 * @param loadData - Stands in for Obsidian's data.json read
	 * @returns The loaded plugin
	 */
	async function loadOverBadData(
		loadData: jest.Mock,
	): Promise<AudioRecorderPlugin> {
		const plugin = new AudioRecorderPlugin(new App(), MANIFEST);
		const persistence = plugin as unknown as Record<string, unknown>;
		persistence.loadData = loadData;
		persistence.saveData = jest.fn().mockResolvedValue(undefined);
		await plugin.onload();
		return plugin;
	}

	it.each([
		{
			name: 'the read itself fails',
			loadData: (): jest.Mock =>
				jest.fn().mockRejectedValue(new Error('vault is read-only')),
		},
		{
			name: 'data.json holds a string',
			loadData: (): jest.Mock => jest.fn().mockResolvedValue('nonsense'),
		},
		{
			name: 'data.json holds a number',
			loadData: (): jest.Mock => jest.fn().mockResolvedValue(42),
		},
		{
			name: 'data.json holds a list',
			loadData: (): jest.Mock => jest.fn().mockResolvedValue([]),
		},
	])('still loads when $name', async ({ loadData }) => {
		// data.json is a file on disk that a sync conflict, a failed write, or
		// a hand edit can leave in any shape. A plugin that throws out of
		// onload is a plugin Obsidian shows as broken with no way back, so
		// every one of these has to degrade to the defaults instead.
		const plugin = await loadOverBadData(loadData());

		expect(plugin.settings.recordingFormat).toBe(
			DEFAULT_SETTINGS.recordingFormat,
		);
		expect(plugin.settings.bitrate).toBe(DEFAULT_SETTINGS.bitrate);
		// Degrading is only useful if the plugin is still operable afterwards.
		expect(
			asMockPlugin(plugin).registeredCommands.map(
				(command) => command.id,
			),
		).toContain(COMMAND_IDS.startStopRecording);
	});

	it('loads with a setting of the wrong type, and refuses to record on it', async () => {
		// The merge is a spread over the defaults, so a value of the wrong
		// type survives it rather than being replaced. That is deliberate -
		// the merge is not a schema - and it is why the settings are
		// validated again before a recording starts, which is the point this
		// pins: the plugin comes up, and the bad value never reaches
		// MediaRecorder as audioBitsPerSecond.
		const plugin = await loadOverBadData(
			jest.fn().mockResolvedValue({
				bitrate: 'loud',
				audioDeviceId: 'mic-1',
			}),
		);

		expect(plugin.settings.bitrate).toBe('loud');
		expect(() => {
			validateSettings(plugin.settings);
		}).toThrow(expect.objectContaining({ field: 'bitrate' }));
	});
});
