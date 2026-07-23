/**
 * Regression tests for the wiring in renderTranscriptionSection: the three
 * speaker-related output controls (Include speakers, Merge speaker turns,
 * Speaker format) must be disabled exactly when diarization is not in effect
 * - the engine cannot diarize, or a capable engine has the toggle off. The
 * shared capturing Setting mock runs each builder callback, so the per-row
 * disabled state can be checked by name, catching a future refactor that
 * drops the disabled flag on any of these controls.
 * @module tests/unit/transcriptionSettingsSection.test
 */

import { renderTranscriptionSection } from 'src/settings/sections/transcriptionSettingsSection';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import {
	capturedSettings,
	isSettingDisabled,
} from '../helpers/captureSettings';

jest.mock('obsidian', () => ({
	Platform: { isMobile: false, isMobileApp: false },
	Setting: jest.requireActual<typeof import('../helpers/captureSettings')>(
		'../helpers/captureSettings',
	).CapturingSetting,
}));

/** Builds a section context whose hooks are spies. */
function makeCtx(settings: AudioRecorderSettings): SettingsSectionContext {
	return {
		containerEl: document.createElement('div'),
		settings,
		save: jest.fn().mockResolvedValue(undefined),
		rerender: jest.fn(),
		saveDebounced: jest.fn(),
	};
}

/** Renders the section for an engine/diarization combo. */
function renderFor(provider: TranscriptionProviderId, diarize: boolean): void {
	capturedSettings.length = 0;
	renderTranscriptionSection(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider,
				transcriptionDiarize: diarize,
			}),
		),
	);
}

/** The speaker-related output controls gated on effective diarization. */
const SPEAKER_ROWS = [
	'Include speakers',
	'Merge speaker turns',
	'Speaker format',
];

describe('renderTranscriptionSection speaker control gating', () => {
	it('disables the speaker controls for an engine that cannot diarize', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, true);
		for (const name of SPEAKER_ROWS) {
			expect(isSettingDisabled(name)).toBe(true);
		}
		// The diarization toggle itself is disabled for such an engine.
		expect(isSettingDisabled('Speaker diarization')).toBe(true);
	});

	it('disables the speaker controls when a capable engine has diarization off', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, false);
		for (const name of SPEAKER_ROWS) {
			expect(isSettingDisabled(name)).toBe(true);
		}
	});

	it('enables the speaker controls when diarization is in effect', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, true);
		for (const name of SPEAKER_ROWS) {
			expect(isSettingDisabled(name)).toBe(false);
		}
		expect(isSettingDisabled('Speaker diarization')).toBe(false);
	});
});

/** Renders the section for an engine with a seeded profile list. */
function renderWithProfiles(
	provider: TranscriptionProviderId,
	profiles: { id: string; name: string; terms: string }[],
	selectedId: string,
): void {
	capturedSettings.length = 0;
	renderTranscriptionSection(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: selectedId,
			}),
		),
	);
}

describe('renderTranscriptionSection dictionary profiles', () => {
	it('renders the profiles heading and selector for every engine', () => {
		for (const provider of Object.values(TRANSCRIPTION_PROVIDER_IDS)) {
			renderFor(provider, false);
			const names = capturedSettings.map((setting) => setting.name);
			expect(names).toContain('Dictionary profiles');
			expect(names).toContain('Profile');
		}
	});

	it('renders no terms editor when there are no profiles', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, false);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).not.toContain('Terms');
	});

	it('opens the selected profile in an engine-independent editor', () => {
		// Whisper API can bias, but even so the editor is never disabled by
		// engine: a profile is just stored text, gated at transcription time.
		renderWithProfiles(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			[
				{ id: 'a', name: 'Standup', terms: 'gRPC' },
				{ id: 'b', name: 'Legal', terms: 'affidavit' },
			],
			'a',
		);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).toContain('Profile name');
		expect(names).toContain('Terms');
		expect(isSettingDisabled('Terms')).toBe(false);
		const selector = capturedSettings.find(
			(setting) => setting.name === 'Profile',
		);
		expect(
			selector?.dropdownOptions?.map((option) => option.value),
		).toEqual(['a', 'b']);
	});
});

