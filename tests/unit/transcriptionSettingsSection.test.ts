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
/** @jest-environment jsdom */

import { renderTranscriptionSection } from '../../src/settings/sections/transcriptionSettingsSection';
import {
	mergeSettings,
	type AudioRecorderSettings,
	type TranscriptionProviderId,
} from '../../src/settings/Settings';
import type { SettingsSectionContext } from '../../src/settings/settingControls';
import { TRANSCRIPTION_PROVIDER_IDS } from '../../src/constants';
import {
	capturedSettings,
	isSettingDisabled,
} from '../helpers/captureSettings';

jest.mock('obsidian', () => ({
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
