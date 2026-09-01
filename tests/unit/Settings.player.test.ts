/**
 * Tests for the enhanced player settings. Only two windows are
 * user-toggleable (waveform, markers/chapters); every control button is
 * fixed, so resolvePlayerSettings reflects the two toggles and hard-codes
 * the rest.
 */

import {
	MAX_PLAYER_SKIP_SECONDS,
	MIN_PLAYER_SKIP_SECONDS,
	PLAYER_SKIP_SECONDS,
} from 'src/constants';
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

// Settings are read from disk without validation, so the range the settings
// row declares is enforced nowhere the value actually travels. A hand-edited
// file reached the embed, the status bar, the commands, and an audio element
// unchecked: a step of zero left every skip control inert, and one that is not
// a number moved playback to NaN.
describe('the skip step a stored setting resolves to', () => {
	/** The step resolvePlayerSettings answers with for a stored value. */
	function resolvedStep(playerSkipSeconds: number): number {
		return resolvePlayerSettings(mergeSettings({ playerSkipSeconds }))
			.skipSeconds;
	}

	it.each([
		{ what: 'a step of zero', stored: 0, step: MIN_PLAYER_SKIP_SECONDS },
		{ what: 'a negative step', stored: -30, step: MIN_PLAYER_SKIP_SECONDS },
		{
			what: 'a step past the ceiling',
			stored: 9000,
			step: MAX_PLAYER_SKIP_SECONDS,
		},
	])('brings $what inside the declared range', ({ stored, step }) => {
		expect(resolvedStep(stored)).toBe(step);
	});

	it.each([
		{ what: 'is not a number', stored: Number.NaN },
		{ what: 'is infinite', stored: Number.POSITIVE_INFINITY },
	])('falls back to the default for a step that $what', ({ stored }) => {
		expect(resolvedStep(stored)).toBe(PLAYER_SKIP_SECONDS);
	});

	it('leaves a step inside the range exactly as it was stored', () => {
		expect(resolvedStep(30)).toBe(30);
	});

	it('takes a fractional step down to whole seconds', () => {
		// A skip is offered as a whole number of seconds everywhere it is
		// named, so a stored fraction would make the label a lie.
		expect(resolvedStep(7.6)).toBe(7);
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

	it('is false when the skip step differs', () => {
		// The step is what an open player answers the status bar and the
		// commands with, so a layout reported as unchanged leaves them on the
		// old number while anything started afterwards uses the new one.
		expect(
			playerSettingsEqual(
				{ showWaveform: true, enableMarkers: true, skipSeconds: 10 },
				{ showWaveform: true, enableMarkers: true, skipSeconds: 30 },
			),
		).toBe(false);
	});
});
