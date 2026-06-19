/**
 * Tests for the enhanced player settings. The player's elements are fixed
 * (no per-element toggles), so the only player setting is the master enable
 * flag and resolvePlayerSettings returns a constant layout.
 */

import { DEFAULT_SETTINGS, resolvePlayerSettings } from 'src/settings/Settings';
import {
	DEFAULT_PLAYER_WAVEFORM_HEIGHT,
	DEFAULT_PLAYER_SKIP_SECONDS,
	DEFAULT_PLAYER_PLAYBACK_RATE,
} from 'src/constants';

describe('enhanced player settings', () => {
	it('ships disabled by default', () => {
		expect(DEFAULT_SETTINGS.enhancedPlayerEnabled).toBe(false);
	});

	it('exposes only the master toggle (no per-element settings)', () => {
		const playerKeys = Object.keys(DEFAULT_SETTINGS).filter((key) =>
			key.startsWith('player'),
		);
		expect(playerKeys).toEqual([]);
	});
});

describe('resolvePlayerSettings', () => {
	it('returns the fixed layout with every element enabled', () => {
		const resolved = resolvePlayerSettings();

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
});
