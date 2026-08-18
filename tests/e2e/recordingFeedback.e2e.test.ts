/**
 * What the user sees while a recording runs, driven through the plugin.
 *
 * The status bar, the ribbon icon, the mobile banner, and the live elapsed
 * time are all rendered by closures main.ts hands to its collaborators - the
 * status-change callback, the ribbon click handler, the interval it registers.
 * Every other suite tests the renderers with the state passed in by hand;
 * nothing had ever driven them from the plugin, so the wiring between "the
 * recorder changed state" and "the status bar shows it" was unrun.
 * @module tests/e2e/recordingFeedback.e2e.test
 */

import { App } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import AudioRecorderPlugin from 'src/main';
import { RecordingStatus } from 'src/types';
import type { SaveProgress } from 'src/types';
import { COMMAND_IDS } from 'src/constants';
import { MARKER_KIND } from 'src/markers/markerModel';
import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingMarkerModal } from 'src/ui/MarkerModal';
import { at } from '../helpers/assertions';
import { allEls, control, el, maybeEl } from '../helpers/dom';
import { asMockPlugin } from '../helpers/obsidianMock';
import { setPlatform, useDesktopPlatform } from '../helpers/platform';
import { BANNER, PLAYER, STATUS } from '../helpers/selectors';
import { addObsidianDomExtensions } from '../mocks/domExtensions';
import { partial } from '../helpers/doubles';

jest.mock('src/recording/RecordingManager', () => ({
	RecordingManager: jest.fn().mockImplementation(() => ({
		toggleRecording: jest.fn().mockResolvedValue(undefined),
		togglePauseResume: jest.fn(),
		stopRecording: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn(),
		updateSettings: jest.fn(),
		getStatus: jest.fn(() => RecordingStatus.Recording),
		canDropMarker: jest.fn(() => true),
		captureMarkerDraft: jest.fn(() => ({ id: 'draft' })),
		getElapsedMs: jest.fn(() => 65_000),
		getRecordedBytes: jest.fn(() => 2048),
		getInputLevel: jest.fn(() => 0.5),
	})),
}));
jest.mock('src/ui/ContextMenu', () => ({
	ContextMenu: jest.fn().mockImplementation(() => ({ register: jest.fn() })),
}));
jest.mock('src/player/EnhancedPlayerRegistrar', () => ({
	EnhancedPlayerRegistrar: jest.fn().mockImplementation(() => ({
		register: jest.fn(),
		dispose: jest.fn(),
		refresh: jest.fn(),
		subscribePlayback: jest.fn(),
		reloadMarkersFor: jest.fn(),
		primeSavedRecordingsForEnhancement: jest.fn(),
	})),
}));
jest.mock('src/ui/MarkerModal', () => ({
	RecordingMarkerModal: jest
		.fn()
		.mockImplementation(() => ({ open: jest.fn() })),
}));
jest.mock('src/recording/RecoveryService', () => ({
	collectRecoverableSessions: jest.fn().mockResolvedValue([]),
	recoverSession: jest
		.fn()
		.mockResolvedValue({ recoveredPaths: [], failedTracks: [] }),
	discardSession: jest.fn().mockResolvedValue([]),
}));

const MANIFEST = partial<PluginManifest>({
	id: 'advanced-audio-recorder',
	name: 'Advanced Audio Recorder',
	version: '2.2.2',
	dir: 'config-dir/plugins/advanced-audio-recorder',
});

/** The recording manager the plugin built, whose methods are all spies. */
interface RecorderDouble {
	toggleRecording: jest.Mock;
	togglePauseResume: jest.Mock;
	stopRecording: jest.Mock;
	getStatus: jest.Mock;
	canDropMarker: jest.Mock;
	captureMarkerDraft: jest.Mock;
	getElapsedMs: jest.Mock;
	getRecordedBytes: jest.Mock;
	getInputLevel: jest.Mock;
}

/** The recording manager the plugin built, whose methods are all spies. */
function recorder(): RecorderDouble {
	return at(jest.mocked(RecordingManager).mock.results, 0)
		.value as RecorderDouble;
}

/** The status-change callback the plugin handed the recording manager. */
function reportStatus(status: RecordingStatus, progress?: SaveProgress): void {
	const onStatusChange = at(jest.mocked(RecordingManager).mock.calls, 0)[2];
	recorder().getStatus.mockReturnValue(status);
	onStatusChange(status, progress);
}