/** Renders the section with the advanced two-pass mode on or off. */
function renderAdvanced(enabled: boolean): void {
	capturedSettings.length = 0;
	renderTranscriptionSection(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionAdvancedEnabled: enabled,
			}),
		),
	);
}

describe('renderTranscriptionSection advanced two-pass mode', () => {
	const TOGGLE = 'Advanced two-pass transcription (experimental)';

	it('renders the master toggle off by default with an explicit cost warning', () => {
		renderAdvanced(false);
		const row = capturedSettings.find((setting) => setting.name === TOGGLE);
		expect(row).toBeDefined();
		expect(row?.toggle?.value).toBe(false);
		// The trade-off must be spelled out in the description: two engine
		// passes plus LLM calls.
		expect(row?.desc).toContain('2x the engine cost');
		expect(row?.desc).toContain('LLM calls');
	});

	it('hides the advanced sub-fields while the mode is off', () => {
		renderAdvanced(false);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).not.toContain('Domain glossary');
		expect(names).not.toContain('Second-pass length safeguard');
	});

	it('reveals the glossary and length safeguard when the mode is on', () => {
		renderAdvanced(true);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).toContain('Domain glossary');
		expect(names).toContain('Second-pass length safeguard');
		const row = capturedSettings.find((setting) => setting.name === TOGGLE);
		expect(row?.toggle?.value).toBe(true);
	});

	it('shows the LLM provider fields when only the advanced mode needs them', () => {
		capturedSettings.length = 0;
		renderTranscriptionSection(
			makeCtx(
				mergeSettings({
					transcriptionEnabled: true,
					transcriptionAdvancedEnabled: true,
					llmPostProcessEnabled: false,
					transcriptionAutoChaptersEnabled: false,
				}),
			),
		);
		const names = capturedSettings.map((setting) => setting.name);
		// The agents run on the configured LLM provider, so its fields must
		// be reachable while the mode is on even with post-processing off.
		expect(names).toContain('LLM provider');
	});
});

describe('renderTranscriptionSection platform gating', () => {
	const { Platform } = jest.requireMock<{
		Platform: { isMobile: boolean; isMobileApp: boolean };
	}>('obsidian');

	afterEach(() => {
		Platform.isMobile = false;
		Platform.isMobileApp = false;
	});

	/** The rendered engine dropdown's option list. */
	function engineOptions(): { value: string; disabled: boolean }[] {
		const row = capturedSettings.find(
			(setting) => setting.name === 'Engine',
		);
		expect(row).toBeDefined();
		return row?.dropdownOptions ?? [];
	}

	it('offers every engine on desktop', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, false);
		for (const option of engineOptions()) {
			expect(option.disabled).toBe(false);
		}
	});

	it('blocks the local whisper.cpp engine option on mobile', () => {
		Platform.isMobile = true;
		renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, false);
		const options = new Map(
			engineOptions().map((option) => [option.value, option.disabled]),
		);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER)).toBe(
			true,
		);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API)).toBe(false);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM)).toBe(false);
		expect(options.get(TRANSCRIPTION_PROVIDER_IDS.GEMINI)).toBe(false);
	});

	it('blocks the local whisper.cpp path fields on mobile when selected', () => {
		// A synced desktop config may arrive with local whisper selected:
		// its fields stay visible but read as unavailable.
		Platform.isMobile = true;
		renderFor(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER, false);
		expect(isSettingDisabled('whisper.cpp binary path')).toBe(true);
		expect(isSettingDisabled('Model path')).toBe(true);
		expect(isSettingDisabled('Extra arguments')).toBe(true);
	});

	it('keeps the local whisper.cpp path fields editable on desktop', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER, false);
		expect(isSettingDisabled('whisper.cpp binary path')).toBe(false);
		expect(isSettingDisabled('Model path')).toBe(false);
		expect(isSettingDisabled('Extra arguments')).toBe(false);
	});
});
