/**
 * Tests the per-engine transcription settings. One renderer serves all three
 * cloud engines by reading the selected engine's descriptor, so the risk it
 * carries is a field bound to the wrong settings property: an endpoint or key
 * typed for Deepgram landing in the Whisper fields fails at request time with
 * an authentication error that points nowhere near the cause.
 * @module tests/unit/transcriptionEngineSection.test
 */

import {
	renderCloudEngineSettings,
	renderLocalWhisperSettings,
	renderWhisperChunkSize,
} from 'src/settings/sections/transcriptionEngineSection';
import { selectedTranscriptionEngine } from 'src/transcription/providers/engines';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { defined } from '../helpers/assertions';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from 'src/settings/settingsSchema';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import {
	capturedSettings,
	changeSetting,
	enterNumberSetting,
	isSettingDisabled,
	settingRow,
} from '../helpers/captureSettings';

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

/** Renders the cloud fields for an engine and returns its settings. */
function renderCloud(provider: TranscriptionProviderId): AudioRecorderSettings {
	const settings = mergeSettings({ transcriptionProvider: provider });
	const credentials = defined(
		selectedTranscriptionEngine(settings).credentials,
		`credentials for ${provider}`,
	);
	renderCloudEngineSettings(makeCtx(settings), credentials);
	return settings;
}

describe('renderCloudEngineSettings', () => {
	it.each([
		[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, 'whisperApiKey'],
		[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, 'deepgramApiKey'],
		[TRANSCRIPTION_PROVIDER_IDS.GEMINI, 'geminiApiKey'],
	] as const)(
		'binds the key field of %s to its own settings property',
		(provider, property) => {
			// Everything else about a cloud engine is declared; this block is
			// the one row no control type covers, the password field.
			const settings = renderCloud(provider);
			const credentials = defined(
				selectedTranscriptionEngine(settings).credentials,
			);

			changeSetting(credentials.keyFieldName, 'text', 'token-value');

			expect(settings[property]).toBe('token-value');
		},
	);

	it('renders only that one row', () => {
		renderCloud(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM);

		expect(capturedSettings).toHaveLength(1);
	});

	it('gives each engine its own key label rather than a generic one', () => {
		const labels = new Set<string>();
		for (const provider of [
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			TRANSCRIPTION_PROVIDER_IDS.GEMINI,
		]) {
			renderCloud(provider);
			labels.add(capturedSettings[0]?.name ?? '');
		}

		expect(labels.size).toBe(3);
	});
});

describe('renderWhisperChunkSize', () => {
	it('stores a chunk size the user enters', () => {
		const settings = mergeSettings({ transcriptionChunkMb: 20 });
		renderWhisperChunkSize(makeCtx(settings));

		enterNumberSetting('Upload chunk size', '10');

		expect(settings.transcriptionChunkMb).toBe(10);
	});

	it('clamps a chunk size above the API limit instead of rejecting it', () => {
		const settings = mergeSettings({ transcriptionChunkMb: 20 });
		renderWhisperChunkSize(makeCtx(settings));

		enterNumberSetting('Upload chunk size', '999');

		// Storing 999 MB would produce chunks every request rejects; the field
		// bounds it to what the API actually accepts.
		expect(settings.transcriptionChunkMb).toBeLessThanOrEqual(25);
		expect(settings.transcriptionChunkMb).toBeGreaterThan(0);
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
	beforeEach(() => {
		const obsidian = jest.requireMock<{
			Platform: { isMobile: boolean; isMobileApp: boolean };
		}>('obsidian');
		obsidian.Platform.isMobile = true;
		obsidian.Platform.isMobileApp = true;
	});

	afterEach(() => {
		const obsidian = jest.requireMock<{
			Platform: { isMobile: boolean; isMobileApp: boolean };
		}>('obsidian');
		obsidian.Platform.isMobile = false;
		obsidian.Platform.isMobileApp = false;
	});

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
