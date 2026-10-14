/**
 * The recording panel from the plugin's side: registered as a view, put in
 * the right sidebar once on the first start, and opened from the palette.
 * @module tests/e2e/recordingPanel.e2e.test
 */

import { App } from 'obsidian';
import {
	COMMAND_IDS,
	RECORDING_PANEL_PLACED_KEY,
	RECORDING_PANEL_VIEW_TYPE,
} from 'src/constants';
import { flushMicrotasks } from '../helpers/async';
import {
	asMockApp,
	asMockPlugin,
	asMockVault,
	asMockWorkspace,
	headerAction,
} from '../helpers/obsidianMock';
import {
	hasSettingRow,
	rowDescription,
	settingRow,
} from '../helpers/settingRows';
import { modalInstances } from '../mocks/obsidian';
import { loadPlugin } from '../helpers/pluginHarness';
import { RecordingPanelView } from 'src/panel/RecordingPanelView';
import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingStatus } from 'src/types';
import { at } from '../helpers/assertions';
import { withApiVersion } from '../helpers/apiVersion';
import type { RecorderDouble } from '../mocks/modules/recordingManager';
import { probeDurationSeconds } from 'src/utils/AudioFileAnalyzer';

// The container probe reads real media, which jsdom cannot play; what is
// under test is what the panel makes of its answer.
jest.mock('src/utils/AudioFileAnalyzer', () => ({
	...jest.requireActual<object>('src/utils/AudioFileAnalyzer'),
	probeDurationSeconds: jest.fn(),
}));

describe('the recording panel', () => {
	it('is registered as a view Obsidian can restore', async () => {
		const { plugin } = await loadPlugin();

		expect(
			asMockPlugin(plugin).registeredViews.has(RECORDING_PANEL_VIEW_TYPE),
		).toBe(true);
	});

	it('is put in the right sidebar on the first start, without taking focus', async () => {
		const { app } = await loadPlugin();
		await flushMicrotasks();

		expect(
			asMockWorkspace(app.workspace).ensureSideLeaf,
		).toHaveBeenCalledWith(RECORDING_PANEL_VIEW_TYPE, 'right', {
			active: false,
			reveal: false,
		});
	});

	it('remembers on this device that it was placed', async () => {
		const { app } = await loadPlugin();
		await flushMicrotasks();

		expect(
			asMockApp(app).localStorage.get(RECORDING_PANEL_PLACED_KEY),
		).toBe(true);
	});

	it('leaves the synced settings alone when it places the panel', async () => {
		const { saveData } = await loadPlugin({
			lastReleaseNotesVersion: '2.2.2',
		});
		await flushMicrotasks();

		expect(saveData).not.toHaveBeenCalled();
	});

	it('is not put back after the user closed it', async () => {
		const { app } = await loadPlugin(null, placedApp());
		await flushMicrotasks();

		expect(
			asMockWorkspace(app.workspace).ensureSideLeaf,
		).not.toHaveBeenCalled();
	});

	it('is left to the palette on an app without local storage', async () => {
		withApiVersion('1.8.6');
		const { app } = await loadPlugin();
		await flushMicrotasks();

		expect(
			asMockWorkspace(app.workspace).ensureSideLeaf,
		).not.toHaveBeenCalled();
	});

	it('is placed again next time when placing it failed', async () => {
		const app = new App();
		asMockWorkspace(app.workspace).ensureSideLeaf.mockRejectedValue(
			new Error('layout not ready'),
		);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		await loadPlugin(null, app);
		await flushMicrotasks();

		expect(
			asMockApp(app).localStorage.has(RECORDING_PANEL_PLACED_KEY),
		).toBe(false);
	});

	it('opens from the palette and is brought into view', async () => {
		const { plugin, app } = await loadPlugin(null, placedApp());
		const workspace = asMockWorkspace(app.workspace);

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.openRecordingPanel);
		await flushMicrotasks();

		expect(workspace.ensureSideLeaf).toHaveBeenCalledWith(
			RECORDING_PANEL_VIEW_TYPE,
			'right',
			{ active: true, reveal: true },
		);
	});

	it('builds the panel view for a leaf Obsidian hands it', async () => {
		const { plugin, app } = await loadPlugin(null, placedApp());
		const factory = asMockPlugin(plugin).registeredViews.get(
			RECORDING_PANEL_VIEW_TYPE,
		);

		const view = factory?.(
			asMockWorkspace(app.workspace).getRightLeaf(false)!,
		);

		expect(view).toBeInstanceOf(RecordingPanelView);
	});
});

