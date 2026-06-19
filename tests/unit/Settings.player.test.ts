/**
 * Tests for the enhanced player settings. Only two windows are
 * user-toggleable (waveform, markers/chapters); every control button is
 * fixed, so resolvePlayerSettings reflects the two toggles and hard-codes
 * the rest.
 */

import {
	DEFAULT_SETTINGS,
	mergeSettings,
	resolvePlayerSettings,
} from 'src/settings/Settings';
import {
	DEFAULT_PLAYER_WAVEFORM_HEIGHT,
	DEFAULT_PLAYER_SKIP_SECONDS,
	DEFAULT_PLAYER_PLAYBACK_RATE,
} from 'src/constants';

describe('enhanced player settings', () => {
	it('ships disabled with both windows on by default', () => {
		expect(DEFAULT_SETTINGS.enhancedPlayerEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.playerShowWaveform).toBe(true);
		expect(DEFAULT_SETTINGS.playerEnableMarkers).toBe(true);
	});

	it('exposes only the two window toggles (no per-button settings)', () => {
		const playerKeys = Object.keys(DEFAULT_SETTINGS).filter((key) =>
			key.startsWith('player'),
		);
		expect(playerKeys.sort()).toEqual([
			'playerEnableMarkers',
			'playerShowWaveform',
		]);
	});
});

describe('resolvePlayerSettings', () => {
	it('shows every fixed control and honours both window toggles', () => {
		const resolved = resolvePlayerSettings(
			mergeSettings({
				playerShowWaveform: true,
				playerEnableMarkers: true,
			}),
		);

		expect(resolved).toEqual({
			showWaveform: true,
			waveformHeight: DEFAULT_PLAYER_WAVEFORM_HEIGHT,
			showSpeedControl: true,
			defaultPlaybackRate: DEFAULT_PLAYER_PLAYBACK_RATE,
			showSkipButtons: true,
			skipSeconds: DEFAULT_PLAYER_SKIP_SECONDS,
			showVolumeControl: true,
			showTimeDisplay: true,
			defaultLoop: false,
			enableTimestampLinks: true,
			showMuteButton: true,
			enableMarkers: true,
			showMarkerList: true,
			showChapterNav: true,
		});
	});

	it('reflects the waveform window toggle', () => {
		const resolved = resolvePlayerSettings(
			mergeSettings({ playerShowWaveform: false }),
		);
		expect(resolved.showWaveform).toBe(false);
		// Buttons stay fixed regardless
		expect(resolved.showSpeedControl).toBe(true);
		expect(resolved.showVolumeControl).toBe(true);
	});

	it('reflects the markers window toggle across the marker fields', () => {
		const resolved = resolvePlayerSettings(
			mergeSettings({ playerEnableMarkers: false }),
		);
		expect(resolved.enableMarkers).toBe(false);
		expect(resolved.showMarkerList).toBe(false);
		expect(resolved.showChapterNav).toBe(false);
	});
});
