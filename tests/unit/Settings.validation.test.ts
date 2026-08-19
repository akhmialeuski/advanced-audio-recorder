/**
 * Tests for Settings validation functions.
 * @module tests/unit/Settings.validation.test
 */

import {
	type AudioRecorderSettings,
	DEFAULT_SETTINGS,
} from 'src/settings/settingsSchema';
import { validateSettings } from 'src/settings/settingsValidation';
import { SettingsValidationError } from 'src/errors';

/**
 * Settings that pass validation, so a case only has to state what it breaks.
 * @param patch - Fields this case changes
 * @returns A complete settings object
 */
function settingsWith(
	patch: Partial<AudioRecorderSettings>,
): AudioRecorderSettings {
	return { ...DEFAULT_SETTINGS, audioDeviceId: 'valid-device', ...patch };
}

describe('validateSettings rejections', () => {
	it.each([
		{
			name: 'an unselected audio device',
			patch: { audioDeviceId: '' },
			reason: /Audio device is not selected/,
		},
		{
			name: 'an audio device of only whitespace',
			patch: { audioDeviceId: '   ' },
			reason: /Audio device is not selected/,
		},
		{
			name: 'a zero sample rate',
			patch: { sampleRate: 0 },
			reason: /Sample rate must be a positive number/,
		},
		{
			name: 'a negative sample rate',
			patch: { sampleRate: -44100 },
			reason: /Sample rate must be a positive number/,
		},
		{
			name: 'a non-finite sample rate',
			patch: { sampleRate: Number.NaN },
			reason: /Sample rate must be a positive number/,
		},
		{
			// Infinity is positive and greater than zero, so a bare `> 0`
			// check would let it through and hand the recorder a rate no
			// device can honour.
			name: 'an infinite sample rate',
			patch: { sampleRate: Number.POSITIVE_INFINITY },
			reason: /Sample rate must be a positive number/,
		},
		{
			name: 'an unselected recording format',
			patch: { recordingFormat: '' },
			reason: /Recording format is not selected/,
		},
		{
			name: 'multi-track with no sources configured',
			patch: { enableMultiTrack: true, trackAudioSources: new Map() },
			reason: /no audio sources are selected/,
		},
		{
			name: 'a multi-track source with no device',
			patch: {
				enableMultiTrack: true,
				trackAudioSources: new Map([
					[1, { deviceId: 'device-1', channelMode: 'source' }],
					[2, { deviceId: '', channelMode: 'source' }],
				]),
			},
			reason: /Track 2 has no audio source selected/,
		},
		{
			name: 'a part suffix with an illegal character',
			patch: { splitPartSuffix: 'pa/rt' },
			reason: /Part suffix may contain only letters, digits, hyphens, and underscores/,
		},
		{
			name: 'an empty part suffix',
			patch: { splitPartSuffix: '' },
			reason: /Part suffix may contain only letters, digits, hyphens, and underscores/,
		},
		{
			name: 'a fractional part duration',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 2.5 },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			name: 'a zero part duration',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 0 },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			name: 'a part duration above the maximum',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 181 },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			name: 'a negative part duration',
			patch: { autoSplitEnabled: true, splitChunkMinutes: -1 },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			// Neither of these is an integer in the range, and both would
			// otherwise reach the splitter as a chunk size it cannot use.
			name: 'a part duration that is not a number',
			patch: { autoSplitEnabled: true, splitChunkMinutes: Number.NaN },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			name: 'an infinite part duration',
			patch: {
				autoSplitEnabled: true,
				splitChunkMinutes: Number.POSITIVE_INFINITY,
			},
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
		{
			name: 'a part suffix of only whitespace',
			patch: { splitPartSuffix: '   ' },
			reason: /Part suffix may contain only letters, digits, hyphens, and underscores/,
		},
		{
			// The value is also the default part duration for manual
			// splitting, so it must be valid regardless of the toggle.
			name: 'a bad part duration even with auto-split off',
			patch: { autoSplitEnabled: false, splitChunkMinutes: 0 },
			reason: /Part duration must be an integer between 1 and 180 minutes/,
		},
	] satisfies {
		name: string;
		patch: Partial<AudioRecorderSettings>;
		reason: RegExp;
	}[])('rejects $name', ({ patch, reason }) => {
		expect(() => validateSettings(settingsWith(patch))).toThrow(
			SettingsValidationError,
		);
		expect(() => validateSettings(settingsWith(patch))).toThrow(reason);
	});

	it.each([
		{
			name: 'an unselected audio device',
			patch: { audioDeviceId: '' },
			field: 'audioDeviceId',
		},
		{
			name: 'a zero sample rate',
			patch: { sampleRate: 0 },
			field: 'sampleRate',
		},
		{
			name: 'an unselected recording format',
			patch: { recordingFormat: '' },
			field: 'recordingFormat',
		},
		{
			name: 'an empty part suffix',
			patch: { splitPartSuffix: '' },
			field: 'splitPartSuffix',
		},
		{
			name: 'a bad part duration',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 0 },
			field: 'splitChunkMinutes',
		},
	] satisfies {
		name: string;
		patch: Partial<AudioRecorderSettings>;
		field: string;
	}[])('blames $field for $name', ({ patch, field }) => {
		// The field is what the settings tab uses to focus the row that needs
		// fixing, so a message alone is not enough.
		const validate = (): void => {
			validateSettings(settingsWith(patch));
		};

		expect(validate).toThrow(SettingsValidationError);
		expect(validate).toThrow(expect.objectContaining({ field }));
	});
});

describe('validateSettings acceptances', () => {
	it.each([
		{ name: 'the defaults with a device selected', patch: {} },
		{
			name: 'a one-minute part duration, the lower bound',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 1 },
		},
		{
			name: 'a 180-minute part duration, the upper bound',
			patch: { autoSplitEnabled: true, splitChunkMinutes: 180 },
		},
		{
			name: 'a part suffix of letters, digits, hyphens, and underscores',
			patch: { splitPartSuffix: 'chunk_1-a' },
		},
		{
			// One character is the shortest suffix that is not empty, and the
			// empty one is rejected above - so this is the lower bound.
			name: 'a single-character part suffix',
			patch: { splitPartSuffix: 'p' },
		},
		{
			// The smallest sample rate that is still positive: the guard
			// rejects zero and below, so anything above it must pass.
			name: 'a sample rate at the smallest positive step',
			patch: { sampleRate: Number.MIN_VALUE },
		},
		{
			name: 'multi-track with every track given a device',
			patch: {
				enableMultiTrack: true,
				trackAudioSources: new Map([
					[1, { deviceId: 'device-1', channelMode: 'source' }],
					[2, { deviceId: 'device-2', channelMode: 'source' }],
				]),
			},
		},
	] satisfies { name: string; patch: Partial<AudioRecorderSettings> }[])(
		'accepts $name',
		({ patch }) => {
			expect(() => validateSettings(settingsWith(patch))).not.toThrow();
		},
	);
});
