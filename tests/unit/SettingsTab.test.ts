/**
 * Unit tests for AudioRecorderSettingTab module.
 * Tests device-change listener lifecycle and test recording cleanup.
 * @module tests/unit/SettingsTab.test
 */

import { App, Platform } from 'obsidian';
import { AudioRecorderSettingTab } from 'src/settings/SettingsTab';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { DOCS_URL } from 'src/constants';

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

describe('AudioRecorderSettingTab', () => {
	let tab: AudioRecorderSettingTab;
	let mockSettings: AudioRecorderSettings;
	let addEventListenerMock: jest.Mock;
	let removeEventListenerMock: jest.Mock;
	let getUserMediaMock: jest.Mock;
	let saveSettingsMock: jest.Mock;

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
		const mockPlugin = {
			settings: mockSettings,
			saveSettings: saveSettingsMock,
		};
		tab = new AudioRecorderSettingTab(new App(), mockPlugin);
	});

	describe('getSettingDefinitions (declarative settings, Obsidian 1.13+)', () => {
		it('returns one render definition carrying the setting names as search aliases', () => {
			const defs = tab.getSettingDefinitions();

			expect(defs).toHaveLength(1);
			const def = defs[0] as {
				name: string;
				aliases?: string[];
				render?: unknown;
			};
			expect(def.name).toBeTruthy();
			expect(def.aliases).toEqual(
				expect.arrayContaining([
					'Recording format',
					'Enable multi-track recording',
					'Enable transcription',
				]),
			);
			expect(typeof def.render).toBe('function');
		});

		it('renders the settings body into the group and drops the anchor row', () => {
			const def = tab.getSettingDefinitions()[0] as {
				render: (setting: unknown) => void;
			};
			const listEl = createDiv();
			const anchorEl = createDiv();
			listEl.appendChild(anchorEl);

			def.render({ settingEl: anchorEl });

			// The empty anchor row the framework creates for a render item is
			// removed, and the real controls land in the group's list element.
			expect(listEl.contains(anchorEl)).toBe(false);
			expect(
				listEl.querySelector('.aar-doc-callout-link'),
			).not.toBeNull();
			expect(addEventListenerMock).toHaveBeenCalledWith(
				'devicechange',
				expect.any(Function),
			);
		});

		it('carries every default-visible setting and heading name as a search alias', () => {
			// The tab renders imperatively, so the alias list is maintained by
			// hand. Guard against it drifting from the real names: every name
			// rendered with the default settings must be a search alias, or the
			// setting becomes unfindable in Obsidian's settings search.
			const aliases = new Set(
				(tab.getSettingDefinitions()[0] as { aliases: string[] })
					.aliases,
			);
			tab.display();

			const rendered = Array.from(
				tab.containerEl.querySelectorAll('.setting-item-name'),
			)
				.map((el) => el.textContent?.trim() ?? '')
				.filter((name) => name.length > 0);

			expect(rendered.length).toBeGreaterThan(0);
			const missing = rendered.filter((name) => !aliases.has(name));
			expect(missing).toEqual([]);
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

		const runTest = (container: HTMLElement): Promise<void> =>
			(
				tab as unknown as {
					runTestRecording(c: HTMLElement): Promise<void>;
				}
			).runTestRecording(container);

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

			expect(channelSelects()[0].disabled).toBe(false);
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

			expect(channelSelects()[0].disabled).toBe(true);
			expect(mockSettings.recordingChannels).toBe('mono-left');
			expect(saveSettingsMock).not.toHaveBeenCalled();
		});

		it('keeps the global selector enabled when capability is unknown', async () => {
			installDevices([fakeInputDevice('opaque-dev')]);
			mockSettings.audioDeviceId = 'opaque-dev';

			await renderAndSettle();

			expect(channelSelects()[0].disabled).toBe(false);
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
			expect(selects[1].disabled).toBe(false);
			expect(selects[2].disabled).toBe(true);
			// Track 3 has no device: nothing to bind the mode to
			expect(selects[3].disabled).toBe(true);
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
			expect(channelSelects()[1].disabled).toBe(false);

			installDevices([]);
			const deviceChange = addEventListenerMock.mock
				.calls[0][1] as () => void;
			deviceChange();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(channelSelects()[1].disabled).toBe(true);
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
			expect(channelSelects()[0].disabled).toBe(false);

			resolveOlder?.([fakeInputDevice('selected-dev', 1)]);
			await new Promise((resolve) => setTimeout(resolve, 0));

			// The older mono result must not overwrite the newer stereo view.
			expect(channelSelects()[0].disabled).toBe(false);
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

			const trackChannelSelect = channelSelects()[1];
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
			const trackDeviceSelect = deviceSelects[deviceSelects.length - 1];
			trackDeviceSelect.value = 'other-stereo';
			trackDeviceSelect.dispatchEvent(new Event('change'));
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockSettings.trackAudioSources.get(1)).toEqual({
				deviceId: 'other-stereo',
				channelMode: 'mono-left',
			});
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
