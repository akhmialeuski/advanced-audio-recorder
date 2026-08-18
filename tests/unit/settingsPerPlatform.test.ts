/**
 * Tests for the per-platform settings branches: migration of the legacy
 * flat device fields into the desktop branch, resolution of the active
 * branch per platform, and serialization that keeps the two platforms'
 * device configuration strictly separated in data.json.
 * @module tests/unit/settingsPerPlatform.test
 */

import {
	mergeSettings,
	mergeSettingsAsync,
	normalizePerPlatformSettings,
	normalizePlatformScopedSettings,
	serializeSettings,
} from 'src/settings/settingsSerialization';
import type { AudioRecorderSettingsInput } from 'src/settings/settingsSchema';
import { setPlatform } from '../helpers/platform';

/** A legacy (pre-perPlatform) data.json shape with desktop device state. */
function legacyStored(): AudioRecorderSettingsInput {
	return {
		audioDeviceId: 'desktop-mic',
		recordingChannels: 'mono-left',
		trackAudioSources: {
			1: { deviceId: 'desktop-dev-1', channelMode: 'source' },
			2: 'desktop-dev-2-bare-id',
		},
	};
}

describe('normalizePlatformScopedSettings', () => {
	it('returns scoped defaults for a missing or malformed branch', () => {
		for (const input of [undefined, null, 42, 'oops']) {
			const branch = normalizePlatformScopedSettings(input as never);
			expect(branch.audioDeviceId).toBe('');
			expect(branch.recordingChannels).toBe('source');
			expect(branch.trackAudioSources.size).toBe(0);
		}
	});

	it('normalizes hand-edited values inside a branch', () => {
		const branch = normalizePlatformScopedSettings({
			audioDeviceId: 123,
			recordingChannels: 'sideways',
			trackAudioSources: { 1: 'bare-device-id' },
		});
		expect(branch.audioDeviceId).toBe('');
		expect(branch.recordingChannels).toBe('source');
		expect(branch.trackAudioSources.get(1)).toEqual({
			deviceId: 'bare-device-id',
			channelMode: 'source',
		});
	});
});

describe('legacy flat settings migration', () => {
	it('moves legacy flat device fields into the desktop branch', () => {
		const perPlatform = normalizePerPlatformSettings(legacyStored());
		expect(perPlatform.desktop.audioDeviceId).toBe('desktop-mic');
		expect(perPlatform.desktop.recordingChannels).toBe('mono-left');
		expect(perPlatform.desktop.trackAudioSources.get(2)?.deviceId).toBe(
			'desktop-dev-2-bare-id',
		);
		// The mobile branch starts clean - desktop ids never leak into it
		expect(perPlatform.mobile.audioDeviceId).toBe('');
		expect(perPlatform.mobile.trackAudioSources.size).toBe(0);
	});

	it('migrates legacy fields to the desktop branch even when loading on mobile', () => {
		setPlatform({ isMobile: true });
		const merged = mergeSettings(legacyStored());
		// Active (mobile) values are the clean mobile defaults...
		expect(merged.audioDeviceId).toBe('');
		expect(merged.recordingChannels).toBe('source');
		expect(merged.trackAudioSources.size).toBe(0);
		// ...while the desktop hardware config is preserved in its branch
		expect(merged.perPlatform.desktop.audioDeviceId).toBe('desktop-mic');
		expect(merged.perPlatform.desktop.recordingChannels).toBe('mono-left');
	});

	it('prefers a stored perPlatform branch over stale legacy flat fields', () => {
		const stored: AudioRecorderSettingsInput = {
			...legacyStored(),
			perPlatform: {
				desktop: {
					audioDeviceId: 'newer-desktop-mic',
					recordingChannels: 'mono-mix',
					trackAudioSources: {},
				},
			},
		};
		const merged = mergeSettings(stored, 'desktop');
		expect(merged.audioDeviceId).toBe('newer-desktop-mic');
		expect(merged.recordingChannels).toBe('mono-mix');
		expect(merged.perPlatform.desktop.audioDeviceId).toBe(
			'newer-desktop-mic',
		);
	});

	it('falls back to legacy flat fields when the stored map lacks a desktop branch', () => {
		const stored: AudioRecorderSettingsInput = {
			...legacyStored(),
			perPlatform: {
				mobile: {
					audioDeviceId: 'phone-mic',
					recordingChannels: 'source',
					trackAudioSources: {},
				},
			},
		};
		const perPlatform = normalizePerPlatformSettings(stored);
		expect(perPlatform.desktop.audioDeviceId).toBe('desktop-mic');
		expect(perPlatform.mobile.audioDeviceId).toBe('phone-mic');
	});
});

