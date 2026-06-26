/**
 * Regression tests for the wiring in renderTranscriptionSection: the three
 * speaker-related output controls (Include speakers, Merge speaker turns,
 * Speaker format) must be disabled exactly when diarization is not in effect
 * — the engine cannot diarize, or a capable engine has the toggle off. The
 * Obsidian Setting is mocked so each builder callback runs and the per-row
 * disabled state is captured by name, catching a future refactor that drops
 * the disabled flag on any of these controls.
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

/** One rendered setting row captured through the Setting mock. */
interface RowCapture {
	name: string;
	disabled: boolean;
}
const captured: RowCapture[] = [];

jest.mock('obsidian', () => ({
	Setting: class {
		settingEl: HTMLElement;
		descEl: { createEl: () => unknown };
		private cap: RowCapture;
		constructor() {
			const el = document.createElement('div');
			(el as unknown as { addClass: (c: string) => void }).addClass = (
				c,
			) => el.classList.add(c);
			this.settingEl = el;
			this.descEl = { createEl: () => ({}) };
			this.cap = { name: '', disabled: false };
			captured.push(this.cap);
		}
		setName(name: string): this {
			this.cap.name = name;
			return this;
		}
		setDesc(): this {
			return this;
		}
		setHeading(): this {
			return this;
		}
		addToggle(callback: (toggle: unknown) => void): this {
			const cap = this.cap;
			const toggle = {
				setValue() {
					return this;
				},
				onChange() {
					return this;
				},
				setDisabled(d: boolean) {
					if (d) {
						cap.disabled = true;
					}
					return this;
				},
			};
			callback(toggle);
			return this;
		}
		addText(callback: (text: unknown) => void): this {
			const cap = this.cap;
			const text = {
				inputEl: { type: 'text' },
				setPlaceholder() {
					return this;
				},
				setValue() {
					return this;
				},
				onChange() {
					return this;
				},
				setDisabled(d: boolean) {
					if (d) {
						cap.disabled = true;
					}
					return this;
				},
			};
			callback(text);
			return this;
		}
		addDropdown(callback: (dropdown: unknown) => void): this {
			const dropdown = {
				addOption() {
					return this;
				},
				setValue() {
					return this;
				},
				onChange() {
					return this;
				},
			};
			callback(dropdown);
			return this;
		}
		addSlider(callback: (slider: unknown) => void): this {
			const slider = {
				setLimits() {
					return this;
				},
				setValue() {
					return this;
				},
				setDynamicTooltip() {
					return this;
				},
				onChange() {
					return this;
				},
			};
			callback(slider);
			return this;
		}
		addButton(callback: (button: unknown) => void): this {
			const button = {
				setButtonText() {
					return this;
				},
				setDisabled() {
					return this;
				},
				onClick() {
					return this;
				},
			};
			callback(button);
			return this;
		}
	},
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

/** Renders the section for an engine/diarization combo and returns the rows. */
function renderFor(
	provider: TranscriptionProviderId,
	diarize: boolean,
): RowCapture[] {
	captured.length = 0;
	renderTranscriptionSection(
		makeCtx(
			mergeSettings({
				transcriptionEnabled: true,
				transcriptionProvider: provider,
				transcriptionDiarize: diarize,
			}),
		),
	);
	return captured;
}

/** The speaker-related output controls gated on effective diarization. */
const SPEAKER_ROWS = [
	'Include speakers',
	'Merge speaker turns',
	'Speaker format',
];

function rowDisabled(rows: RowCapture[], name: string): boolean {
	const row = rows.find((r) => r.name === name);
	if (!row) {
		throw new Error(`Setting row not rendered: ${name}`);
	}
	return row.disabled;
}

describe('renderTranscriptionSection speaker control gating', () => {
	it('disables the speaker controls for an engine that cannot diarize', () => {
		const rows = renderFor(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API, true);
		for (const name of SPEAKER_ROWS) {
			expect(rowDisabled(rows, name)).toBe(true);
		}
		// The diarization toggle itself is disabled for such an engine.
		expect(rowDisabled(rows, 'Speaker diarization')).toBe(true);
	});

	it('disables the speaker controls when a capable engine has diarization off', () => {
		const rows = renderFor(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, false);
		for (const name of SPEAKER_ROWS) {
			expect(rowDisabled(rows, name)).toBe(true);
		}
	});

	it('enables the speaker controls when diarization is in effect', () => {
		const rows = renderFor(TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM, true);
		for (const name of SPEAKER_ROWS) {
			expect(rowDisabled(rows, name)).toBe(false);
		}
		expect(rowDisabled(rows, 'Speaker diarization')).toBe(false);
	});
});
