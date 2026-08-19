/**
 * Type tests for the settings round-trip.
 *
 * These assert at compile time, not at run time: `npm run typecheck` covers
 * tests/, so a signature that drifts fails the build even though every runtime
 * test still passes. That matters most here, because the serialized shape is
 * what lands in data.json - a field that quietly becomes optional, or a
 * platform-scoped field that leaks back into the flat runtime type, is a
 * change to a file format users already have on disk.
 * @module tests/unit/settingsSerialization.types.test
 */

import { expectTypeOf } from 'expect-type';
import {
	mergeSettings,
	mergeSettingsAsync,
	serializeSettings,
	serializeTrackAudioSources,
} from 'src/settings/settingsSerialization';
import type {
	AudioRecorderSettings,
	AudioRecorderSettingsInput,
	SerializedAudioRecorderSettings,
	SerializedAudioSource,
} from 'src/settings/settingsSchema';
import type { PlatformKind } from 'src/platform/platformKind';

describe('mergeSettings', () => {
	it('accepts a partial input and answers a complete settings object', () => {
		// Callers pass whatever data.json held, which is any subset; what
		// comes back has to be complete or every reader needs its own default.
		expectTypeOf(mergeSettings)
			.parameter(0)
			.toEqualTypeOf<AudioRecorderSettingsInput | undefined>();
		expectTypeOf(
			mergeSettings,
		).returns.toEqualTypeOf<AudioRecorderSettings>();

		expect(mergeSettings({}).recordingFormat).toBeDefined();
	});

	it('takes the platform to resolve for, and defaults it', () => {
		// A test, and the settings tab on a synced config, both need to merge
		// for a platform other than the one running.
		expectTypeOf(mergeSettings)
			.parameter(1)
			.toEqualTypeOf<PlatformKind | undefined>();

		expect(mergeSettings({}, 'mobile')).toBeDefined();
	});

	it('answers a promise of the same complete object when async', () => {
		expectTypeOf(
			mergeSettingsAsync,
		).returns.resolves.toEqualTypeOf<AudioRecorderSettings>();

		expect(mergeSettingsAsync).toBeInstanceOf(Function);
	});
});

describe('serializeSettings', () => {
	it('answers the stored shape, not the runtime one', () => {
		// The two differ deliberately: the runtime object carries the active
		// platform's device and channels flat, and the stored one carries
		// every platform's branch. Collapsing them would write one device
		// into both branches on the next save.
		expectTypeOf(serializeSettings)
			.parameter(0)
			.toEqualTypeOf<AudioRecorderSettings>();
		expectTypeOf(
			serializeSettings,
		).returns.toEqualTypeOf<SerializedAudioRecorderSettings>();

		expect(serializeSettings(mergeSettings({}))).toBeDefined();
	});

	it('drops the flat platform-scoped fields from what it stores', () => {
		expectTypeOf<SerializedAudioRecorderSettings>().not.toHaveProperty(
			'audioDeviceId',
		);
		expectTypeOf<SerializedAudioRecorderSettings>().not.toHaveProperty(
			'trackAudioSources',
		);
		expectTypeOf<SerializedAudioRecorderSettings>().toHaveProperty(
			'perPlatform',
		);

		expect('audioDeviceId' in serializeSettings(mergeSettings({}))).toBe(
			false,
		);
	});

	it('stores the track sources as a plain record, not a Map', () => {
		// JSON has no Map; the runtime side keeps one because the settings
		// tab edits it in place.
		expectTypeOf(serializeTrackAudioSources).returns.toEqualTypeOf<
			Record<number, SerializedAudioSource>
		>();

		expect(serializeTrackAudioSources(new Map())).toEqual({});
	});
});

describe('the round trip', () => {
	it('takes back everything it wrote', () => {
		// serialize -> merge is the load path after every save, so what the
		// one produces has to be assignable to what the other accepts.
		expectTypeOf<SerializedAudioRecorderSettings>().toExtend<AudioRecorderSettingsInput>();

		expect(
			mergeSettings(serializeSettings(mergeSettings({}))).recordingFormat,
		).toBe(mergeSettings({}).recordingFormat);
	});
});
