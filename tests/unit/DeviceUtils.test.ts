/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for DeviceUtils module.
 * @module tests/unit/DeviceUtils.test
 */

import {
	getAudioInputDevices,
	findDefaultDevice,
	getDefaultDeviceId,
} from '../../src/utils/DeviceUtils';

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
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('getAudioInputDevices', () => {
		it('should return only audio input devices', async () => {
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'default',
					label: 'Default - Microphone',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
				{
					deviceId: 'videodevice1',
					label: 'Camera',
					kind: 'videoinput',
					groupId: 'group2',
					toJSON: () => ({}),
				},
				{
					deviceId: 'audiooutput1',
					label: 'Speakers',
					kind: 'audiooutput',
					groupId: 'group3',
					toJSON: () => ({}),
				},
			] as MediaDeviceInfo[];

			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getAudioInputDevices();

			expect(result).toHaveLength(1);
			expect(result[0].deviceId).toBe('default');
			expect(result[0].kind).toBe('audioinput');
		});

		it('should return empty array when no audio input devices exist', async () => {
			mockEnumerateDevices.mockResolvedValue([]);

			const result = await getAudioInputDevices();

			expect(result).toHaveLength(0);
		});
	});

	describe('findDefaultDevice', () => {
		it('should find device with deviceId "default"', () => {
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'device1',
					label: 'Device 1',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
				{
					deviceId: 'default',
					label: 'Default - Microphone',
					kind: 'audioinput',
					groupId: 'group2',
					toJSON: () => ({}),
				},
			] as MediaDeviceInfo[];

			const result = findDefaultDevice(devices);

			expect(result).toBeDefined();
			expect(result?.deviceId).toBe('default');
			expect(result?.label).toBe('Default - Microphone');
		});

		it('should return undefined when no default device exists', () => {
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'device1',
					label: 'Device 1',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
			] as MediaDeviceInfo[];

			const result = findDefaultDevice(devices);

			expect(result).toBeUndefined();
		});

		it('should return undefined for empty array', () => {
			const result = findDefaultDevice([]);

			expect(result).toBeUndefined();
		});
	});

	describe('getDefaultDeviceId', () => {
		it('should return default device ID when available', async () => {
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'default',
					label: 'Default - Microphone',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
			] as MediaDeviceInfo[];

			mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getDefaultDeviceId();

			expect(result).toBe('default');
			expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
		});

		it('should return empty string when no default device exists', async () => {
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'device1',
					label: 'Device 1',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
			] as MediaDeviceInfo[];

			mockGetUserMedia.mockResolvedValue({ getTracks: () => [] });
			mockEnumerateDevices.mockResolvedValue(devices);

			const result = await getDefaultDeviceId();

			expect(result).toBe('');
		});

		it('should return empty string when permission is denied', async () => {
			mockGetUserMedia.mockRejectedValue(new Error('Permission denied'));

			const result = await getDefaultDeviceId();

			expect(result).toBe('');
		});

		it('should stop tracks after getting user media', async () => {
			const mockStop = jest.fn();
			const devices: MediaDeviceInfo[] = [
				{
					deviceId: 'default',
					label: 'Default - Microphone',
					kind: 'audioinput',
					groupId: 'group1',
					toJSON: () => ({}),
				},
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
