/**
 * Tests the provider fields no control type covers: the local whisper.cpp
 * paths, where the risk is a field bound to the wrong settings property.
 * @module tests/unit/transcriptionEngineSection.test
 */

import { renderLocalWhisperSettings } from 'src/settings/sections/transcriptionEngineSection';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
	isSettingDisabled,
	settingRow,
} from '../helpers/captureSettings';
import { useMobilePlatform } from '../helpers/platform';

// The full obsidian mock with only Setting swapped for the recording double,
// so this file sees the same Notice, Platform, and DOM helpers as every other.
jest.mock('obsidian', () =>
	require('../mocks/modules/obsidianWithCapturingSetting'),
);

/** Builds a section context over the given settings. */
function makeCtx(settings: AudioRecorderSettings): SettingsSectionContext {
	capturedSettings.length = 0;
	return {
		containerEl: document.createElement('div'),
		settings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
}

describe('renderLocalWhisperSettings', () => {
	it('binds the three local file-path fields', () => {
		const settings = mergeSettings({});
		renderLocalWhisperSettings(makeCtx(settings));

		changeSetting('whisper.cpp binary path', 'text', '/usr/bin/whisper');
		changeSetting('Model path', 'text', '/models/ggml-base.bin');
		changeSetting('Extra arguments', 'text', '--threads 4');

		expect(settings.localWhisperBinaryPath).toBe('/usr/bin/whisper');
		expect(settings.localWhisperModelPath).toBe('/models/ggml-base.bin');
		expect(settings.localWhisperExtraArgs).toBe('--threads 4');
	});

	it('leaves the fields editable on a platform that can run whisper.cpp', () => {
		renderLocalWhisperSettings(makeCtx(mergeSettings({})));

		expect(isSettingDisabled('whisper.cpp binary path')).toBe(false);
		expect(settingRow('whisper.cpp binary path').desc).not.toContain(
			'not available on this device',
		);
	});
});

describe('renderLocalWhisperSettings on mobile', () => {
	beforeEach(useMobilePlatform);

	it('blocks the fields and says why, rather than hiding them', () => {
		renderLocalWhisperSettings(makeCtx(mergeSettings({})));

		for (const name of [
			'whisper.cpp binary path',
			'Model path',
			'Extra arguments',
		]) {
			expect(isSettingDisabled(name)).toBe(true);
		}
		// A synced desktop selection lands here; the user needs to see why
		// transcription will not run, not an empty section.
		expect(settingRow('whisper.cpp binary path').desc).toContain(
			'not available on this device',
		);
	});
});
