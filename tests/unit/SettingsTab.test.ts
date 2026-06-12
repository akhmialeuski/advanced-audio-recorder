/**
 * Unit tests for AudioRecorderSettingTab module.
 * Tests device-change listener lifecycle and test recording cleanup.
 * @module tests/unit/SettingsTab.test
 */
/** @jest-environment jsdom */

import { App } from 'obsidian';
import { AudioRecorderSettingTab } from '../../src/settings/SettingsTab';
import {
	DEFAULT_SETTINGS,
	AudioRecorderSettings,
} from '../../src/settings/Settings';

// Mock AudioEncoder to avoid loading mediabunny in jsdom
jest.mock('../../src/recording/AudioEncoder', () => ({
	encodeAudioBuffer: jest.fn(),
	isOfflineEncodingSupported: jest.fn((format: string) =>
		['mp3', 'flac', 'wav', 'webm', 'ogg', 'mp4', 'm4a'].includes(format),
	),
	getEncoderDescription: jest.fn().mockReturnValue('Test Encoder'),
}));

// Mock SystemDiagnostics: pulled in by the settings tab but exercised
// in its own suite
jest.mock('../../src/diagnostics/SystemDiagnostics', () => ({
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
		tab = new AudioRecorderSettingTab(
			new App(),
			mockPlugin as unknown as AudioRecorderSettingTab['plugin'],
		);
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
});
