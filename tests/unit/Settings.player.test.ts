/**
 * Tests for the enhanced player settings. Only two windows are
 * user-toggleable (waveform, markers/chapters); every control button is
 * fixed, so resolvePlayerSettings reflects the two toggles and hard-codes
 * the rest.
 */

import { DEFAULT_SETTINGS } from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import {
	resolvePlayerSettings,
	playerSettingsEqual,
} from 'src/player/playerSettings';

describe('enhanced player settings', () => {
	it('ships disabled with both windows on by default', () => {
		expect(DEFAULT_SETTINGS.enhancedPlayerEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.playerShowWaveform).toBe(true);
		expect(DEFAULT_SETTINGS.playerEnableMarkers).toBe(true);
	});

	// Every fixed control stays fixed. The skip step is the one exception and
	// it is deliberate: five seconds suits picking apart speech and thirty
	// suits a lecture, so the right value belongs to the recording rather than
	// to the plugin. Everything else the player draws is still not a setting.
	it('exposes the two windows and the skip step, and nothing else', () => {
		const playerKeys = Object.keys(DEFAULT_SETTINGS).filter((key) =>
			key.startsWith('player'),
		);
		expect(playerKeys.sort()).toEqual([
			'playerEnableMarkers',
			'playerShowWaveform',
			'playerSkipSeconds',
		]);
	});
});

describe('resolvePlayerSettings', () => {
	it('carries the two windows and the step every surface skips by', () => {
		const resolved = resolvePlayerSettings(
			mergeSettings({
				playerShowWaveform: true,
				playerEnableMarkers: true,
			}),
		);

		expect(resolved).toEqual({
			showWaveform: true,
			enableMarkers: true,
			skipSeconds: 10,
		});
	});

	it('reflects the waveform window toggle', () => {
		expect(
			resolvePlayerSettings(mergeSettings({ playerShowWaveform: false }))
				.showWaveform,
		).toBe(false);
		expect(
			resolvePlayerSettings(mergeSettings({ playerShowWaveform: true }))
				.showWaveform,
		).toBe(true);
	});

	it('reflects the markers window toggle', () => {
		expect(
			resolvePlayerSettings(mergeSettings({ playerEnableMarkers: false }))
				.enableMarkers,
		).toBe(false);
		expect(
			resolvePlayerSettings(mergeSettings({ playerEnableMarkers: true }))
				.enableMarkers,
		).toBe(true);
	});
});

describe('playerSettingsEqual', () => {
	it('is true for identical layouts', () => {
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: false, skipSeconds: 10 },
				{ showWaveform: true, enableMarkers: false, skipSeconds: 10 },
			),
		).toBe(true);
	});

	it('is false when the waveform toggle differs', () => {
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: true, skipSeconds: 10 },
				{ showWaveform: false, enableMarkers: true, skipSeconds: 10 },
			),
		).toBe(false);
	});

	it('is false when the markers toggle differs', () => {
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: true, skipSeconds: 10 },
				{ showWaveform: true, enableMarkers: false, skipSeconds: 10 },
			),
		).toBe(false);
	});
});
