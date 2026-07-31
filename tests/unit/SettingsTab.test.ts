/**
 * Unit tests for AudioRecorderSettingTab module.
 * Tests device-change listener lifecycle and test recording cleanup.
 * @module tests/unit/SettingsTab.test
 */

import { App, Platform } from 'obsidian';
import { at } from '../helpers/assertions';
import {
	renderDefinitionOf,
	renderThroughFramework,
	withoutFrameworkUpdate,
	type DeclarativeFrame,
	type RenderDefinition,
} from '../helpers/declarativeSettings';
import { AudioRecorderSettingTab } from 'src/settings/SettingsTab';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { DOCS_URL } from 'src/constants';
import type { AudioRecorderPluginInterface } from 'src/settings/SettingsTab';

// Mock AudioEncoder to avoid loading mediabunny in jsdom. The async
// probe defaults to "no offline encoder works"; individual tests
// override it to model richer profiles.
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'wav', 'webm', 'ogg', 'mp4', 'm4a'].includes(format),
	),
	probeOfflineEncodingSupport: jest.fn(() => Promise.resolve(false)),
}));

// Mock SystemDiagnostics: pulled in by the settings tab but exercised
// in its own suite
jest.mock('src/diagnostics/SystemDiagnostics', () => ({
	SystemDiagnostics: { collect: jest.fn() },
}));

/**
 * Plugin name as the manifest carries it. The tab names its declarative
 * definition from there rather than from a copy of its own.
 */
const PLUGIN_MANIFEST_NAME = 'Advanced Audio Recorder';

/** Lets pending promise callbacks (a save, then a re-render) run. */
const flushAsync = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Names of every setting row rendered under a host, in render order.
 * @param host - Element the settings body was rendered into
 */
const renderedNames = (host: HTMLElement): string[] =>
	Array.from(host.querySelectorAll('.setting-item-name'))
		.map((el) => el.textContent?.trim() ?? '')
		.filter((name) => name.length > 0);

/**
 * The rendered row carrying a setting name.
 * @param host - Element the settings body was rendered into
 * @param name - Name shown on the row
 */
const settingRowIn = (host: HTMLElement, name: string): HTMLElement => {
	const row = Array.from(host.querySelectorAll('.setting-item')).find(
		(el) => el.querySelector('.setting-item-name')?.textContent === name,
	);
	if (!row) {
		throw new Error(`Setting row not rendered: ${name}`);
	}
	return row as HTMLElement;
};

/**
 * The diagnostics row that owns the test capture, which is the definition
 * holding the cleanup the framework runs before it replaces that row.
 * @param tab - The tab to read the definition from
 */
const testRecordingDefinitionOf = (
	tab: AudioRecorderSettingTab,
): RenderDefinition => {
	const diagnostics = at(tab.getSettingDefinitions(), 1) as unknown as {
		items: RenderDefinition[];
	};
	return at(diagnostics.items, 0, 'diagnostics row');
};

/**
 * Flips the toggle on a rendered row, as a click on it does.
 * @param host - Element the settings body was rendered into
 * @param name - Name of the row whose toggle to flip
 */
const clickToggleIn = async (
	host: HTMLElement,
	name: string,
): Promise<void> => {
	settingRowIn(host, name)
		.querySelector<HTMLElement>('.checkbox-container')
		?.click();
	await flushAsync();
};

