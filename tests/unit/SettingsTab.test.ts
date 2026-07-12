/**
 * Unit tests for AudioRecorderSettingTab module.
 * Tests device-change listener lifecycle and test recording cleanup.
 * @module tests/unit/SettingsTab.test
 */

import { App } from 'obsidian';
import { AudioRecorderSettingTab } from 'src/settings/SettingsTab';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import { DOCS_URL } from 'src/constants';

// Mock AudioEncoder to avoid loading mediabunny in jsdom
jest.mock('src/audio/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'wav', 'webm', 'ogg', 'mp4', 'm4a'].includes(format),
	),
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
		const mockPlugin = {
			settings: mockSettings,
			saveSettings: jest.fn().mockResolvedValue(undefined),
		};
		tab = new AudioRecorderSettingTab(new App(), mockPlugin);
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

		it('disables the global selector and resets the mode for a known-mono device', async () => {
			installDevices([fakeInputDevice('mono-dev', 1)]);
			mockSettings.audioDeviceId = 'mono-dev';
			mockSettings.recordingChannels = 'mono-left';

			await renderAndSettle();

			expect(channelSelects()[0].disabled).toBe(true);
			// A mono mode stored for a device that cannot use it is reset
			expect(mockSettings.recordingChannels).toBe('source');
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
			// The mono-capable track keeps its mode; the mono device's is reset
			expect(mockSettings.trackAudioSources.get(1)?.channelMode).toBe(
				'mono-left',
			);
			expect(mockSettings.trackAudioSources.get(2)?.channelMode).toBe(
				'source',
			);
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
});
