/**
 * Tests the provider fields no control type covers. One renderer serves every
 * provider by reading its connection, so the risk it carries is a field bound
 * to the wrong settings property: a key typed for Deepgram landing in the
 * Whisper field fails at request time with an authentication error that points
 * nowhere near the cause.
 * @module tests/unit/transcriptionEngineSection.test
 */

import {
	renderLocalWhisperSettings,
	renderProviderKeyField,
} from 'src/settings/sections/transcriptionEngineSection';
import { ACCOUNTS, ENGINES, ENGINE_IDS } from 'src/providers/providers';
import type { EngineId } from 'src/providers/providers';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { defined } from '../helpers/assertions';
import type { AudioRecorderSettings } from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
	isSettingDisabled,
	settingRow,
} from '../helpers/captureSettings';
import { useMobilePlatform } from '../helpers/platform';

jest.mock('obsidian', () => ({
	Platform: { isMobile: false, isMobileApp: false },
	Setting: jest.requireActual<typeof import('../helpers/captureSettings')>(
		'../helpers/captureSettings',
	).CapturingSetting,
}));

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

/** Renders one provider's key field and returns the settings behind it. */
function renderKey(engine: EngineId): AudioRecorderSettings {
	const settings = mergeSettings({});
	renderProviderKeyField(makeCtx(settings), ENGINES[engine]);
	return settings;
}

describe('renderProviderKeyField', () => {
	it.each([
		[ENGINE_IDS.WHISPER_API, 'whisperApiKey'],
		[ENGINE_IDS.DEEPGRAM, 'deepgramApiKey'],
		[ENGINE_IDS.GEMINI, 'geminiApiKey'],
		[ENGINE_IDS.ANTHROPIC, 'anthropicApiKey'],
	] as const)(
		'binds the key field of %s to its own settings property',
		(provider, property) => {
			// Everything else about a provider is declared; this block is the
			// one row no control type covers, the password field.
			const settings = renderKey(provider);
			const connection = defined(
				ACCOUNTS[defined(ENGINES[provider].account)],
			);

			changeSetting(connection.keyFieldName, 'text', 'token-value');

			expect(settings[property]).toBe('token-value');
		},
	);

	it('renders only that one row', () => {
		renderKey(ENGINE_IDS.DEEPGRAM);

		expect(capturedSettings).toHaveLength(1);
	});

	it('gives each provider its own key label rather than a generic one', () => {
		const labels = new Set<string>();
		for (const provider of [
			ENGINE_IDS.WHISPER_API,
			ENGINE_IDS.DEEPGRAM,
			ENGINE_IDS.GEMINI,
		]) {
			renderKey(provider);
			labels.add(capturedSettings[0]?.name ?? '');
		}

		expect(labels.size).toBe(3);
	});
});

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
