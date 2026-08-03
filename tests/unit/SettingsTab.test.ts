/**
 * Unit tests for AudioRecorderSettingTab module.
 * Tests device-change listener lifecycle and test recording cleanup.
 * @module tests/unit/SettingsTab.test
 */

import { App, Platform } from 'obsidian';
import {
	groupOf,
	listIn,
	pageOf,
	renderDefinitionOf,
	renderThroughFramework,
	rowIn,
	rowOf,
	withoutFrameworkUpdate,
	type DeclarativeFrame,
	type GroupDefinition,
	type RenderDefinition,
	type RowDefinition,
} from '../helpers/declarativeSettings';
import { AudioRecorderSettingTab } from 'src/settings/SettingsTab';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { DOCS_URL, MAX_LLM_MAX_TOKENS } from 'src/constants';
import { PROFILE_KINDS } from 'src/settings/profileKinds';
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
 * Confirm callbacks of the model dialogs the tab opened, newest last. The
 * dialog has its own suite; here a test only needs to answer it, which is what
 * a user typing an id and pressing Add does.
 */
const mockModelDialogs: Array<(id: string) => void> = [];
jest.mock('src/ui/ModelIdModal', () => ({
	ModelIdModal: jest
		.fn()
		.mockImplementation((_app: unknown, onAdd: (id: string) => void) => {
			mockModelDialogs.push(onAdd);
			return { open: (): void => undefined };
		}),
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
 * The diagnostics row that owns the test capture, which is the definition
 * holding the cleanup the framework runs before it replaces that row.
 * @param tab - The tab to read the definition from
 */
const testRecordingDefinitionOf = (
	tab: AudioRecorderSettingTab,
): RenderDefinition => {
	return rowOf(
		tab.getSettingDefinitions(),
		'Diagnostics',
		'Test recording',
	) as RenderDefinition;
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

		it('declares every section of the tab', () => {
			const defs = tab.getSettingDefinitions();

			// Nothing is rendered by hand any more except the rows no control
			// type covers, so the settings search indexes each setting by its
			// own name rather than through a hand-kept alias list.
			for (const heading of [
				'Audio input',
				'Output format',
				'File storage',
				'Audio splitting',
				'Multi-track recording',
				'Audio player',
				'Transcription',
				'Audio processing & feedback',
				'Audio cleanup defaults',
				'Diagnostics',
			]) {
				expect(groupOf(defs, heading).items).not.toHaveLength(0);
			}
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

		it('reads a control value straight from the live settings', () => {
			mockSettings.debug = true;

			expect(tab.getControlValue('debug')).toBe(true);
		});

		it.each([
			['bitrate', '192000', 192000],
			['sampleRate', '44100', 44100],
		])(
			'keeps %s a number across a dropdown round trip',
			async (key, produced, stored) => {
				// A dropdown speaks the option value, which is a string, while
				// these two settings are numbers: storing the string put
				// "192000" where every consumer expects 192000, and reading the
				// number back matched no option, so the dropdown opened blank.
				await tab.setControlValue(key, produced);

				expect(mockSettings[key as 'bitrate' | 'sampleRate']).toBe(
					stored,
				);
				expect(tab.getControlValue(key)).toBe(produced);
			},
		);

		it.each([
			['llmOpenAiMaxTokens'],
			['llmAnthropicMaxTokens'],
			['geminiMaxTokens'],
		])(
			'stores the ceiling %s declares, which is what the row offers',
			async (key) => {
				// The reported defect: the row showed the ceiling and would not
				// keep it. The value space a number control declares has to
				// contain its own bounds, or the setting cannot be set to them.
				await tab.setControlValue(key, MAX_LLM_MAX_TOKENS);

				expect(mockSettings[key as keyof AudioRecorderSettings]).toBe(
					MAX_LLM_MAX_TOKENS,
				);
				expect(saveSettingsMock).toHaveBeenCalledTimes(1);
			},
		);

		it('writes an engine-owned field through the engine that owns it', async () => {
			// A catalogue and the id picked out of it are one thing, so a write
			// to either comes out consistent: replacing the list around a live
			// selection leaves that selection something the list offers.
			mockSettings.whisperApiModel = 'whisper-large-v3';

			await tab.setControlValue('whisperApiModels', ['whisper-1']);

			expect(mockSettings.whisperApiModels).toEqual([
				'whisper-large-v3',
				'whisper-1',
			]);
			expect(mockSettings.whisperApiModel).toBe('whisper-large-v3');
		});

		it('keeps the stored number when a numeric control produces nothing', async () => {
			await tab.setControlValue('bitrate', '');

			expect(mockSettings.bitrate).toBe(DEFAULT_SETTINGS.bitrate);
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

		it('asks the framework to re-render when the device list changes', async () => {
			// The device-bound rows are built from the last enumeration, so a
			// changed device list is a changed tree. This is the documented way
			// to react to state the settings tab does not own.
			(
				navigator.mediaDevices.enumerateDevices as jest.Mock
			).mockResolvedValue([
				{
					deviceId: 'mic-1',
					kind: 'audioinput',
					label: 'Built-in microphone',
					groupId: '',
				},
			]);
			const updateSpy = jest
				.spyOn(tab, 'update')
				.mockImplementation(() => undefined);

			renderDeclaratively();
			await flushAsync();

			expect(updateSpy).toHaveBeenCalledTimes(1);

			// A render enumerates again; an unchanged list must settle instead
			// of asking for yet another render.
			updateSpy.mockClear();
			renderDeclaratively();
			await flushAsync();

			expect(updateSpy).not.toHaveBeenCalled();
		});
	});

	describe('writes that mean more than storing a value', () => {
		/** Whether the tab asked the framework to read the tree again. */
		let updateSpy: jest.SpyInstance;

		beforeEach(() => {
			updateSpy = jest
				.spyOn(tab, 'update')
				.mockImplementation(() => undefined);
			tab.getSettingDefinitions();
		});

		afterEach(() => {
			updateSpy.mockRestore();
		});

		it('reads the tree again when another profile becomes the default', async () => {
			mockSettings.transcriptionDictionaryProfiles = [
				{ id: 'a', name: 'SWIFT', terms: 'vdura-api' },
				{ id: 'b', name: 'Robot', terms: 'ros2, rclcpp' },
			];
			mockSettings.transcriptionDictionaryProfileId = 'a';

			await tab.setControlValue(
				'transcriptionDictionaryProfileId#b',
				true,
			);

			// Every entry of the catalogue says whether it is the one in use,
			// which no visible predicate can express: without reading the tree
			// again both entries keep the answer they were built with.
			expect(mockSettings.transcriptionDictionaryProfileId).toBe('b');
			expect(updateSpy).toHaveBeenCalled();
		});

		it('runs the chapter catalogue through the same mechanism', async () => {
			mockSettings.transcriptionChapterPromptProfiles = [
				{ id: 'a', name: 'Standup', prompt: 'by speaker' },
				{ id: 'b', name: 'Lecture', prompt: 'by topic' },
			];
			mockSettings.transcriptionChapterPromptProfileId = 'a';

			await tab.setControlValue(
				'transcriptionChapterPromptProfileId#b',
				true,
			);
			await tab.setControlValue('chapterProfile.prompt#b', 'by chapter');

			// One catalogue, two kinds: the keys differ, the behaviour does not.
			expect(mockSettings.transcriptionChapterPromptProfileId).toBe('b');
			expect(
				mockSettings.transcriptionChapterPromptProfiles[1]?.prompt,
			).toBe('by chapter');
			expect(updateSpy).toHaveBeenCalled();
		});

		it.each(PROFILE_KINDS.map((kind) => [kind.heading, kind.selectionKey]))(
			'reads the tree again when %s picks another profile from the dropdown',
			async (_heading, selectionKey) => {
				// The dropdown moves the same selection the per-profile switch
				// does, so it owes the catalogue entry the same refresh. Read
				// from the kinds themselves: a kind that forgot to register the
				// effect showed a stale name on its entry, which is how the
				// participant catalogue came to behave differently from the
				// other two.
				await tab.setControlValue(selectionKey, 'a');

				expect(updateSpy).toHaveBeenCalled();
			},
		);

		it.each(['llmProvider', 'chaptersLlmProvider', 'advancedLlmProvider'])(
			'stores %s without touching an endpoint or rebuilding the tree',
			async (key) => {
				mockSettings.whisperApiBaseUrl = 'https://groq.internal/v1';
				mockSettings.anthropicBaseUrl = 'https://claude.internal/v1';

				await tab.setControlValue(key, 'anthropic');

				// The endpoint belongs to the provider, not to the use, so the
				// switch reads another provider's field instead of rewriting
				// one. Every service is configured on its own page too, so no
				// row below this one holds the chosen vendor's fields and there
				// is nothing for a rebuild to change.
				expect(mockSettings.whisperApiBaseUrl).toBe(
					'https://groq.internal/v1',
				);
				expect(mockSettings.anthropicBaseUrl).toBe(
					'https://claude.internal/v1',
				);
				expect(
					(mockSettings as unknown as Record<string, unknown>)[key],
				).toBe('anthropic');
				expect(updateSpy).not.toHaveBeenCalled();
			},
		);

		it('reads the tree again when the engine changes', async () => {
			mockSettings.transcriptionEnabled = true;

			await tab.setControlValue('transcriptionProvider', 'deepgram');

			// The model catalogue and the credential fields are another
			// engine's now, in the rows that were already there.
			expect(updateSpy).toHaveBeenCalled();
		});

		it('stores a language code the way the engines receive it', () => {
			// A text control write is debounced, so it returns nothing to await.
			void tab.setControlValue('transcriptionLanguage', '  en  ');

			expect(mockSettings.transcriptionLanguage).toBe('en');
		});

		it('leaves an ordinary value untouched and asks for no re-render', async () => {
			await tab.setControlValue('debug', true);

			expect(mockSettings.debug).toBe(true);
			expect(updateSpy).not.toHaveBeenCalled();
		});
	});

	describe('per-track control keys', () => {
		/** The track's stored source, or undefined when it has none. */
		const sourceOf = (
			track: number,
		): { deviceId: string; channelMode: string } | undefined =>
			mockSettings.trackAudioSources.get(track);

		beforeEach(() => {
			mockSettings.trackAudioSources = new Map();
		});

		it('creates a track source from the device control', async () => {
			// A track's source lives in a Map keyed by track number, so the
			// control key addresses an entry rather than a settings property.
			await tab.setControlValue('track.1.deviceId', 'mic-1');

			expect(sourceOf(1)).toEqual({
				deviceId: 'mic-1',
				channelMode: 'source',
			});
			expect(saveSettingsMock).toHaveBeenCalled();
		});

		it('keeps the channel layout across a device swap', async () => {
			await tab.setControlValue('track.1.deviceId', 'mic-1');
			await tab.setControlValue('track.1.channelMode', 'mono-left');

			await tab.setControlValue('track.1.deviceId', 'iface-1');

			expect(sourceOf(1)).toEqual({
				deviceId: 'iface-1',
				channelMode: 'mono-left',
			});
		});

		it('drops the entry when the device is cleared', async () => {
			await tab.setControlValue('track.1.deviceId', 'mic-1');

			await tab.setControlValue('track.1.deviceId', '');

			expect(sourceOf(1)).toBeUndefined();
		});

		it('ignores a layout written to a track with no device', async () => {
			// There is nothing to bind a layout to, and inventing an entry would
			// make an unconfigured track look configured.
			await tab.setControlValue('track.2.channelMode', 'mono-left');

			expect(sourceOf(2)).toBeUndefined();
		});

		it('reads a track control back out of the Map', async () => {
			await tab.setControlValue('track.3.deviceId', 'mic-1');

			expect(tab.getControlValue('track.3.deviceId')).toBe('mic-1');
			expect(tab.getControlValue('track.3.channelMode')).toBe('source');
		});

		it('reads an unconfigured track as empty', () => {
			expect(tab.getControlValue('track.4.deviceId')).toBe('');
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

		it('marks the container, which is what scopes the stylesheet here', () => {
			// This Obsidian renders the tree as a flat list of rows with no
			// group element to carry a class, so the tab's own container is the
			// only handle the block separators have.
			expect(
				legacyTab.containerEl.classList.contains('aar-settings-tab'),
			).toBe(true);
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

		it('renders every declared row, so nothing is 1.13-only', () => {
			// One tree, two renderers. This walks what the definitions
			// describe and asserts the pre-1.13 renderer put all of it on
			// screen, so a section can never reach 1.13 alone. Rows with a
			// render callback are left out: their DOM is their own, and the
			// ones hosting a hand-built block clear the name away.
			mockSettings.transcriptionEnabled = true;
			mockSettings.llmPostProcessEnabled = true;
			mockSettings.enableMultiTrack = true;
			const shows = (entry: {
				visible?: boolean | (() => boolean);
			}): boolean =>
				typeof entry.visible === 'function'
					? entry.visible()
					: entry.visible !== false;
			const declared: string[] = [];
			const walk = (
				entries: ReadonlyArray<RowDefinition | GroupDefinition>,
			): void => {
				for (const entry of entries) {
					if (!shows(entry)) {
						continue;
					}
					if ('type' in entry) {
						const group = entry;
						if (group.heading) {
							declared.push(group.heading);
						}
						walk(group.items ?? []);
						continue;
					}
					if (!entry.render) {
						declared.push(entry.name);
					}
				}
			};
			walk(
				tab.getSettingDefinitions() as unknown as ReadonlyArray<
					RowDefinition | GroupDefinition
				>,
			);
			expect(declared.length).toBeGreaterThan(50);

			legacyTab.display();

			const rendered = new Set(renderedNames(legacyTab.containerEl));
			expect(
				declared.filter((name) => !rendered.has(name)),
			).toStrictEqual([]);
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

		it('rebuilds the container itself when the device list changes', async () => {
			// No framework update() to ask on this version: the tab renders the
			// tree again into its own container, exactly once.
			(
				navigator.mediaDevices.enumerateDevices as jest.Mock
			).mockResolvedValue([
				{
					deviceId: 'mic-1',
					kind: 'audioinput',
					label: 'Built-in microphone',
					groupId: '',
				},
			]);

			legacyTab.display();
			await flushAsync();

			const names = renderedNames(legacyTab.containerEl);
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

		it('names the format when this device cannot record it', async () => {
			mockSettings.recordingFormat = 'aiff';
			installRecorder(createRecorderMock());
			(
				(global as Record<string, unknown>).MediaRecorder as Record<
					string,
					unknown
				>
			).isTypeSupported = jest.fn().mockReturnValue(false);

			await runTest(tab.containerEl);

			// A failed capture has to say which format failed, or the only
			// reading left is "the microphone is broken".
			const status = tab.containerEl.querySelector('.aar-test-status');
			expect(status?.textContent).toContain('aiff');
			expect(status?.classList.contains('aar-test-error')).toBe(true);
			expect(URL.createObjectURL).not.toHaveBeenCalled();
		});

		it('reports a capture that produced no audio', async () => {
			const recorder = createRecorderMock();
			installRecorder(recorder);

			jest.useFakeTimers();
			const testPromise = runTest(tab.containerEl);
			await jest.advanceTimersByTimeAsync(0);
			// The recorder ran and stopped without ever delivering a chunk,
			// which is a silent device rather than a failure to start.
			await jest.advanceTimersByTimeAsync(5000);
			await testPromise;
			jest.useRealTimers();

			const status = tab.containerEl.querySelector('.aar-test-status');
			expect(status?.textContent).toContain('no data');
			expect(status?.classList.contains('aar-test-error')).toBe(true);
			expect(tab.containerEl.querySelector('.aar-test-audio')).toBeNull();
		});

		it('revokes the previous playback when the test is run again', async () => {
			const container = tab.containerEl;
			await recordUntilPlayback(tab, container);
			(URL.createObjectURL as jest.Mock).mockReturnValue('blob:second');

			await recordUntilPlayback(tab, container);

			// Each rerun replaces the playback element; without revoking the
			// one it replaces, a session leaks a blob per run.
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
			expect(container.querySelectorAll('.aar-test-audio')).toHaveLength(
				1,
			);
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

			legacyTab.display();

			// No framework cleanup to lean on here: the renderer releases the
			// rows it is replacing before it rebuilds the container, so the
			// same blob URL is revoked on this Obsidian too.
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
			expect(
				legacyTab.containerEl.querySelector('.aar-test-audio'),
			).toBeNull();
		});
	});

	describe('editing the native lists', () => {
		/** The collection on the page of that name, with its edit affordances. */
		const listOf = (
			pageName: string,
		): {
			items: Array<{ name: string; desc?: string }>;
			addItem?: { action: () => void };
			onDelete?: (index: number) => void;
		} =>
			listIn(
				pageOf(tab.getSettingDefinitions(), pageName),
			) as unknown as {
				items: Array<{ name: string; desc?: string }>;
				addItem?: { action: () => void };
				onDelete?: (index: number) => void;
			};

		/** Opens the add dialog of a list and answers it with an id. */
		const addThrough = async (
			heading: string,
			id: string,
		): Promise<void> => {
			listOf(heading).addItem?.action();
			const confirm = mockModelDialogs[mockModelDialogs.length - 1];
			if (!confirm) {
				throw new Error(`"${heading}" opened no dialog`);
			}
			confirm(id);
			await flushAsync();
		};

		beforeEach(() => {
			mockModelDialogs.length = 0;
			mockSettings.transcriptionEnabled = true;
			mockSettings.transcriptionProvider = 'whisper-api';
		});

		it('adds a model through the dialog and puts it in use', async () => {
			mockSettings.whisperApiModels = ['whisper-1'];
			mockSettings.whisperApiModel = 'whisper-1';

			await addThrough(
				'Whisper API (OpenAI-compatible)',
				'whisper-large-v3',
			);

			expect(mockSettings.whisperApiModels).toContain('whisper-large-v3');
			// A model is added to be used, so the addition is also the selection.
			expect(mockSettings.whisperApiModel).toBe('whisper-large-v3');
			expect(saveSettingsMock).toHaveBeenCalled();
		});

		it('moves the selection off a model it deletes', async () => {
			mockSettings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			mockSettings.whisperApiModel = 'whisper-1';

			listOf('Whisper API (OpenAI-compatible)').onDelete?.(0);
			await flushAsync();

			expect(mockSettings.whisperApiModels).toEqual(['whisper-large-v3']);
			expect(mockSettings.whisperApiModel).toBe('whisper-large-v3');
		});

		it('leaves the selection alone when another model is deleted', async () => {
			mockSettings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			mockSettings.whisperApiModel = 'whisper-1';

			listOf('Whisper API (OpenAI-compatible)').onDelete?.(1);
			await flushAsync();

			expect(mockSettings.whisperApiModels).toEqual(['whisper-1']);
			expect(mockSettings.whisperApiModel).toBe('whisper-1');
		});

		it('ignores a delete for a position the list no longer has', async () => {
			mockSettings.whisperApiModels = ['whisper-1'];

			listOf('Whisper API (OpenAI-compatible)').onDelete?.(4);
			await flushAsync();

			expect(mockSettings.whisperApiModels).toEqual(['whisper-1']);
			expect(saveSettingsMock).not.toHaveBeenCalled();
		});

		it('marks which saved model is the one in use', () => {
			mockSettings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			mockSettings.whisperApiModel = 'whisper-large-v3';

			expect(listOf('Whisper API (OpenAI-compatible)').items).toEqual([
				expect.objectContaining({ name: 'whisper-1' }),
				expect.objectContaining({
					name: 'whisper-large-v3',
					desc: 'In use',
				}),
			]);
		});

		it('adds an LLM model to the vendor in use', async () => {
			mockSettings.llmPostProcessEnabled = true;
			mockSettings.llmProvider = 'openai-compatible';
			mockSettings.llmOpenAiModels = ['gpt-4o-mini'];

			await addThrough('OpenAI', 'gpt-4o');

			expect(mockSettings.llmOpenAiModels).toContain('gpt-4o');
			expect(mockSettings.llmOpenAiModel).toBe('gpt-4o');
		});

		it('deletes an LLM model through the same list', async () => {
			mockSettings.llmPostProcessEnabled = true;
			mockSettings.llmProvider = 'openai-compatible';
			mockSettings.llmOpenAiModels = ['gpt-4o-mini', 'gpt-4o'];
			mockSettings.llmOpenAiModel = 'gpt-4o';

			listOf('OpenAI').onDelete?.(1);
			await flushAsync();

			expect(mockSettings.llmOpenAiModels).toEqual(['gpt-4o-mini']);
			expect(mockSettings.llmOpenAiModel).toBe('gpt-4o-mini');
		});

		it('deletes the id the row stands for, not the one at its position', async () => {
			// The rows were built from the catalogue as it stood; the edit runs
			// against it as it stands. Between the two the list can move - a
			// second window, a config reloaded from disk, a selection
			// reconciled into the list - and a position then names a different
			// id than the row the user clicked.
			mockSettings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			mockSettings.whisperApiModel = 'whisper-1';
			const onDelete = listOf('Whisper API (OpenAI-compatible)').onDelete;
			mockSettings.whisperApiModels = [
				'whisper-large-v3-turbo',
				'whisper-1',
				'whisper-large-v3',
			];

			onDelete?.(1);
			await flushAsync();

			expect(mockSettings.whisperApiModels).toEqual([
				'whisper-large-v3-turbo',
				'whisper-1',
			]);
		});

		it('adds the first dictionary profile and adopts it', async () => {
			mockSettings.transcriptionDictionaryProfiles = [];

			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();

			const profiles = mockSettings.transcriptionDictionaryProfiles;
			expect(profiles).toHaveLength(1);
			// Nothing usable was selected, so the first one becomes the default.
			expect(mockSettings.transcriptionDictionaryProfileId).toBe(
				profiles[0]?.id,
			);
		});

		it('numbers a further profile and leaves the default alone', async () => {
			mockSettings.transcriptionDictionaryProfiles = [];

			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();
			const first = mockSettings.transcriptionDictionaryProfileId;
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();

			// Names identify a profile's page, so a second one cannot repeat
			// the first one's name; and adding a glossary must not silently
			// change which one a run uses.
			expect(
				mockSettings.transcriptionDictionaryProfiles.map(
					(profile) => profile.name,
				),
			).toEqual(['New profile', 'New profile 2']);
			expect(mockSettings.transcriptionDictionaryProfileId).toBe(first);
		});

		it('edits a profile through the keys of its own page', async () => {
			listOf('Dictionary profiles').addItem?.action();
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();
			const [first, second] =
				mockSettings.transcriptionDictionaryProfiles;
			const bodyKey = (id: string): string =>
				`dictionaryProfile.terms#${id}`;

			await tab.setControlValue(
				bodyKey(second?.id ?? ''),
				'Kubernetes, kubectl',
			);

			// A row on one profile's page can never write to another's.
			expect(second?.terms).toBe('Kubernetes, kubectl');
			expect(first?.terms).toBe('');
			expect(tab.getControlValue(bodyKey(second?.id ?? ''))).toBe(
				'Kubernetes, kubectl',
			);
		});

		it('moves the default through the toggle on a profile page', async () => {
			listOf('Dictionary profiles').addItem?.action();
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();
			const [, second] = mockSettings.transcriptionDictionaryProfiles;
			const key = `transcriptionDictionaryProfileId#${second?.id ?? ''}`;
			expect(tab.getControlValue(key)).toBe(false);

			await tab.setControlValue(key, true);

			expect(mockSettings.transcriptionDictionaryProfileId).toBe(
				second?.id,
			);
			expect(tab.getControlValue(key)).toBe(true);
		});

		it('clears the default when a profile stops being it', async () => {
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();
			const [only] = mockSettings.transcriptionDictionaryProfiles;
			const key = `transcriptionDictionaryProfileId#${only?.id ?? ''}`;

			await tab.setControlValue(key, false);

			// Off means "no default of this kind", which the run-time resolver
			// reads as None.
			expect(mockSettings.transcriptionDictionaryProfileId).toBe('');
		});

		it('deletes a profile from its own page', async () => {
			listOf('Dictionary profiles').addItem?.action();
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();
			const [first] = mockSettings.transcriptionDictionaryProfiles;

			rowIn(
				pageOf(tab.getSettingDefinitions(), 'New profile'),
				'Delete profile',
			).action?.(createDiv(), 0);
			await flushAsync();

			expect(
				mockSettings.transcriptionDictionaryProfiles.map(
					(profile) => profile.id,
				),
			).not.toContain(first?.id);
		});

		it('reads a body key of a profile that is gone as empty', async () => {
			listOf('Dictionary profiles').addItem?.action();
			await flushAsync();

			// A profile deleted while its page was open leaves that page's
			// controls standing until the page is torn down.
			expect(tab.getControlValue('dictionaryProfile.terms#gone')).toBe(
				'',
			);
		});

		it('offers no model list for the engine that serves none', () => {
			// The local engine runs a binary against a file on disk, so its
			// page holds the paths and no catalogue at all.
			const page = pageOf(
				tab.getSettingDefinitions(),
				'Local whisper.cpp (desktop)',
			);
			const [block] = page.items as GroupDefinition[];

			expect((block?.items ?? []).map((item) => item.name ?? '')).toEqual(
				['Binary and model paths'],
			);
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
			const defs = tab.getSettingDefinitions();
			const disabledOf = (name: string): boolean => {
				const disabled = rowOf(defs, 'Audio input', name).control
					?.disabled;
				return typeof disabled === 'function'
					? disabled()
					: disabled === true;
			};

			expect(disabledOf('Input device')).toBe(true);
			expect(disabledOf('Sample rate')).toBe(true);
			expect(disabledOf('Recording channels')).toBe(true);
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
