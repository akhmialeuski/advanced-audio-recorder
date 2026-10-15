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
import { flushMicrotasks, waitFor } from '../helpers/async';
import {
	asMockApp,
	asMockPlugin,
	asMockVault,
	asMockWorkspace,
} from '../helpers/obsidianMock';
import { allEls, el, maybeEl } from '../helpers/dom';
import { RECORDING_PANEL } from '../helpers/selectors';
import {
	WorkspaceLeaf as MockWorkspaceLeaf,
	modalInstances,
} from '../mocks/obsidian';
import { loadPlugin } from '../helpers/pluginHarness';
import { RecordingPanelView } from 'src/panel/RecordingPanelView';
import { RecordingManager } from 'src/recording/RecordingManager';
import { RecordingStatus } from 'src/types';
import { at } from '../helpers/assertions';
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
		const { plugin } = await loadPlugin(null, placedApp());
		const factory = asMockPlugin(plugin).registeredViews.get(
			RECORDING_PANEL_VIEW_TYPE,
		);

		const view = factory?.(new MockWorkspaceLeaf());

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
	const leaf = new MockWorkspaceLeaf(asMockApp(app));
	const factory = asMockPlugin(plugin).registeredViews.get(
		RECORDING_PANEL_VIEW_TYPE,
	)!;
	const view = factory(leaf) as unknown as RecordingPanelView;
	leaf.view = view;
	await view.onOpen();
	return { view, app, plugin };
}

describe('settings changing under an open panel', () => {
	it('redraws the panel so the actions it offers follow', async () => {
		jest.mocked(probeDurationSeconds).mockResolvedValue(95);
		const { view, app, plugin } = await openPanel();
		const [file] = asMockVault(app.vault).seed([{ path: 'rec.webm' }]);
		asMockWorkspace(app.workspace).seedActiveFile(file ?? null);
		asMockWorkspace(app.workspace).getLeavesOfType.mockReturnValue([
			view.leaf,
		]);
		plugin.settings.transcriptionEnabled = false;
		await view.refresh();
		plugin.settings.transcriptionEnabled = true;

		await plugin.saveSettings();

		// The redraw reads the recording's sidecar through the store first.
		await waitFor(
			() =>
				maybeEl(
					view.contentEl,
					RECORDING_PANEL.action('Transcribe audio'),
				) !== null,
			{ message: 'the transcribe action to appear' },
		);

		expect(
			maybeEl(view.contentEl, RECORDING_PANEL.action('Transcribe audio')),
		).not.toBeNull();
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

		panelButton(view, 'Start recording').click();

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

		expect(panelButton(view, 'Stop recording').dataset.icon).toBe('square');
	});

	it('opens the plugin settings from its header', async () => {
		const { view, app } = await openPanel();
		const settingsDialog = { open: jest.fn(), openTabById: jest.fn() };
		app.setting = settingsDialog;

		panelButton(view, 'Open settings').click();

		expect(settingsDialog.openTabById).toHaveBeenCalledWith(
			'advanced-audio-recorder',
		);
	});

	it('shows the transcription queue from its header', async () => {
		const { view } = await openPanel();

		panelButton(view, 'Show the transcription queue').click();

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
		const deferred = new MockWorkspaceLeaf();
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

/** The value of the panel's property row with this key. */
function textOfRow(view: RecordingPanelView, key: string): string {
	const row = allEls(view.contentEl, RECORDING_PANEL.property).find(
		(candidate) =>
			el<HTMLInputElement>(candidate, RECORDING_PANEL.propertyKey)
				.value === key,
	);
	return row
		? (el(row, RECORDING_PANEL.propertyValue).textContent ?? '')
		: '';
}

/** One of the panel's own buttons, by its label. */
function panelButton(view: RecordingPanelView, label: string): HTMLElement {
	return el(view.contentEl, RECORDING_PANEL.button(label));
}
