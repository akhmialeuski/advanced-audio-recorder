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
});
