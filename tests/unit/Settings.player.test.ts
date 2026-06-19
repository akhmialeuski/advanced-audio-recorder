/**
 * Tests for enhanced-player settings defaults and the defensive
 * clamping done by resolvePlayerSettings.
 */

import {
	DEFAULT_SETTINGS,
	mergeSettings,
	resolvePlayerSettings,
} from 'src/settings/Settings';
import {
	DEFAULT_PLAYER_WAVEFORM_HEIGHT,
	MIN_PLAYER_WAVEFORM_HEIGHT,
	MAX_PLAYER_WAVEFORM_HEIGHT,
	DEFAULT_PLAYER_PLAYBACK_RATE,
	MIN_PLAYER_PLAYBACK_RATE,
	MAX_PLAYER_PLAYBACK_RATE,
	MIN_PLAYER_SKIP_SECONDS,
	MAX_PLAYER_SKIP_SECONDS,
} from 'src/constants';

describe('enhanced player default settings', () => {
	it('ships disabled with sensible control defaults', () => {
		expect(DEFAULT_SETTINGS.enhancedPlayerEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.playerShowWaveform).toBe(true);
		expect(DEFAULT_SETTINGS.playerWaveformHeight).toBe(
			DEFAULT_PLAYER_WAVEFORM_HEIGHT,
		);
		expect(DEFAULT_SETTINGS.playerDefaultPlaybackRate).toBe(
			DEFAULT_PLAYER_PLAYBACK_RATE,
		);
		expect(DEFAULT_SETTINGS.playerEnableTimestampLinks).toBe(true);
	});
});

describe('resolvePlayerSettings', () => {
	it('passes through in-range numeric values', () => {
		const settings = mergeSettings({
			playerSkipSeconds: 15,
			playerDefaultPlaybackRate: 1.5,
		});
		const resolved = resolvePlayerSettings(settings);
		expect(resolved.skipSeconds).toBe(15);
		expect(resolved.defaultPlaybackRate).toBe(1.5);
	});

	it('clamps numeric fields that fall outside their range', () => {
		const settings = mergeSettings({
			playerWaveformHeight: 10_000,
			playerSkipSeconds: 0,
			playerDefaultPlaybackRate: 99,
		});
		const resolved = resolvePlayerSettings(settings);
		expect(resolved.waveformHeight).toBe(MAX_PLAYER_WAVEFORM_HEIGHT);
		expect(resolved.skipSeconds).toBe(MIN_PLAYER_SKIP_SECONDS);
		expect(resolved.defaultPlaybackRate).toBe(MAX_PLAYER_PLAYBACK_RATE);
	});

	it('clamps below-range values up to the minimum', () => {
		const settings = mergeSettings({
			playerWaveformHeight: 1,
			playerSkipSeconds: 9_999,
			playerDefaultPlaybackRate: 0.01,
		});
		const resolved = resolvePlayerSettings(settings);
		expect(resolved.waveformHeight).toBe(MIN_PLAYER_WAVEFORM_HEIGHT);
		expect(resolved.skipSeconds).toBe(MAX_PLAYER_SKIP_SECONDS);
		expect(resolved.defaultPlaybackRate).toBe(MIN_PLAYER_PLAYBACK_RATE);
	});

	it('falls back to defaults for non-finite values', () => {
		const settings = mergeSettings({});
		settings.playerWaveformHeight = Number.NaN;
		settings.playerDefaultPlaybackRate = Number.NaN;
		const resolved = resolvePlayerSettings(settings);
		expect(resolved.waveformHeight).toBe(DEFAULT_PLAYER_WAVEFORM_HEIGHT);
		expect(resolved.defaultPlaybackRate).toBe(DEFAULT_PLAYER_PLAYBACK_RATE);
	});
});
