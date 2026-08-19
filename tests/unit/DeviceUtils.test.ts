/**
 */

/**
 * Unit tests for DeviceUtils module.
 * @module tests/unit/DeviceUtils.test
 */

import {
	getAudioInputDevices,
	findDefaultDevice,
	getDefaultDeviceId,
} from 'src/utils/DeviceUtils';
import { at } from '../helpers/assertions';
import { mediaDevice } from '../helpers/mediaMocks';

// Mock navigator.mediaDevices
const mockEnumerateDevices = jest.fn();
const mockGetUserMedia = jest.fn();

Object.defineProperty(global, 'navigator', {
	value: {
		mediaDevices: {
			enumerateDevices: mockEnumerateDevices,
			getUserMedia: mockGetUserMedia,
		},
	},
	writable: true,
});

describe('DeviceUtils', () => {
	describe('getAudioInputDevices', () => {
		it('returns only audio input devices', async () => {
			const devices: MediaDeviceInfo[] = [
				mediaDevice('default', 'Default - Microphone'),
				mediaDevice('videodevice1', 'Camera', 'videoinput'),
				mediaDevice('audiooutput1', 'Speakers', 'audiooutput'),
			] as MediaDeviceInfo[];

			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getAudioInputDevices();

			expect(result).toHaveLength(1);
			expect(at(result, 0).deviceId).toBe('default');
			expect(at(result, 0).kind).toBe('audioinput');
		});

		it('returns empty array when no audio input devices exist', async () => {
			mockEnumerateDevices.mockResolvedValue([]);

			const result = await getAudioInputDevices();

			expect(result).toHaveLength(0);
		});
	});

	describe('findDefaultDevice', () => {
		it('finds the device whose id is "default"', () => {
			const devices: MediaDeviceInfo[] = [
				mediaDevice('device1', 'Device 1'),
				mediaDevice('default', 'Default - Microphone'),
			] as MediaDeviceInfo[];

			const result = findDefaultDevice(devices);

			expect(result).toBeDefined();
			expect(result?.deviceId).toBe('default');
			expect(result?.label).toBe('Default - Microphone');
		});

		it('returns undefined when no default device exists', () => {
			const devices: MediaDeviceInfo[] = [
				mediaDevice('device1', 'Device 1'),
			] as MediaDeviceInfo[];

			const result = findDefaultDevice(devices);

			expect(result).toBeUndefined();
		});

		it('returns undefined for empty array', () => {
			const result = findDefaultDevice([]);

			expect(result).toBeUndefined();
		});
	});

	describe('getDefaultDeviceId', () => {
		it('returns default device ID when available', async () => {
			const devices: MediaDeviceInfo[] = [
				mediaDevice('default', 'Default - Microphone'),
			] as MediaDeviceInfo[];

			mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getDefaultDeviceId();

			expect(result).toBe('default');
			expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
		});

		it('returns empty string when no default device exists', async () => {
			const devices: MediaDeviceInfo[] = [
				mediaDevice('device1', 'Device 1'),
			] as MediaDeviceInfo[];

			mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getDefaultDeviceId();

			expect(result).toBe('');
		});

		it('returns empty string when permission is denied', async () => {
			mockGetUserMedia.mockRejectedValue(new Error('Permission denied'));

			const result = await getDefaultDeviceId();

			expect(result).toBe('');
		});

		it('stops tracks after getting user media', async () => {
			const mockStop = jest.fn();
			const devices: MediaDeviceInfo[] = [
				mediaDevice('default', 'Default - Microphone'),
			] as MediaDeviceInfo[];

			mockGetUserMedia.mockResolvedValue({
				getTracks: () => [{ stop: mockStop }],
			});
			mockEnumerateDevices.mockResolvedValue(devices);

			await getDefaultDeviceId();

			expect(mockStop).toHaveBeenCalled();
		});
	});
});