/** Loads the plugin the way Obsidian does and hands it back. */
async function loadPlugin(): Promise<AudioRecorderPlugin> {
	const plugin = new AudioRecorderPlugin(new App(), MANIFEST);
	const store = plugin as unknown as Record<string, unknown>;
	store.loadData = jest.fn().mockResolvedValue(null);
	store.saveData = jest.fn().mockResolvedValue(undefined);
	await plugin.onload();
	return plugin;
}

/** The status bar element the plugin renders into. */
function statusBar(plugin: AudioRecorderPlugin): HTMLElement {
	return at(asMockPlugin(plugin).statusBarItems, 0);
}

// Obsidian extends the real document.body with createDiv/createSpan, which is
// how the banner mounts itself; jsdom's body needs the same.
beforeAll(() => {
	addObsidianDomExtensions(document.body);
});

afterEach(() => {
	useDesktopPlatform();
	document.body.innerHTML = '';
});

describe('the ribbon icon', () => {
	it('starts and stops a recording when it is clicked', async () => {
		const plugin = await loadPlugin();

		at(asMockPlugin(plugin).ribbonIcons, 0).callback(
			new MouseEvent('click'),
		);

		expect(recorder().toggleRecording).toHaveBeenCalled();
	});

	it.each([
		{ name: 'recording', status: RecordingStatus.Recording, active: true },
		{ name: 'paused', status: RecordingStatus.Paused, active: true },
		{ name: 'idle', status: RecordingStatus.Idle, active: false },
	])('shows the $name state on the icon', async ({ status, active }) => {
		const plugin = await loadPlugin();

		reportStatus(status);

		expect(
			at(asMockPlugin(plugin).ribbonIcons, 0).el.classList.contains(
				'is-recording',
			),
		).toBe(active);
	});
});

describe('the status bar during a recording', () => {
	it('says it is recording, with the controls to stop it', async () => {
		const plugin = await loadPlugin();

		reportStatus(RecordingStatus.Recording);

		const bar = statusBar(plugin);
		expect(el(bar, STATUS.recordingLabel).textContent).toBe('Recording...');
		expect(bar).toHaveControl('Pause recording');
		expect(bar).toHaveControl('Stop recording');
	});

	it.each([
		{ label: 'Pause recording', command: 'togglePauseResume' },
		{ label: 'Stop recording', command: 'stopRecording' },
	] satisfies { label: string; command: keyof RecorderDouble }[])(
		'$label reaches the recorder',
		async ({ label, command }) => {
			const plugin = await loadPlugin();
			reportStatus(RecordingStatus.Recording);

			control(statusBar(plugin), label).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);

			expect(recorder()[command]).toHaveBeenCalled();
		},
	);

	it('offers a marker button, which opens the marker dialog', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Recording);

		control(statusBar(plugin), 'Add marker').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(RecordingMarkerModal).toHaveBeenCalled();
	});

	it('offers no marker button when markers are switched off', async () => {
		// Markers are surfaced only by the enhanced player; a button that
		// drops them where nothing shows them would be a dead end.
		const plugin = await loadPlugin();
		plugin.settings.playerEnableMarkers = false;

		reportStatus(RecordingStatus.Recording);

		expect(statusBar(plugin)).not.toHaveControl('Add marker');
	});

	it('says nothing happened when the recorder has no draft to give', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Recording);
		recorder().captureMarkerDraft.mockReturnValue(null);

		control(statusBar(plugin), 'Add marker').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(RecordingMarkerModal).not.toHaveBeenCalled();
	});

	it('shows the save progress once the recording stops', async () => {
		const plugin = await loadPlugin();

		reportStatus(RecordingStatus.Saving, {
			percent: 40,
			description: 'Assembling audio...',
		});

		const bar = statusBar(plugin);
		expect(bar.textContent).toContain('Assembling audio...');
		expect(maybeEl(bar, STATUS.saveProgressBar)).not.toBeNull();
	});

	it('clears itself when the recording is done', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Recording);

		reportStatus(RecordingStatus.Idle);

		expect(statusBar(plugin).textContent).toBe('');
		expect(allEls(statusBar(plugin), PLAYER.controlButton)).toHaveLength(0);
	});
});

describe('the live indicators', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('ticks the elapsed time, the size, and the input level', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Recording);

		jest.advanceTimersByTime(2000);

		const bar = statusBar(plugin);
		expect(el(bar, STATUS.elapsed).textContent).toBe('1:05');
		expect(el(bar, STATUS.recordedSize).textContent).toBe('2.0 KB');
		expect(
			el(bar, STATUS.inputMeterFill).style.getPropertyValue(
				'--aar-meter-fill',
			),
		).toBe('50%');
	});

	it('does not tick while nothing is being recorded', async () => {
		// The interval runs for the whole session; asking the recorder for
		// numbers it does not have would repaint the bar over a playback.
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Idle);
		recorder().getElapsedMs.mockClear();

		jest.advanceTimersByTime(2000);

		expect(recorder().getElapsedMs).not.toHaveBeenCalled();
		expect(statusBar(plugin).textContent).toBe('');
	});
});