/**
 * An app on a device where the panel was placed before, so loading the
 * plugin does not place it again.
 * @returns The app
 */
function placedApp(): App {
	const app = new App();
	asMockApp(app).localStorage.set(RECORDING_PANEL_PLACED_KEY, true);
	return app;
}

/**
 * The panel view the plugin's factory builds, opened over the app.
 * @returns The plugin, its app, and the open view
 */
async function openPanel(): Promise<{
	view: RecordingPanelView;
	app: Awaited<ReturnType<typeof loadPlugin>>['app'];
	plugin: Awaited<ReturnType<typeof loadPlugin>>['plugin'];
}> {
	const { plugin, app } = await loadPlugin(null, placedApp());
	const leaf = asMockWorkspace(app.workspace).getRightLeaf(false)!;
	const factory = asMockPlugin(plugin).registeredViews.get(
		RECORDING_PANEL_VIEW_TYPE,
	)!;
	const view = factory(leaf) as unknown as RecordingPanelView;
	leaf.view = view;
	await view.onOpen();
	return { view, app, plugin };
}

describe('the recording panel on an Obsidian without side-leaf support', () => {
	it('brings an open panel into view from the palette', async () => {
		withApiVersion('1.6.6');
		const { plugin, app } = await loadPlugin(null, placedApp());
		const workspace = asMockWorkspace(app.workspace);
		const open = workspace.getRightLeaf(false)!;
		workspace.getLeavesOfType.mockReturnValue([open]);

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.openRecordingPanel);
		await flushMicrotasks();

		expect(workspace.setActiveLeaf).toHaveBeenCalledWith(open, {
			focus: true,
		});
	});

	it('opens a new right sidebar tab from the palette when none is open', async () => {
		withApiVersion('1.6.6');
		const { plugin, app } = await loadPlugin(null, placedApp());
		const workspace = asMockWorkspace(app.workspace);

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.openRecordingPanel);
		await flushMicrotasks();

		expect(at(workspace.rightLeaves, 0).viewState).toEqual({
			type: RECORDING_PANEL_VIEW_TYPE,
			active: true,
		});
	});

	it('does nothing from the palette when there is no sidebar to open in', async () => {
		withApiVersion('1.6.6');
		const { plugin, app } = await loadPlugin(null, placedApp());
		const workspace = asMockWorkspace(app.workspace);
		workspace.getRightLeaf.mockReturnValue(null);

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.openRecordingPanel);
		await flushMicrotasks();

		expect(workspace.setActiveLeaf).not.toHaveBeenCalled();
	});

	it('expands the sidebar it sits in when that sidebar is collapsed', async () => {
		withApiVersion('1.6.6');
		const { plugin, app } = await loadPlugin(null, placedApp());
		const workspace = asMockWorkspace(app.workspace);
		workspace.getLeavesOfType.mockReturnValue([
			workspace.getRightLeaf(false),
		]);
		workspace.rightSplit.collapsed = true;

		asMockPlugin(plugin).invokeCommand(COMMAND_IDS.openRecordingPanel);
		await flushMicrotasks();

		expect(workspace.rightSplit.collapsed).toBe(false);
	});
});

