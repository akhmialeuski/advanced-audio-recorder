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
	playerSettingsEqual,
} from 'src/settings/Settings';

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
	it('carries only the two window toggles (fixed elements are not fields)', () => {
		const resolved = resolvePlayerSettings(
			mergeSettings({
				playerShowWaveform: true,
				playerEnableMarkers: true,
			}),
		);

		expect(resolved).toEqual({
			showWaveform: true,
			enableMarkers: true,
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
				{ showWaveform: true, enableMarkers: false },
				{ showWaveform: true, enableMarkers: false },
			),
		).toBe(true);
	});

	it('is false when the waveform toggle differs', () => {
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: true },
				{ showWaveform: false, enableMarkers: true },
			),
		).toBe(false);
	});

	it('is false when the markers toggle differs', () => {
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: true },
				{ showWaveform: true, enableMarkers: false },
			),
		).toBe(false);
	});
});