describe('the mobile recording banner', () => {
	it('appears while recording on a device that uses it', async () => {
		const plugin = await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });

		reportStatus(RecordingStatus.Recording);

		expect(maybeEl(document.body, BANNER.root)).not.toBeNull();
		expect(plugin.settings.mobileRecordingBanner).toBe(true);
	});

	it('marks itself paused while the recording is', async () => {
		await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });

		reportStatus(RecordingStatus.Paused);

		expect(
			el(document.body, BANNER.root).classList.contains('is-paused'),
		).toBe(true);
	});

	it('stops the recording from its own stop control', async () => {
		await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });
		reportStatus(RecordingStatus.Recording);

		el(document.body, BANNER.stop).click();

		expect(recorder().stopRecording).toHaveBeenCalled();
	});

	it('leaves when the recording does', async () => {
		await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });
		reportStatus(RecordingStatus.Recording);

		reportStatus(RecordingStatus.Idle);

		expect(maybeEl(document.body, BANNER.root)).toBeNull();
	});

	it('stays away on a device that shows the status bar instead', async () => {
		await loadPlugin();
		setPlatform({ isMobile: false, isMobileApp: false });

		reportStatus(RecordingStatus.Recording);

		expect(maybeEl(document.body, BANNER.root)).toBeNull();
	});

	it('stays away when the user switched it off', async () => {
		const plugin = await loadPlugin();
		setPlatform({ isMobile: true, isMobileApp: true });
		plugin.settings.mobileRecordingBanner = false;

		reportStatus(RecordingStatus.Recording);

		expect(maybeEl(document.body, BANNER.root)).toBeNull();
	});
});

describe('playback taking over the status bar', () => {
	/** The playback snapshot callback the player registrar was given. */
	function reportPlayback(plugin: AudioRecorderPlugin): void {
		const registrar = (
			plugin as unknown as {
				playerRegistrar: { subscribePlayback: jest.Mock };
			}
		).playerRegistrar;
		const onPlayback = at(registrar.subscribePlayback.mock.calls, 0)[0] as (
			state: unknown,
		) => void;
		onPlayback({
			currentTime: 65,
			duration: 222,
			paused: false,
			volume: 1,
			muted: false,
			markersEnabled: false,
			onTogglePlay: jest.fn(),
			onStop: jest.fn(),
			onSkip: jest.fn(),
			onToggleMute: jest.fn(),
			onVolumeInput: jest.fn(),
			onAddMarker: jest.fn(),
		});
	}

	it('shows the transport while nothing is being recorded', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Idle);

		reportPlayback(plugin);

		expect(statusBar(plugin)).toHaveControl('Stop playback');
		expect(statusBar(plugin)).toShowTime('1:05 / 3:42');
	});

	it('gives way to a recording that starts under it', async () => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Idle);
		reportPlayback(plugin);

		reportStatus(RecordingStatus.Recording);

		expect(statusBar(plugin)).not.toHaveControl('Stop playback');
		expect(statusBar(plugin).textContent).toContain('Recording...');
	});
});

describe('dropping a marker from the palette', () => {
	it.each([
		{
			name: 'a bookmark',
			id: COMMAND_IDS.addRecordingBookmark,
			kind: MARKER_KIND.bookmark,
		},
		{
			name: 'a chapter',
			id: COMMAND_IDS.addRecordingChapter,
			kind: MARKER_KIND.chapter,
		},
	])('drops $name at the current position', async ({ id, kind }) => {
		const plugin = await loadPlugin();
		reportStatus(RecordingStatus.Recording);

		asMockPlugin(plugin).invokeCommand(id);

		expect(recorder().captureMarkerDraft).toHaveBeenCalledWith(kind);
		expect(RecordingMarkerModal).toHaveBeenCalled();
	});

	it.each([
		COMMAND_IDS.addRecordingBookmark,
		COMMAND_IDS.addRecordingChapter,
	])('hides %s while no recording can take one', async (id) => {
		const plugin = await loadPlugin();
		recorder().canDropMarker.mockReturnValue(false);

		expect(asMockPlugin(plugin).invokeCommand(id)).toBe(false);
		expect(recorder().captureMarkerDraft).not.toHaveBeenCalled();
	});
});
