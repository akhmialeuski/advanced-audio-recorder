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
import { loadPlugin } from '../helpers/pluginHarness';
import type { RecorderDouble } from '../mocks/modules/recordingManager';

jest.mock('src/ui/MarkerModal', () => ({
	RecordingMarkerModal: jest
		.fn()
		.mockImplementation(() => ({ open: jest.fn() })),
}));

/** The recording manager the plugin built, whose methods are all spies. */
function recorder(): RecorderDouble {
	return at(jest.mocked(RecordingManager).mock.results, 0).value;
}

/**
 * Loads the plugin over a recorder that is mid-recording with something to
 * report, which is the state every test here is about.
 * @returns The loaded plugin
 */
async function loadRecording(): Promise<AudioRecorderPlugin> {
	const { plugin } = await loadPlugin();
	const live = recorder();
	live.canDropMarker.mockReturnValue(true);
	live.captureMarkerDraft.mockReturnValue({ id: 'draft' });
	live.getElapsedMs.mockReturnValue(65_000);
	live.getRecordedBytes.mockReturnValue(2048);
	live.getInputLevel.mockReturnValue(0.5);
	return plugin;
}

/** The status-change callback the plugin handed the recording manager. */
function reportStatus(status: RecordingStatus, progress?: SaveProgress): void {
	const onStatusChange = at(jest.mocked(RecordingManager).mock.calls, 0)[2];
	recorder().getStatus.mockReturnValue(status);
	onStatusChange(status, progress);
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
		const plugin = await loadRecording();

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
		const plugin = await loadRecording();

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
		const plugin = await loadRecording();

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
			const plugin = await loadRecording();
			reportStatus(RecordingStatus.Recording);

			control(statusBar(plugin), label).dispatchEvent(
				new MouseEvent('click', { bubbles: true }),
			);

			expect(recorder()[command]).toHaveBeenCalled();
		},
	);

	it('offers a marker button, which opens the marker dialog', async () => {
		const plugin = await loadRecording();
		reportStatus(RecordingStatus.Recording);

		control(statusBar(plugin), 'Add marker').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(RecordingMarkerModal).toHaveBeenCalled();
	});

	it('offers no marker button when markers are switched off', async () => {
		// Markers are surfaced only by the enhanced player; a button that
		// drops them where nothing shows them would be a dead end.
		const plugin = await loadRecording();
		plugin.settings.playerEnableMarkers = false;

		reportStatus(RecordingStatus.Recording);

		expect(statusBar(plugin)).not.toHaveControl('Add marker');
	});

	it('says nothing happened when the recorder has no draft to give', async () => {
		const plugin = await loadRecording();
		reportStatus(RecordingStatus.Recording);
		recorder().captureMarkerDraft.mockReturnValue(null);

		control(statusBar(plugin), 'Add marker').dispatchEvent(
			new MouseEvent('click', { bubbles: true }),
		);

		expect(RecordingMarkerModal).not.toHaveBeenCalled();
	});

	it('shows the save progress once the recording stops', async () => {
		const plugin = await loadRecording();

		reportStatus(RecordingStatus.Saving, {
			percent: 40,
			description: 'Assembling audio...',
		});

		const bar = statusBar(plugin);
		expect(bar.textContent).toContain('Assembling audio...');
		expect(maybeEl(bar, STATUS.saveProgressBar)).not.toBeNull();
	});

	it('clears itself when the recording is done', async () => {
		const plugin = await loadRecording();
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
		const plugin = await loadRecording();
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

	it.each([
		{
			name: 'an elapsed time that is not a number',
			readings: { getElapsedMs: Number.NaN },
		},
		{
			name: 'a byte count that is not a number',
			readings: { getRecordedBytes: Number.NaN },
		},
		{
			name: 'an input level that is not a number',
			readings: { getInputLevel: Number.NaN },
		},
		{
			name: 'an input level past full scale',
			readings: { getInputLevel: 4 },
		},
		{
			name: 'a negative input level',
			readings: { getInputLevel: -1 },
		},
		{
			name: 'an elapsed time that went backwards',
			readings: { getElapsedMs: -1000 },
		},
	])('paints something readable for $name', async ({ readings }) => {
		// Every one of these is a reading, not a state: they come off a
		// clock and an analyser mid-recording, and any of them can go
		// briefly nonsensical on a device change or a paused-clock race.
		// The status bar is a text line the user reads, so "NaN" or a
		// meter overflowing its track is worse than a stale number.
		const plugin = await loadRecording();
		for (const [method, value] of Object.entries(readings)) {
			recorder()[method as 'getElapsedMs'].mockReturnValue(value);
		}
		reportStatus(RecordingStatus.Recording);

		jest.advanceTimersByTime(2000);

		const bar = statusBar(plugin);
		expect(bar.textContent).not.toContain('NaN');
		expect(bar.textContent).not.toContain('Infinity');
		const fill = el(bar, STATUS.inputMeterFill).style.getPropertyValue(
			'--aar-meter-fill',
		);
		const percent = Number.parseFloat(fill);
		expect(percent).toBeGreaterThanOrEqual(0);
		expect(percent).toBeLessThanOrEqual(100);
	});

	it('does not tick while nothing is being recorded', async () => {
		// The interval runs for the whole session; asking the recorder for
		// numbers it does not have would repaint the bar over a playback.
		const plugin = await loadRecording();
		reportStatus(RecordingStatus.Idle);
		recorder().getElapsedMs.mockClear();

		jest.advanceTimersByTime(2000);

		expect(recorder().getElapsedMs).not.toHaveBeenCalled();
		expect(statusBar(plugin).textContent).toBe('');
	});
});

