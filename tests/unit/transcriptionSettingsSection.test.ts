/**
 * Regression tests for the wiring in renderTranscriptionRemainder: the three
 * speaker-related output controls (Include speakers, Merge speaker turns,
 * Speaker format) must be disabled exactly when diarization is not in effect
 * - the engine cannot diarize, or a capable engine has the toggle off. The
 * shared capturing Setting mock runs each builder callback, so the per-row
 * disabled state can be checked by name, catching a future refactor that
 * drops the disabled flag on any of these controls.
 * @module tests/unit/transcriptionSettingsSection.test
 */

import { renderTranscriptionRemainder } from 'src/settings/sections/transcriptionSettingsSection';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from 'src/settings/settingsSchema';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { SettingsSectionContext } from 'src/settings/settingControls';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import {
	capturedSettings,
	changeSetting,
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
	renderTranscriptionRemainder(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider,
				transcriptionDiarize: diarize,
				// The dictionary lives under the advanced master switch, so it is
				// on here for the dictionary-profile assertions to reach it.
				transcriptionAdvancedSettingsEnabled: true,
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

describe('renderTranscriptionRemainder speaker control gating', () => {
	it('disables the speaker controls for an engine that cannot diarize', () => {
		renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, true);
		for (const name of SPEAKER_ROWS) {
			expect(isSettingDisabled(name)).toBe(true);
		}
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
	});
});

/** Renders the section for an engine with a seeded profile list. */
function renderWithProfiles(
	provider: TranscriptionProviderId,
	profiles: { id: string; name: string; terms: string }[],
	selectedId: string,
): void {
	capturedSettings.length = 0;
	renderTranscriptionRemainder(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider,
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionDictionaryProfiles: profiles,
				transcriptionDictionaryProfileId: selectedId,
			}),
		),
	);
}

describe('renderTranscriptionRemainder dictionary profiles', () => {
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

/** Renders the section with the advanced master on and two-pass on or off. */
function renderAdvanced(twoPass: boolean): void {
	capturedSettings.length = 0;
	renderTranscriptionRemainder(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionAdvancedEnabled: twoPass,
			}),
		),
	);
}

/** Renders the section with the advanced master switch off (a plain run). */
function renderPlain(): void {
	capturedSettings.length = 0;
	renderTranscriptionRemainder(
		makeCtx(mergeSettings({ transcriptionEnabled: true })),
	);
}

describe('renderTranscriptionRemainder advanced master switch', () => {
	const MASTER = 'Advanced settings';
	const TWO_PASS = 'Advanced two-pass transcription (experimental)';

	it('renders the master switch off by default', () => {
		renderPlain();
		const row = capturedSettings.find((setting) => setting.name === MASTER);
		expect(row).toBeDefined();
		expect(row?.toggle?.value).toBe(false);
	});

	it('hides the dictionary and two-pass while the master is off', () => {
		renderPlain();
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).not.toContain('Dictionary profiles');
		expect(names).not.toContain(TWO_PASS);
		expect(names).not.toContain('Second-pass length safeguard');
	});

	it('reveals the dictionary and the two-pass toggle when the master is on', () => {
		renderAdvanced(false);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).toContain('Dictionary profiles');
		expect(names).toContain(TWO_PASS);
		// Two-pass itself is still off, so its safeguard stays hidden.
		expect(names).not.toContain('Second-pass length safeguard');
	});
});