describe('active-branch resolution', () => {
	const stored: AudioRecorderSettingsInput = {
		perPlatform: {
			desktop: {
				audioDeviceId: 'desktop-mic',
				recordingChannels: 'mono-left',
				trackAudioSources: {
					1: { deviceId: 'desk-1', channelMode: 'source' },
				},
			},
			mobile: {
				audioDeviceId: 'phone-mic',
				recordingChannels: 'source',
				trackAudioSources: {},
			},
		},
	};

	it('activates the desktop branch on desktop', () => {
		const merged = mergeSettings(stored, 'desktop');
		expect(merged.audioDeviceId).toBe('desktop-mic');
		expect(merged.recordingChannels).toBe('mono-left');
		expect(merged.trackAudioSources.get(1)?.deviceId).toBe('desk-1');
	});

	it('activates the mobile branch on mobile', () => {
		const merged = mergeSettings(stored, 'mobile');
		expect(merged.audioDeviceId).toBe('phone-mic');
		expect(merged.trackAudioSources.size).toBe(0);
	});

	it('defaults the platform argument to the current platform', () => {
		setPlatform({ isMobile: true });
		const merged = mergeSettings(stored);
		expect(merged.audioDeviceId).toBe('phone-mic');
	});

	it('shares the active branch Map with the flat field', () => {
		const merged = mergeSettings(stored, 'desktop');
		merged.trackAudioSources.set(2, {
			deviceId: 'desk-2',
			channelMode: 'source',
		});
		// In-place edits (as the settings tab performs) land in the branch
		expect(
			merged.perPlatform.desktop.trackAudioSources.get(2)?.deviceId,
		).toBe('desk-2');
	});
});

describe('serializeSettings platform separation', () => {
	it('drops the flat device fields from the persisted shape', () => {
		const merged = mergeSettings(legacyStored(), 'desktop');
		const serialized = serializeSettings(
			merged,
			'desktop',
		) as unknown as Record<string, unknown>;
		expect(serialized).not.toHaveProperty('audioDeviceId');
		expect(serialized).not.toHaveProperty('recordingChannels');
		expect(serialized).not.toHaveProperty('trackAudioSources');
	});

	it('writes the active values into the current platform branch only', () => {
		const merged = mergeSettings(legacyStored(), 'desktop');
		merged.audioDeviceId = 'replugged-mic';
		const serialized = serializeSettings(merged, 'desktop');
		expect(serialized.perPlatform.desktop.audioDeviceId).toBe(
			'replugged-mic',
		);
		expect(serialized.perPlatform.mobile.audioDeviceId).toBe('');
	});

	it('serializes track sources of both branches as plain records', () => {
		const merged = mergeSettings(legacyStored(), 'desktop');
		const serialized = serializeSettings(merged, 'desktop');
		expect(serialized.perPlatform.desktop.trackAudioSources).toEqual({
			1: { deviceId: 'desktop-dev-1', channelMode: 'source' },
			2: { deviceId: 'desktop-dev-2-bare-id', channelMode: 'source' },
		});
		expect(serialized.perPlatform.mobile.trackAudioSources).toEqual({});
	});

	it('survives a desktop -> mobile -> desktop sync round-trip untouched', () => {
		// Desktop saves its config
		const onDesktop = mergeSettings(legacyStored(), 'desktop');
		const savedByDesktop = serializeSettings(onDesktop, 'desktop');

		// The vault syncs to a phone, which loads, edits its own device
		// state, and saves
		const onMobile = mergeSettings(savedByDesktop, 'mobile');
		expect(onMobile.audioDeviceId).toBe('');
		onMobile.audioDeviceId = 'phone-mic';
		const savedByMobile = serializeSettings(onMobile, 'mobile');

		// Back on desktop, the desktop hardware config is exactly as saved
		const backOnDesktop = mergeSettings(savedByMobile, 'desktop');
		expect(backOnDesktop.audioDeviceId).toBe('desktop-mic');
		expect(backOnDesktop.recordingChannels).toBe('mono-left');
		expect(backOnDesktop.trackAudioSources.get(1)?.deviceId).toBe(
			'desktop-dev-1',
		);
		expect(backOnDesktop.perPlatform.mobile.audioDeviceId).toBe(
			'phone-mic',
		);
	});
});

describe('mergeSettingsAsync device auto-detection', () => {
	const originalMediaDevices = navigator.mediaDevices;
	let getUserMedia: jest.Mock;
	let enumerateDevices: jest.Mock;

	beforeEach(() => {
		getUserMedia = jest.fn().mockResolvedValue({
			getTracks: () => [{ stop: jest.fn() }],
		});
		enumerateDevices = jest
			.fn()
			.mockResolvedValue([
				{ deviceId: 'default', kind: 'audioinput', label: 'Default' },
			]);
		Object.defineProperty(navigator, 'mediaDevices', {
			value: { getUserMedia, enumerateDevices },
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: originalMediaDevices,
			configurable: true,
		});
	});

	it('detects the default device on desktop and stores it in the branch', async () => {
		const merged = await mergeSettingsAsync({}, 'desktop');
		expect(getUserMedia).toHaveBeenCalled();
		expect(merged.audioDeviceId).toBe('default');
		expect(merged.perPlatform.desktop.audioDeviceId).toBe('default');
	});

	it('never probes the microphone on mobile', async () => {
		// Device selection is unavailable there; probing would raise a
		// permission prompt at app start for nothing.
		const merged = await mergeSettingsAsync({}, 'mobile');
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(merged.audioDeviceId).toBe('');
	});
});