describe('settings changing under an open panel', () => {
	it('redraws the panel so its switches follow', async () => {
		const { view, app, plugin } = await openPanel();
		asMockWorkspace(app.workspace).getLeavesOfType.mockReturnValue([
			view.leaf,
		]);
		plugin.settings.transcriptionEnabled = true;

		await plugin.saveSettings();
		await flushMicrotasks();

		expect(
			hasSettingRow(view.contentEl, 'Transcribe after recording'),
		).toBe(true);
	});
});

describe('the recording panel wired to the plugin', () => {
	it('is titled with the plugin name', async () => {
		const { view } = await openPanel();

		expect(view.getDisplayText()).toBe('Advanced Audio Recorder');
	});

	it('starts the recorder from its record button', async () => {
		const { view } = await openPanel();
		const recorder = at(jest.mocked(RecordingManager).mock.results, 0)
			.value as RecorderDouble;

		headerAction(view, 'Start recording').click();

		expect(recorder.toggleRecording).toHaveBeenCalledTimes(1);
	});

	it('turns its record button into a stop button once recording starts', async () => {
		const { view, app } = await openPanel();
		const recorder = at(jest.mocked(RecordingManager).mock.results, 0)
			.value as RecorderDouble;
		const onStatus = at(jest.mocked(RecordingManager).mock.calls, 0)[2];
		asMockWorkspace(app.workspace).getLeavesOfType.mockReturnValue([
			view.leaf,
		]);
		recorder.getStatus.mockReturnValue(RecordingStatus.Recording);

		onStatus(RecordingStatus.Recording);

		expect(headerAction(view, 'Stop recording').dataset.icon).toBe(
			'square',
		);
	});

	it('opens the plugin settings from its header', async () => {
		const { view, app } = await openPanel();
		const settingsDialog = { open: jest.fn(), openTabById: jest.fn() };
		app.setting = settingsDialog;

		headerAction(view, 'Open settings').click();

		expect(settingsDialog.openTabById).toHaveBeenCalledWith(
			'advanced-audio-recorder',
		);
	});

	it('shows the transcription queue from its header', async () => {
		const { view } = await openPanel();

		headerAction(view, 'Show the transcription queue').click();

		expect(modalInstances).toHaveLength(1);
	});

	it('reads the length of the recording shown', async () => {
		jest.mocked(probeDurationSeconds).mockResolvedValue(95);

		const view = await panelOverRecording();

		expect(textOfRow(view, 'Duration')).toBe('1:35');
	});

	it('shows the length as unknown when the file could not be read', async () => {
		jest.mocked(probeDurationSeconds).mockResolvedValue(null);

		const view = await panelOverRecording();

		expect(textOfRow(view, 'Duration')).toBe('unknown');
	});

	it('is told of a recorder state change only once its view has loaded', async () => {
		const { app } = await loadPlugin(null, placedApp());
		const onStatus = at(jest.mocked(RecordingManager).mock.calls, 0)[2];
		// A panel restored with the layout stays a placeholder until its tab
		// is first shown, and there is no view to tell yet.
		const deferred = asMockWorkspace(app.workspace).getRightLeaf(false)!;
		deferred.view = { getViewType: () => RECORDING_PANEL_VIEW_TYPE };
		asMockWorkspace(app.workspace).getLeavesOfType.mockReturnValue([
			deferred,
		]);

		expect(() => onStatus(RecordingStatus.Recording)).not.toThrow();
	});
});

/**
 * The panel open over a recording the vault holds.
 * @returns The view, drawn
 */
async function panelOverRecording(): Promise<RecordingPanelView> {
	const { view, app } = await openPanel();
	const [file] = asMockVault(app.vault).seed([{ path: 'rec.webm' }]);
	asMockWorkspace(app.workspace).seedActiveFile(file ?? null);

	await view.refresh();
	await flushMicrotasks();
	return view;
}

/** The value a panel row shows. */
function textOfRow(view: RecordingPanelView, name: string): string {
	return rowDescription(settingRow(view.contentEl, name));
}