describe('renderTranscriptionRemainder advanced two-pass mode', () => {
	const TOGGLE = 'Advanced two-pass transcription (experimental)';

	it('renders the two-pass toggle off by default with an explicit cost warning', () => {
		renderAdvanced(false);
		const row = capturedSettings.find((setting) => setting.name === TOGGLE);
		expect(row).toBeDefined();
		expect(row?.toggle?.value).toBe(false);
		// The trade-off must be spelled out in the description: two engine
		// passes plus LLM calls.
		expect(row?.desc).toContain('2x the engine cost');
		expect(row?.desc).toContain('LLM calls');
		// It reuses the dictionary terms above, not a second glossary, so the
		// description ties it to the Dictionary.
		expect(row?.desc).toContain('Dictionary');
	});

	it('hides the length safeguard while the two-pass mode is off', () => {
		renderAdvanced(false);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).not.toContain('Second-pass length safeguard');
		// The mode reuses the Dictionary terms, so there is no separate glossary
		// field to reveal.
		expect(names).not.toContain('Domain glossary');
	});

	it('reveals only the length safeguard when the two-pass mode is on', () => {
		renderAdvanced(true);
		const names = capturedSettings.map((setting) => setting.name);
		expect(names).toContain('Second-pass length safeguard');
		// No separate glossary: the advanced mode reuses the Dictionary terms.
		expect(names).not.toContain('Domain glossary');
		const row = capturedSettings.find((setting) => setting.name === TOGGLE);
		expect(row?.toggle?.value).toBe(true);
	});

	it('shows the LLM provider fields when only the advanced mode needs them', () => {
		capturedSettings.length = 0;
		renderTranscriptionRemainder(
			makeCtx(
				mergeSettings({
					transcriptionEnabled: true,
					transcriptionAdvancedSettingsEnabled: true,
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

describe('renderTranscriptionRemainder platform gating', () => {
	const { Platform } = jest.requireMock<{
		Platform: { isMobile: boolean; isMobileApp: boolean };
	}>('obsidian');

	afterEach(() => {
		Platform.isMobile = false;
		Platform.isMobileApp = false;
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

/** Renders the section over the given settings and returns them plus hooks. */
function renderWith(overrides: Partial<AudioRecorderSettings>): {
	settings: AudioRecorderSettings;
	ctx: SettingsSectionContext;
} {
	capturedSettings.length = 0;
	const settings = mergeSettings({
		transcriptionEnabled: true,
		...overrides,
	});
	const ctx = makeCtx(settings);
	renderTranscriptionRemainder(ctx);
	return { settings, ctx };
}

/** Names of the rows rendered by the last renderWith(). */
function renderedRows(): string[] {
	return capturedSettings.map((row) => row.name);
}

describe('renderTranscriptionRemainder reveals', () => {
	it('renders nothing while transcription is off', () => {
		// The section's own switch is a definition; everything this renders
		// hangs off it, so an off switch leaves no rows behind.
		renderWith({ transcriptionEnabled: false });

		expect(renderedRows()).toEqual([]);
	});

	it('keeps the advanced sub-sections hidden behind their master switch', () => {
		renderWith({ transcriptionAdvancedSettingsEnabled: false });

		const rows = renderedRows();
		expect(rows).toContain('Advanced settings');
		// A plain run needs no term biasing, so neither the dictionary nor the
		// two-pass mode is on screen to configure.
		expect(rows).not.toContain('Dictionary profiles');
		expect(rows).not.toContain(
			'Advanced two-pass transcription (experimental)',
		);
	});

	it('reveals the two-pass safeguard only while the mode is on', () => {
		renderWith({
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: false,
		});
		expect(renderedRows()).not.toContain('Second-pass length safeguard');

		renderWith({
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		});
		expect(renderedRows()).toContain('Second-pass length safeguard');
	});

	it('reveals the chapter sub-toggle and profiles only with the feature on', () => {
		renderWith({ transcriptionAutoChaptersEnabled: false });
		expect(renderedRows()).not.toContain('Generate after transcription');

		renderWith({ transcriptionAutoChaptersEnabled: true });
		const rows = renderedRows();
		expect(rows).toContain('Generate after transcription');
		expect(rows).toContain('Chapter guidance profiles');
	});

	it('offers the sidecar format only when a file is actually written', () => {
		renderWith({ transcriptDestination: 'note' });
		expect(renderedRows()).not.toContain('File format');

		for (const destination of ['file', 'both', 'link'] as const) {
			renderWith({ transcriptDestination: destination });
			expect(renderedRows()).toContain('File format');
		}
	});
});

describe('renderTranscriptionRemainder edits', () => {
	it.each([
		['Timestamp format', 'transcriptTimestampFormat', '{time}'],
		['Speaker format', 'transcriptSpeakerFormat', '**{speaker}**'],
		['Line format', 'transcriptLineFormat', '{timestamp} {speaker} {text}'],
	] as const)(
		'restores the default %s when the field is cleared',
		(row, property, fallback) => {
			const { settings } = renderWith({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				transcriptionDiarize: true,
			});

			changeSetting(row, 'text', '');

			// An empty template would render every line as nothing at all.
			expect(settings[property]).toBe(fallback);
		},
	);
});