describe('the mobile recording banner', () => {
	it('appears while recording on a device that uses it', async () => {
		const plugin = await loadRecording();
		setPlatform({ isMobile: true, isMobileApp: true });

		reportStatus(RecordingStatus.Recording);

		expect(maybeEl(document.body, BANNER.root)).not.toBeNull();
		expect(plugin.settings.mobileRecordingBanner).toBe(true);
	});

	it('marks itself paused while the recording is', async () => {
		await loadRecording();
		setPlatform({ isMobile: true, isMobileApp: true });

		reportStatus(RecordingStatus.Paused);

		expect(
			el(document.body, BANNER.root).classList.contains('is-paused'),
		).toBe(true);
	});

	it('stops the recording from its own stop control', async () => {
		await loadRecording();
		setPlatform({ isMobile: true, isMobileApp: true });
		reportStatus(RecordingStatus.Recording);

		el(document.body, BANNER.stop).click();

		expect(recorder().stopRecording).toHaveBeenCalled();
	});

	it('leaves when the recording does', async () => {
		await loadRecording();
		setPlatform({ isMobile: true, isMobileApp: true });
		reportStatus(RecordingStatus.Recording);

		reportStatus(RecordingStatus.Idle);

		expect(maybeEl(document.body, BANNER.root)).toBeNull();
	});

	it('stays away on a device that shows the status bar instead', async () => {
		await loadRecording();
		setPlatform({ isMobile: false, isMobileApp: false });

		reportStatus(RecordingStatus.Recording);

		expect(maybeEl(document.body, BANNER.root)).toBeNull();
	});

	it('stays away when the user switched it off', async () => {
		const plugin = await loadRecording();
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
		const plugin = await loadRecording();
		reportStatus(RecordingStatus.Idle);

		reportPlayback(plugin);

		expect(statusBar(plugin)).toHaveControl('Stop playback');
		expect(statusBar(plugin)).toShowTime('1:05 / 3:42');
	});

	it('gives way to a recording that starts under it', async () => {
		const plugin = await loadRecording();
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
		const plugin = await loadRecording();
		reportStatus(RecordingStatus.Recording);

		asMockPlugin(plugin).invokeCommand(id);

		expect(recorder().captureMarkerDraft).toHaveBeenCalledWith(kind);
		expect(RecordingMarkerModal).toHaveBeenCalled();
	});

	it.each([
		COMMAND_IDS.addRecordingBookmark,
		COMMAND_IDS.addRecordingChapter,
	])('hides %s while no recording can take one', async (id) => {
		const plugin = await loadRecording();
		recorder().canDropMarker.mockReturnValue(false);

		expect(asMockPlugin(plugin).invokeCommand(id)).toBe(false);
		expect(recorder().captureMarkerDraft).not.toHaveBeenCalled();
	});
});