describe('AudioRecorderSettingTab', () => {
	let tab: AudioRecorderSettingTab;
	let mockSettings: AudioRecorderSettings;
	let addEventListenerMock: jest.Mock;
	let removeEventListenerMock: jest.Mock;
	let getUserMediaMock: jest.Mock;
	let saveSettingsMock: jest.Mock;
	let mockPlugin: AudioRecorderPluginInterface;

	beforeEach(() => {
		jest.clearAllMocks();

		addEventListenerMock = jest.fn();
		removeEventListenerMock = jest.fn();
		getUserMediaMock = jest.fn();
		Object.defineProperty(global, 'navigator', {
			value: {
				mediaDevices: {
					enumerateDevices: jest.fn().mockResolvedValue([]),
					getUserMedia: getUserMediaMock,
					addEventListener: addEventListenerMock,
					removeEventListener: removeEventListenerMock,
				},
			},
			writable: true,
		});

		(global as Record<string, unknown>).MediaRecorder = jest.fn();
		(
			(global as Record<string, unknown>).MediaRecorder as Record<
				string,
				unknown
			>
		).isTypeSupported = jest.fn().mockReturnValue(true);

		mockSettings = { ...DEFAULT_SETTINGS };
		saveSettingsMock = jest.fn().mockResolvedValue(undefined);
		mockPlugin = {
			settings: mockSettings,
			saveSettings: saveSettingsMock,
			manifest: {
				id: 'advanced-audio-recorder',
				name: PLUGIN_MANIFEST_NAME,
			},
		} as unknown as AudioRecorderPluginInterface;
		tab = new AudioRecorderSettingTab(new App(), mockPlugin);
	});

	describe('getSettingDefinitions (declarative settings, Obsidian 1.13+)', () => {
		/**
		 * Runs the tab's definition through the framework harness, either into
		 * a fresh row or into the row an earlier render already built, which is
		 * what update() does.
		 * @param existing - Frame from an earlier render
		 */
		const renderDeclaratively = (
			existing?: DeclarativeFrame,
		): DeclarativeFrame =>
			renderThroughFramework(
				renderDefinitionOf(tab.getSettingDefinitions()),
				existing,
			);

		it('declares the migrated sections, plus one row for the rest', () => {
			const defs = tab.getSettingDefinitions();

			// Sections migrate from the bottom of the tab upwards, so what is
			// still rendered by hand stays one contiguous block at the top and
			// the row order the user knows never changes.
			const remainder = renderDefinitionOf(defs);
			expect(remainder.name).toBe(PLUGIN_MANIFEST_NAME);
			expect(remainder.aliases).toEqual(
				expect.arrayContaining([
					'Recording format',
					'Enable multi-track recording',
					'Enable transcription',
				]),
			);
			expect(at(defs, 1)).toMatchObject({
				type: 'group',
				heading: 'Diagnostics',
			});
		});

		it('renders the settings body inside the row the framework keeps', () => {
			const frame = renderDeclaratively();

			// The body survives the framework's post-render pass because it
			// lives inside the tracked row: rendering it into the group's list
			// element (or the tab container) leaves the tab blank.
			expect(
				frame.containerEl.querySelector('.aar-doc-callout-link'),
			).not.toBeNull();
			expect(
				frame.setting.settingEl.querySelector('.aar-doc-callout-link'),
			).not.toBeNull();
			expect(
				frame.setting.settingEl.classList.contains('aar-settings-root'),
			).toBe(true);
			expect(addEventListenerMock).toHaveBeenCalledWith(
				'devicechange',
				expect.any(Function),
			);
		});

		it('clears the row the framework prefilled with the definition name', () => {
			const frame = renderDeclaratively();

			// The definition's name and description are search metadata, not a
			// row of the tab: the body starts at the documentation callout.
			expect(frame.setting.settingEl.contains(frame.setting.nameEl)).toBe(
				false,
			);
			expect(frame.setting.settingEl.contains(frame.setting.descEl)).toBe(
				false,
			);
			expect(
				frame.setting.settingEl.firstElementChild?.classList.contains(
					'aar-doc-callout',
				),
			).toBe(true);
		});

		it('replaces the body when update() re-renders the same row', () => {
			const frame = renderDeclaratively();

			renderDeclaratively(frame);

			// update() re-runs the render callback against the row it already
			// rendered into; a second copy of the body must not stack up.
			expect(
				frame.containerEl.querySelectorAll('.aar-doc-callout'),
			).toHaveLength(1);
		});

		it('carries every name still rendered by hand as a search alias', () => {
			// The settings inside the remainder are not definitions yet, so the
			// search cannot index them individually; their names travel as
			// aliases, and that hand-kept list drifts when a rename forgets it.
			const remainder = renderDefinitionOf(tab.getSettingDefinitions());
			const aliases = new Set(remainder.aliases);
			const frame = renderThroughFramework(remainder);

			const rendered = renderedNames(frame.setting.settingEl);

			expect(rendered.length).toBeGreaterThan(0);
			const missing = rendered.filter((name) => !aliases.has(name));
			expect(missing).toEqual([]);
		});

		it('reads a control value straight from the live settings', () => {
			mockSettings.debug = true;

			expect(tab.getControlValue('debug')).toBe(true);
		});

		it('persists a control value through the plugin, not through saveData', async () => {
			// The inherited implementation writes plugin.settings[key] and then
			// calls saveData(settings). That would flatten the trackAudioSources
			// Map to {}, skip the per-platform write-back, and leave the
			// recording manager and the player registrar on stale settings.
			await tab.setControlValue('debug', true);

			expect(mockSettings.debug).toBe(true);
			expect(saveSettingsMock).toHaveBeenCalledTimes(1);
		});

		it('drops the aliases of the sections that became definitions', () => {
			// A migrated setting is indexed by its own definition. Leaving it in
			// the alias list would list the tab twice for one query, and one of
			// the two would scroll to the wrong row.
			const remainder = renderDefinitionOf(tab.getSettingDefinitions());

			expect(remainder.aliases).not.toContain('Debug mode');
			expect(remainder.aliases).not.toContain('Diagnostics');
		});

		it('re-renders through the framework when a toggle adds settings', async () => {
			const frame = renderDeclaratively();
			// update() re-reads the definitions and re-invokes the render
			// callback against the row it already built.
			const updateSpy = jest
				.spyOn(tab, 'update')
				.mockImplementation(() => {
					renderDeclaratively(frame);
				});

			await clickToggleIn(
				frame.setting.settingEl,
				'Enable multi-track recording',
			);

			expect(updateSpy).toHaveBeenCalledTimes(1);
			const names = renderedNames(frame.containerEl);
			expect(names).toContain('Maximum tracks');
			// Rebuilt in place, not stacked behind the previous body.
			expect(
				names.filter((name) => name === 'Input device'),
			).toHaveLength(1);
			expect(
				frame.containerEl.querySelectorAll('.aar-doc-callout'),
			).toHaveLength(1);
		});
	});

	describe('Obsidian before 1.13 (imperative display path)', () => {
		let legacyTab: AudioRecorderSettingTab;

		beforeEach(() => {
			// The render mode is picked when the tab is constructed, so the
			// older Obsidian only has to be modelled for that one call.
			legacyTab = withoutFrameworkUpdate(
				() => new AudioRecorderSettingTab(new App(), mockPlugin),
			);
		});

		it('declares no settings, so Obsidian renders through display()', () => {
			// An empty list is the signal: 1.13's renderTab() falls back to
			// display() only while there is nothing to render declaratively.
			expect(legacyTab.getSettingDefinitions()).toEqual([]);
		});

		it('renders the whole body into the tab container', () => {
			legacyTab.display();

			const names = renderedNames(legacyTab.containerEl);
			expect(names).toContain('Input device');
			expect(names).toContain('Recording format');
			expect(names).toContain('Debug mode');
			expect(
				legacyTab.containerEl.querySelector('.aar-doc-callout-link'),
			).not.toBeNull();
		});

		it('renders the migrated sections from the same definitions', () => {
			legacyTab.display();

			// One tree, two renderers: a section migrated for 1.13 reaches this
			// Obsidian too, instead of being kept as a second implementation.
			const names = renderedNames(legacyTab.containerEl);
			expect(names).toContain('Diagnostics');
			expect(names).toContain('Test recording');
			expect(names).toContain('System info');
			expect(names).toContain('Debug mode');
		});

		it('hosts the sections still rendered by hand in a row of their own', () => {
			legacyTab.display();

			const host =
				legacyTab.containerEl.querySelector('.aar-settings-root');
			expect(host?.querySelector('.aar-doc-callout-link')).not.toBeNull();
		});

		it('rebuilds the container itself when a toggle adds settings', async () => {
			legacyTab.display();

			await clickToggleIn(
				legacyTab.containerEl,
				'Enable multi-track recording',
			);

			// No framework update() to ask on this version: the tab clears its
			// container and renders again, revealing the new rows exactly once.
			const names = renderedNames(legacyTab.containerEl);
			expect(names).toContain('Maximum tracks');
			expect(
				names.filter((name) => name === 'Input device'),
			).toHaveLength(1);
			expect(
				legacyTab.containerEl.querySelectorAll('.aar-doc-callout'),
			).toHaveLength(1);
		});

		it('renders again after hide(), the way reopening the tab does', () => {
			legacyTab.display();
			legacyTab.hide();
			legacyTab.display();

			expect(
				legacyTab.containerEl.querySelectorAll('.aar-doc-callout'),
			).toHaveLength(1);
			expect(renderedNames(legacyTab.containerEl)).toContain(
				'Input device',
			);
		});

		it('keeps the device-change listener lifecycle of the newer path', () => {
			legacyTab.display();
			const handler = addEventListenerMock.mock.calls[0][1] as () => void;

			legacyTab.hide();

			expect(addEventListenerMock).toHaveBeenCalledTimes(1);
			expect(removeEventListenerMock).toHaveBeenCalledWith(
				'devicechange',
				handler,
			);
		});
	});

	describe('documentation link', () => {
		it('should render a documentation callout linking to the docs', () => {
			tab.display();

			const link = tab.containerEl.querySelector<HTMLAnchorElement>(
				'.aar-doc-callout-link',
			);
			expect(link).not.toBeNull();
			expect(link?.getAttribute('href')).toBe(DOCS_URL);
		});

		it('should open the documentation link in a new tab safely', () => {
			tab.display();

			const link = tab.containerEl.querySelector<HTMLAnchorElement>(
				'.aar-doc-callout-link',
			);
			// New tab plus rel=noopener so the docs page cannot reach back
			// into the Obsidian window via window.opener.
			expect(link?.getAttribute('target')).toBe('_blank');
			expect(link?.getAttribute('rel')).toBe('noopener');
		});

		it('should render the callout only once per display() call', () => {
			tab.display();
			tab.display();

			const callouts =
				tab.containerEl.querySelectorAll('.aar-doc-callout');
			// display() empties the container first, so a re-render must not
			// stack duplicate callouts.
			expect(callouts.length).toBe(1);
		});
	});

	describe('device-change listener lifecycle', () => {
		it('should register the listener via addEventListener, not assignment', () => {
			tab.display();

			expect(addEventListenerMock).toHaveBeenCalledTimes(1);
			expect(addEventListenerMock).toHaveBeenCalledWith(
				'devicechange',
				expect.any(Function),
			);
			// Other plugins' ondevicechange assignment must stay untouched
			expect(
				(navigator.mediaDevices as { ondevicechange?: unknown })
					.ondevicechange,
			).toBeUndefined();
		});

		it('should register only once across repeated display() calls', () => {
			tab.display();
			tab.display();
			tab.display();

			expect(addEventListenerMock).toHaveBeenCalledTimes(1);
		});

		it('should remove the listener in hide()', () => {
			tab.display();
			const handler = addEventListenerMock.mock.calls[0][1] as () => void;

			tab.hide();

			expect(removeEventListenerMock).toHaveBeenCalledWith(
				'devicechange',
				handler,
			);
		});

		it('should re-register after hide() and display() again', () => {
			tab.display();
			tab.hide();
			tab.display();

			expect(addEventListenerMock).toHaveBeenCalledTimes(2);
			expect(removeEventListenerMock).toHaveBeenCalledTimes(1);
		});

		it('should not remove anything when hidden without display()', () => {
			tab.hide();

			expect(removeEventListenerMock).not.toHaveBeenCalled();
		});
	});

	describe('test recording resource safety', () => {
		interface RecorderMock {
			state: string;
			start: jest.Mock;
			stop: jest.Mock;
			ondataavailable: ((event: { data: Blob }) => void) | null;
			addEventListener: jest.Mock;
		}

		const createRecorderMock = (): RecorderMock => {
			const stopListeners: Array<() => void> = [];
			const recorder: RecorderMock = {
				state: 'recording',
				start: jest.fn(),
				stop: jest.fn(() => {
					recorder.state = 'inactive';
					stopListeners.forEach((listener) => listener());
				}),
				ondataavailable: null,
				addEventListener: jest.fn(
					(event: string, handler: () => void) => {
						if (event === 'stop') {
							stopListeners.push(handler);
						}
					},
				),
			};
			return recorder;
		};

		/**
		 * Runs a tab's test recording into a container, the way its "Start
		 * test" button does.
		 * @param target - The tab whose recorder runs
		 * @param container - Element the status and playback land in
		 */
		const runTestOn = (
			target: AudioRecorderSettingTab,
			container: HTMLElement,
		): Promise<void> =>
			(
				target as unknown as {
					runTestRecording(c: HTMLElement): Promise<void>;
				}
			).runTestRecording(container);

		const runTest = (container: HTMLElement): Promise<void> =>
			runTestOn(tab, container);

		/**
		 * Installs a MediaRecorder the test drives by hand.
		 * @param recorder - The recorder every construction returns
		 */
		const installRecorder = (recorder: RecorderMock): void => {
			const constructor = jest.fn(
				() => recorder,
			) as unknown as jest.Mock & { isTypeSupported: jest.Mock };
			constructor.isTypeSupported = jest.fn().mockReturnValue(true);
			(global as Record<string, unknown>).MediaRecorder = constructor;
		};

		/**
		 * Drives one capture to a finished playback element.
		 * @param target - The tab whose recorder runs
		 * @param container - Element the playback element lands in
		 */
		const recordUntilPlayback = async (
			target: AudioRecorderSettingTab,
			container: HTMLElement,
		): Promise<void> => {
			const recorder = createRecorderMock();
			installRecorder(recorder);
			jest.useFakeTimers();
			const testPromise = runTestOn(target, container);
			await jest.advanceTimersByTimeAsync(0);
			recorder.ondataavailable?.({ data: new Blob(['audio-data']) });
			await jest.advanceTimersByTimeAsync(5000);
			await testPromise;
			jest.useRealTimers();
		};

		let trackStop: jest.Mock;

		beforeEach(() => {
			trackStop = jest.fn();
			getUserMediaMock.mockResolvedValue({
				getTracks: () => [{ stop: trackStop }],
			});
			global.URL.createObjectURL = jest
				.fn()
				.mockReturnValue('blob:test-url');
			global.URL.revokeObjectURL = jest.fn();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should stop the stream when MediaRecorder creation fails', async () => {
			(global as Record<string, unknown>).MediaRecorder = jest.fn(() => {
				throw new Error('mimeType not supported');
			});
			(
				(global as Record<string, unknown>).MediaRecorder as Record<
					string,
					unknown
				>
			).isTypeSupported = jest.fn().mockReturnValue(true);

			await runTest(tab.containerEl);

			expect(trackStop).toHaveBeenCalled();
			const status = tab.containerEl.querySelector('.aar-test-status');
			expect(status?.textContent).toContain('Test recording failed');
		});

		it('should stop the stream and bail out when hidden mid-recording', async () => {
			const recorder = createRecorderMock();
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => recorder,
			);
			(
				(global as Record<string, unknown>).MediaRecorder as Record<
					string,
					unknown
				>
			).isTypeSupported = jest.fn().mockReturnValue(true);

			jest.useFakeTimers();
			const testPromise = runTest(tab.containerEl);
			// Let getUserMedia resolve and the recorder start
			await jest.advanceTimersByTimeAsync(0);
			expect(recorder.start).toHaveBeenCalled();

			// User leaves the settings tab during the 5 s wait
			tab.hide();
			expect(recorder.stop).toHaveBeenCalled();

			await jest.advanceTimersByTimeAsync(5000);
			await testPromise;

			expect(trackStop).toHaveBeenCalled();
			expect(URL.createObjectURL).not.toHaveBeenCalled();
			expect(tab.containerEl.querySelector('.aar-test-audio')).toBeNull();
		});

		it('should stop the stream and attach playback on success', async () => {
			const recorder = createRecorderMock();
			(global as Record<string, unknown>).MediaRecorder = jest.fn(
				() => recorder,
			);
			(
				(global as Record<string, unknown>).MediaRecorder as Record<
					string,
					unknown
				>
			).isTypeSupported = jest.fn().mockReturnValue(true);

			jest.useFakeTimers();
			const testPromise = runTest(tab.containerEl);
			await jest.advanceTimersByTimeAsync(0);

			recorder.ondataavailable?.({ data: new Blob(['audio-data']) });

			await jest.advanceTimersByTimeAsync(5000);
			await testPromise;

			expect(recorder.stop).toHaveBeenCalled();
			expect(trackStop).toHaveBeenCalled();
			expect(URL.createObjectURL).toHaveBeenCalled();
			const audio = tab.containerEl.querySelector('.aar-test-audio');
			expect(audio).not.toBeNull();
			expect(audio?.getAttribute('src')).toBe('blob:test-url');
		});

		it('releases the finished playback when update() re-renders the row', async () => {
			const definition = testRecordingDefinitionOf(tab);
			const frame = renderThroughFramework(definition);
			await recordUntilPlayback(tab, frame.setting.settingEl);
			expect(
				frame.setting.settingEl.querySelector('.aar-test-audio'),
			).not.toBeNull();

			renderThroughFramework(definition, frame);

			// The framework runs the render definition's cleanup before it
			// renders the row again, so the playback element leaves with the
			// body it belonged to instead of outliving it detached, holding a
			// blob URL until the tab is closed.
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
			expect(
				frame.containerEl.querySelector('.aar-test-audio'),
			).toBeNull();
		});

		it('releases the finished playback when the imperative path rebuilds', async () => {
			const legacyTab = withoutFrameworkUpdate(
				() => new AudioRecorderSettingTab(new App(), mockPlugin),
			);
			legacyTab.display();
			await recordUntilPlayback(legacyTab, legacyTab.containerEl);

			await clickToggleIn(
				legacyTab.containerEl,
				'Enable multi-track recording',
			);

			// No framework cleanup to lean on here: the mode releases the body
			// itself before rebuilding the container, so the same blob URL is
			// revoked on this Obsidian too.
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
			expect(
				legacyTab.containerEl.querySelector('.aar-test-audio'),
			).toBeNull();
		});
	});

	describe('channel selectors and device capabilities', () => {
		function fakeInputDevice(
			deviceId: string,
			maxChannels?: number,
		): MediaDeviceInfo {
			return {
				deviceId,
				kind: 'audioinput',
				label: deviceId,
				groupId: '',
				getCapabilities:
					maxChannels === undefined
						? undefined
						: (): { channelCount: { max: number } } => ({
								channelCount: { max: maxChannels },
							}),
			} as unknown as MediaDeviceInfo;
		}

		function installDevices(devices: MediaDeviceInfo[]): void {
			(
				navigator.mediaDevices.enumerateDevices as jest.Mock
			).mockResolvedValue(devices);
		}

		/** display() plus the async capability load and device fills. */
		async function renderAndSettle(): Promise<void> {
			tab.display();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		/**
		 * The channel selectors are the only dropdowns offering the
		 * mono-mix option: the global one first, then one per track.
		 */
		function channelSelects(): HTMLSelectElement[] {
			return Array.from(
				tab.containerEl.querySelectorAll<HTMLSelectElement>('select'),
			).filter((select) =>
				Array.from(select.options).some(
					(option) => option.value === 'mono-mix',
				),
			);
		}

		it('keeps the global selector enabled for a stereo device', async () => {
			installDevices([fakeInputDevice('stereo-dev', 2)]);
			mockSettings.audioDeviceId = 'stereo-dev';
			mockSettings.recordingChannels = 'mono-left';

			await renderAndSettle();

			expect(at(channelSelects(), 0).disabled).toBe(false);
			expect(mockSettings.recordingChannels).toBe('mono-left');
		});

		it('uses one enumeration for all device dropdowns and capabilities', async () => {
			installDevices([fakeInputDevice('stereo-dev', 2)]);
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 3;

			await renderAndSettle();

			expect(
				navigator.mediaDevices.enumerateDevices,
			).toHaveBeenCalledTimes(1);
		});

		it('disables the global selector without rewriting the mode for a known-mono device', async () => {
			installDevices([fakeInputDevice('mono-dev', 1)]);
			mockSettings.audioDeviceId = 'mono-dev';
			mockSettings.recordingChannels = 'mono-left';

			await renderAndSettle();

			expect(at(channelSelects(), 0).disabled).toBe(true);
			expect(mockSettings.recordingChannels).toBe('mono-left');
			expect(saveSettingsMock).not.toHaveBeenCalled();
		});

		it('keeps the global selector enabled when capability is unknown', async () => {
			installDevices([fakeInputDevice('opaque-dev')]);
			mockSettings.audioDeviceId = 'opaque-dev';

			await renderAndSettle();

			expect(at(channelSelects(), 0).disabled).toBe(false);
		});

		it('disables per-track selectors by each track device capability', async () => {
			installDevices([
				fakeInputDevice('stereo-dev', 2),
				fakeInputDevice('mono-dev', 1),
			]);
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 3;
			mockSettings.trackAudioSources = new Map([
				[1, { deviceId: 'stereo-dev', channelMode: 'mono-left' }],
				[2, { deviceId: 'mono-dev', channelMode: 'mono-right' }],
			]);

			await renderAndSettle();

			const selects = channelSelects();
			// Global + three track selectors
			expect(selects).toHaveLength(4);
			expect(at(selects, 1).disabled).toBe(false);
			expect(at(selects, 2).disabled).toBe(true);
			// Track 3 has no device: nothing to bind the mode to
			expect(at(selects, 3).disabled).toBe(true);
			// Runtime capability observation never rewrites either mode.
			expect(mockSettings.trackAudioSources.get(1)?.channelMode).toBe(
				'mono-left',
			);
			expect(mockSettings.trackAudioSources.get(2)?.channelMode).toBe(
				'mono-right',
			);
		});

		it('treats an unplugged selected device as absent without losing its mode', async () => {
			installDevices([fakeInputDevice('selected-dev', 2)]);
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 1;
			mockSettings.trackAudioSources = new Map([
				[1, { deviceId: 'selected-dev', channelMode: 'mono-left' }],
			]);
			await renderAndSettle();
			expect(at(channelSelects(), 1).disabled).toBe(false);

			installDevices([]);
			const deviceChange = addEventListenerMock.mock
				.calls[0][1] as () => void;
			deviceChange();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(at(channelSelects(), 1).disabled).toBe(true);
			expect(mockSettings.trackAudioSources.get(1)).toEqual({
				deviceId: 'selected-dev',
				channelMode: 'mono-left',
			});
			expect(saveSettingsMock).not.toHaveBeenCalled();
		});

		it('ignores a stale capability refresh that resolves last', async () => {
			let resolveOlder:
				| ((devices: MediaDeviceInfo[]) => void)
				| undefined;
			let resolveNewer:
				| ((devices: MediaDeviceInfo[]) => void)
				| undefined;
			const older = new Promise<MediaDeviceInfo[]>((resolve) => {
				resolveOlder = resolve;
			});
			const newer = new Promise<MediaDeviceInfo[]>((resolve) => {
				resolveNewer = resolve;
			});
			(navigator.mediaDevices.enumerateDevices as jest.Mock)
				.mockImplementationOnce(() => older)
				.mockImplementationOnce(() => newer);
			mockSettings.audioDeviceId = 'selected-dev';
			mockSettings.recordingChannels = 'mono-left';

			tab.display();
			const deviceChange = addEventListenerMock.mock
				.calls[0][1] as () => void;
			deviceChange();
			resolveNewer?.([fakeInputDevice('selected-dev', 2)]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(at(channelSelects(), 0).disabled).toBe(false);

			resolveOlder?.([fakeInputDevice('selected-dev', 1)]);
			await new Promise((resolve) => setTimeout(resolve, 0));

			// The older mono result must not overwrite the newer stereo view.
			expect(at(channelSelects(), 0).disabled).toBe(false);
			expect(mockSettings.recordingChannels).toBe('mono-left');
			expect(saveSettingsMock).not.toHaveBeenCalled();
		});

		it('persists a per-track channel mode change', async () => {
			installDevices([fakeInputDevice('stereo-dev', 2)]);
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 1;
			mockSettings.trackAudioSources = new Map([
				[1, { deviceId: 'stereo-dev', channelMode: 'source' }],
			]);

			await renderAndSettle();

			const trackChannelSelect = at(channelSelects(), 1);
			expect(trackChannelSelect.disabled).toBe(false);
			trackChannelSelect.value = 'mono-right';
			trackChannelSelect.dispatchEvent(new Event('change'));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSettings.trackAudioSources.get(1)).toEqual({
				deviceId: 'stereo-dev',
				channelMode: 'mono-right',
			});
		});

		it('preserves the track channel mode across a device swap', async () => {
			installDevices([
				fakeInputDevice('stereo-dev', 2),
				fakeInputDevice('other-stereo', 2),
			]);
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 1;
			mockSettings.trackAudioSources = new Map([
				[1, { deviceId: 'stereo-dev', channelMode: 'mono-left' }],
			]);

			await renderAndSettle();

			// The device dropdowns are every select that is not a channel
			// selector; the track device dropdown is the last one
			const channels = new Set(channelSelects());
			const deviceSelects = Array.from(
				tab.containerEl.querySelectorAll<HTMLSelectElement>('select'),
			).filter(
				(select) =>
					!channels.has(select) &&
					Array.from(select.options).some(
						(option) => option.value === 'other-stereo',
					),
			);
			const trackDeviceSelect = at(
				deviceSelects,
				deviceSelects.length - 1,
			);
			trackDeviceSelect.value = 'other-stereo';
			trackDeviceSelect.dispatchEvent(new Event('change'));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSettings.trackAudioSources.get(1)).toEqual({
				deviceId: 'other-stereo',
				channelMode: 'mono-left',
			});
		});
	});

	describe('section-scoped re-rendering', () => {
		/** display() plus the async capability load and device fills. */
		async function renderAndSettle(): Promise<void> {
			tab.display();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		/** Toggles the named setting the way a click would. */
		function toggleSetting(name: string): void {
			const row = Array.from(
				tab.containerEl.querySelectorAll<HTMLElement>('.setting-item'),
			).find(
				(el) =>
					el.querySelector('.setting-item-name')?.textContent ===
					name,
			);
			if (!row) {
				throw new Error(`setting row "${name}" not rendered`);
			}
			const toggle = row.querySelector<HTMLElement>(
				'.checkbox-container',
			);
			if (!toggle) {
				throw new Error(`toggle in "${name}" not rendered`);
			}
			toggle.click();
		}

		it('redraws only its own section when a reveal toggle flips', async () => {
			await renderAndSettle();
			const enumerateCalls = (
				navigator.mediaDevices.enumerateDevices as jest.Mock
			).mock.calls.length;

			// "Save near active file" reveals one row inside the storage
			// section. Sending it through the tab-wide rerender would rebuild
			// every row and restart the device enumeration behind the input
			// dropdowns, which no storage setting can affect.
			toggleSetting('Save recordings near active file');
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSettings.saveNearActiveFile).toBe(true);
			expect(
				(navigator.mediaDevices.enumerateDevices as jest.Mock).mock
					.calls.length,
			).toBe(enumerateCalls);
		});

		it('reveals the newly applicable row in the redrawn section', async () => {
			await renderAndSettle();

			toggleSetting('Save recordings near active file');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const names = Array.from(
				tab.containerEl.querySelectorAll<HTMLElement>(
					'.setting-item-name',
				),
			).map((el) => el.textContent);
			expect(names).toContain('Active file subfolder');
			// The section is redrawn, not appended to.
			expect(
				names.filter((n) => n === 'Save recordings near active file'),
			).toHaveLength(1);
		});

		it('keeps the sections it did not redraw on screen', async () => {
			await renderAndSettle();

			toggleSetting('Save recordings near active file');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const names = Array.from(
				tab.containerEl.querySelectorAll<HTMLElement>(
					'.setting-item-name',
				),
			).map((el) => el.textContent);
			expect(names).toContain('File prefix');
			expect(names).toContain('Enhanced audio player');
			expect(names).toContain('Debug mode');
		});
	});

	describe('platform gating of the settings UI', () => {
		afterEach(() => {
			Platform.isMobile = false;
			Platform.isMobileApp = false;
		});

		/** Finds a rendered setting row by its displayed name. */
		function settingRow(name: string): HTMLElement {
			const rows = Array.from(
				tab.containerEl.querySelectorAll<HTMLElement>('.setting-item'),
			);
			const row = rows.find(
				(el) =>
					el.querySelector('.setting-item-name')?.textContent ===
					name,
			);
			if (!row) {
				throw new Error(`Setting row not rendered: ${name}`);
			}
			return row;
		}

		/** Whether a row is rendered dimmed (blocked on this platform). */
		function rowDimmed(name: string): boolean {
			return settingRow(name).classList.contains('aar-setting-disabled');
		}

		/** The row's select element, when its control is a dropdown. */
		function rowSelect(name: string): HTMLSelectElement {
			const select = settingRow(name).querySelector('select');
			if (!select) {
				throw new Error(`No dropdown in setting row: ${name}`);
			}
			return select;
		}

		it('keeps the hardware rows interactive on desktop', () => {
			tab.display();

			expect(rowDimmed('Input device')).toBe(false);
			expect(rowDimmed('Sample rate')).toBe(false);
			expect(rowDimmed('Split recordings automatically')).toBe(false);
			expect(rowDimmed('Enable multi-track recording')).toBe(false);
			expect(rowSelect('Input device').disabled).toBe(false);
			expect(rowSelect('Sample rate').disabled).toBe(false);
		});

		it('blocks device, sample-rate, and channel selection on mobile', () => {
			Platform.isMobile = true;
			tab.display();

			expect(rowDimmed('Input device')).toBe(true);
			expect(rowSelect('Input device').disabled).toBe(true);
			expect(rowDimmed('Sample rate')).toBe(true);
			expect(rowSelect('Sample rate').disabled).toBe(true);
			expect(rowSelect('Recording channels').disabled).toBe(true);
		});

		it('blocks auto-split on mobile and shows the effective off state', async () => {
			Platform.isMobile = true;
			mockSettings.autoSplitEnabled = true;
			tab.display();

			expect(rowDimmed('Split recordings automatically')).toBe(true);
			// The disabled toggle cannot be flipped: a click must not save
			const toggleEl = settingRow(
				'Split recordings automatically',
			).querySelector<HTMLElement>('.checkbox-container');
			toggleEl?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(saveSettingsMock).not.toHaveBeenCalled();
			expect(mockSettings.autoSplitEnabled).toBe(true);
		});

		it('blocks multi-track on mobile and hides the per-track rows', () => {
			Platform.isMobile = true;
			mockSettings.enableMultiTrack = true;
			tab.display();

			expect(rowDimmed('Enable multi-track recording')).toBe(true);
			// Even a stored "on" renders no per-track configuration
			const rows = Array.from(
				tab.containerEl.querySelectorAll('.setting-item-name'),
			).map((el) => el.textContent);
			expect(rows).not.toContain('Audio source for track 1');
			expect(rows).not.toContain('Maximum tracks');
		});

		it('renders the per-track rows on desktop when multi-track is on', () => {
			mockSettings.enableMultiTrack = true;
			mockSettings.maxTracks = 2;
			tab.display();

			const rows = Array.from(
				tab.containerEl.querySelectorAll('.setting-item-name'),
			).map((el) => el.textContent);
			expect(rows).toContain('Audio source for track 1');
			expect(rows).toContain('Audio source for track 2');
		});

		it('blocks recording formats the device cannot produce (iOS profile)', async () => {
			// iOS WKWebView: MediaRecorder records audio/mp4 only; with no
			// working offline encoders, everything unrecordable is blocked.
			Platform.isMobile = true;
			(
				(global as Record<string, unknown>).MediaRecorder as {
					isTypeSupported: jest.Mock;
				}
			).isTypeSupported.mockImplementation(
				(type: string) => type === 'audio/mp4',
			);
			tab.display();
			// The availability probe is async: let it annotate the options
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const options = new Map(
				Array.from(rowSelect('Recording format').options).map(
					(option) => [option.value, option.disabled],
				),
			);
			expect(options.get('mp4')).toBe(false);
			// m4a IS an mp4 container: recordable via the canonical
			// audio/mp4 MIME and saved with the .m4a extension
			expect(options.get('m4a')).toBe(false);
			// WAV still works: recorded via the mp4 intermediate, encoded
			// by the plugin's own WAV writer
			expect(options.get('wav')).toBe(false);
			for (const format of ['webm', 'ogg', 'mp3', 'flac', 'aac']) {
				expect(options.get(format)).toBe(true);
			}
		});

		it('names the fallback format when the stored format is blocked (iOS profile)', async () => {
			// The plugin default (webm) synced onto an iOS-like device:
			// the note must say what recordings actually produce
			Platform.isMobile = true;
			mockSettings.recordingFormat = 'webm';
			(
				(global as Record<string, unknown>).MediaRecorder as {
					isTypeSupported: jest.Mock;
				}
			).isTypeSupported.mockImplementation(
				(type: string) => type === 'audio/mp4',
			);
			tab.display();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const note = settingRow('Recording format').querySelector(
				'.aar-format-fallback-note',
			);
			expect(note).not.toBeNull();
			expect(note?.textContent).toContain('cannot record WEBM');
			expect(note?.textContent).toContain('MP4');
		});

		it('keeps every recordable format selectable on a permissive desktop profile', async () => {
			tab.display();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			const options = Array.from(rowSelect('Recording format').options);
			expect(options.length).toBeGreaterThan(0);
			for (const option of options) {
				expect(option.disabled).toBe(false);
			}
			expect(
				settingRow('Recording format').querySelector(
					'.aar-format-fallback-note',
				),
			).toBeNull();
		});
	});
});
