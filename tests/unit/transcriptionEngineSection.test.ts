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
		[
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			'whisperApiBaseUrl',
			'whisperApiKey',
		],
		[
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'deepgramBaseUrl',
			'deepgramApiKey',
		],
		[TRANSCRIPTION_PROVIDER_IDS.GEMINI, 'geminiBaseUrl', 'geminiApiKey'],
	] as const)(
		'binds the endpoint and key fields of %s to its own settings',
		(provider, urlProperty, keyProperty) => {
			const settings = renderCloud(provider);
			const credentials = defined(
				selectedTranscriptionEngine(settings).credentials,
			);

			changeSetting(
				credentials.baseUrlFieldName,
				'text',
				'https://edge.example/v1',
			);
			changeSetting(credentials.keyFieldName, 'text', 'key-typed');

			expect(settings[urlProperty]).toBe('https://edge.example/v1');
			expect(settings[keyProperty]).toBe('key-typed');
		},
	);

	it.each([
		[TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, 'whisperApiModel'],
		[TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, 'deepgramModel'],
		[TRANSCRIPTION_PROVIDER_IDS.GEMINI, 'geminiModel'],
	] as const)('shows the model of %s in its picker', (provider, property) => {
		const settings = renderCloud(provider);
		const credentials = defined(
			selectedTranscriptionEngine(settings).credentials,
		);

		expect(settingRow(credentials.modelPickerName).dropdownValue).toBe(
			settings[property],
		);
	});

	it('gives each engine its own labels rather than a generic one', () => {
		renderCloud(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM);
		const deepgramRows = capturedSettings.map((row) => row.name);

		renderCloud(TRANSCRIPTION_PROVIDER_IDS.GEMINI);
		const geminiRows = capturedSettings.map((row) => row.name);

		// Same shape, different copy: the vendor-specific rows share no label,
		// so a user switching engines can tell which vendor a key belongs to.
		// (The model picker's own "Add custom model" row is generic by design.)
		expect(deepgramRows).toHaveLength(geminiRows.length);
		expect(
			deepgramRows.filter((name) => geminiRows.includes(name)),
		).toEqual(['Add custom model']);
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
