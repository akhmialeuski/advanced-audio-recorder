/**
 * Unit tests for the tab's definition tree: what each migrated section declares,
 * and how the row hosting the not-yet-migrated sections behaves under the
 * framework that owns it.
 * @module tests/unit/settingsDefinitions.test
 */

import { Platform } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import {
	groupOf,
	renderDefinitionOf,
	renderThroughFramework,
	rowOf,
	type GroupDefinition,
	type RenderDefinition,
} from '../helpers/declarativeSettings';
import {
	DEFAULT_SETTINGS,
	type AudioRecorderSettings,
} from 'src/settings/settingsSchema';
import {
	CLEANUP_HIGHPASS_STEP_HZ,
	MAX_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_HIGHPASS_HZ,
	TRANSCRIPTION_PROVIDER_IDS,
} from 'src/constants';
import {
	SETTINGS_BLOCK_ROW_CLASS,
	SETTINGS_ROOT_CLASS,
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	type DiagnosticsActions,
	type SettingsDefinitionContext,
} from 'src/settings/settingsDefinitions';

describe('settings definitions', () => {
	const REMAINDER_NAME = 'Advanced Audio Recorder';
	const ALIASES = ['Recording format', 'Save folder'];

	let settings: AudioRecorderSettings;
	let renderRemainder: jest.Mock;
	let renderTranscriptionRest: jest.Mock;
	let diagnostics: { [K in keyof DiagnosticsActions]: jest.Mock };

	beforeEach(() => {
		settings = { ...DEFAULT_SETTINGS };
		// Stands in for the real body with one marker element, so a test can see
		// which host it was rendered into and whether it survived.
		renderRemainder = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-body-marker' });
		});
		renderTranscriptionRest = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-transcription-rest' });
		});
		diagnostics = {
			startTestRecording: jest.fn(),
			releaseTestRecording: jest.fn(),
			showSystemInfo: jest.fn(),
		};
	});

	const createContext = (
		aliases: readonly string[] = ALIASES,
	): SettingsDefinitionContext => ({
		settings,
		remainder: {
			name: REMAINDER_NAME,
			aliases,
			render: renderRemainder as (host: HTMLElement) => void,
		},
		diagnostics: diagnostics,
		renderTranscriptionRest: renderTranscriptionRest as (
			host: HTMLElement,
		) => void,
	});

	const build = (aliases?: readonly string[]): SettingDefinitionItem[] =>
		buildSettingsDefinitions(createContext(aliases));

	/** The definition hosting the sections still rendered imperatively. */
	const remainderOf = (
		definitions: SettingDefinitionItem[],
	): RenderDefinition => renderDefinitionOf(definitions);

	/** The diagnostics group of a built tree. */
	const diagnosticsGroupOf = (
		definitions: SettingDefinitionItem[],
	): GroupDefinition => groupOf(definitions, 'Diagnostics');

	describe('the imperative remainder', () => {
		it('is named after the plugin and carries the remaining names as aliases', () => {
			const definition = remainderOf(build());

			expect(definition.name).toBe(REMAINDER_NAME);
			expect(definition.aliases).toEqual(ALIASES);
		});

		it('copies the alias list, so the tab keeps its own', () => {
			const aliases = [...ALIASES];
			const definition = remainderOf(build(aliases));

			definition.aliases?.push('Injected by the framework');

			expect(aliases).toEqual(ALIASES);
		});

		it('renders the body into the row the framework hands over', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(renderRemainder).toHaveBeenCalledWith(setting.settingEl);
			expect(
				setting.settingEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('keeps the body through the framework reset that follows a render', () => {
			// Rendering into the group's list element (or the tab container)
			// leaves the tab empty: the framework resets both to the elements it
			// tracks once every definition has rendered.
			const { containerEl } = renderThroughFramework(
				remainderOf(build()),
			);

			expect(
				containerEl.querySelector('.aar-body-marker'),
			).not.toBeNull();
		});

		it('clears the name and description the framework prefilled the row with', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(setting.settingEl.contains(setting.nameEl)).toBe(false);
			expect(setting.settingEl.contains(setting.descEl)).toBe(false);
			expect(setting.settingEl.contains(setting.controlEl)).toBe(false);
		});

		it('marks the row so the stylesheet can strip its setting-row layout', () => {
			const { setting } = renderThroughFramework(remainderOf(build()));

			expect(
				setting.settingEl.classList.contains(SETTINGS_ROOT_CLASS),
			).toBe(true);
		});

		it('replaces the body when the framework re-renders the same row', () => {
			const definition = remainderOf(build());
			const frame = renderThroughFramework(definition);

			renderThroughFramework(definition, frame);

			expect(
				frame.setting.settingEl.querySelectorAll('.aar-body-marker'),
			).toHaveLength(1);
		});
	});

	describe('the transcription section', () => {
		const TRANSCRIPTION = 'Transcription';

		/** Whether a row's visible predicate holds for the current settings. */
		const isVisible = (name: string): boolean => {
			const visible = rowOf(build(), TRANSCRIPTION, name).visible;
			return typeof visible === 'function'
				? visible()
				: visible !== false;
		};

		it('keeps every option behind the section switch', () => {
			// A predicate, not a re-render: the framework hides and shows these
			// rows in place, and the legacy renderer does the same.
			settings.transcriptionEnabled = false;

			expect(isVisible('Enable transcription')).toBe(true);
			expect(isVisible('Engine')).toBe(false);
			expect(isVisible('Language')).toBe(false);

			settings.transcriptionEnabled = true;

			expect(isVisible('Engine')).toBe(true);
			expect(isVisible('Language')).toBe(true);
		});

		it('offers the request timeout only to the engines it can bound', () => {
			// Local whisper.cpp runs no HTTP request, so there is nothing for a
			// request timeout to abort.
			settings.transcriptionEnabled = true;
			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
			expect(isVisible('Request timeout')).toBe(true);

			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER;

			expect(isVisible('Request timeout')).toBe(false);
		});

		it('lists every engine and refuses the ones this device cannot run', () => {
			// The list reads the same on every device; picking an engine this
			// one cannot run is refused with the reason, rather than silently
			// blocked or missing.
			const control = rowOf(build(), TRANSCRIPTION, 'Engine').control;

			expect(Object.keys(control?.options ?? {}).sort()).toEqual(
				Object.values(TRANSCRIPTION_PROVIDER_IDS).sort(),
			);
			const validate = control?.validate as (
				value: string,
			) => string | undefined;
			expect(
				validate(TRANSCRIPTION_PROVIDER_IDS.WHISPER_API),
			).toBeUndefined();

			Platform.isMobile = true;

			expect(validate(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER)).toBe(
				'Not available on this device.',
			);
			Platform.isMobile = false;
		});

		it('rejects a language that is not an ISO code', () => {
			const validate = rowOf(build(), TRANSCRIPTION, 'Language').control
				?.validate as (value: string) => string | undefined;

			expect(validate('en')).toBeUndefined();
			expect(validate('pt-BR')).toBeUndefined();
			expect(validate('auto')).toBeUndefined();
			// Empty means "detect", which is what the placeholder says.
			expect(validate('  ')).toBeUndefined();
			expect(validate('English please')).toBe(
				'Use an ISO code such as en or ru, or "auto".',
			);
		});

		it('keeps diarization visible but disabled on an engine without it', () => {
			settings.transcriptionEnabled = true;
			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
			const disabled = rowOf(
				build(),
				TRANSCRIPTION,
				'Speaker diarization',
			).control?.disabled;

			expect(isVisible('Speaker diarization')).toBe(true);
			expect(typeof disabled === 'function' && disabled()).toBe(true);

			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM;

			expect(typeof disabled === 'function' && disabled()).toBe(false);
		});

		it('hosts the engine fields that are not definitions yet', () => {
			settings.transcriptionEnabled = true;
			const definition = rowOf(
				build(),
				TRANSCRIPTION,
				'Transcription engine settings',
			);
			const { setting } = renderThroughFramework(
				definition as RenderDefinition,
			);

			expect(renderTranscriptionRest).toHaveBeenCalledWith(
				setting.settingEl,
			);
			expect(
				setting.settingEl.querySelector('.aar-transcription-rest'),
			).not.toBeNull();
		});
	});

	describe('the audio processing section', () => {
		it('binds every input option to its settings key', () => {
			const group = groupOf(build(), 'Audio processing & feedback');

			expect(
				group.items.map((item) => [
					item.name,
					(item as { control?: { type: string; key: string } })
						.control,
				]),
			).toEqual([
				[
					'Noise suppression',
					{ type: 'toggle', key: 'inputNoiseSuppression' },
				],
				[
					'Echo cancellation',
					{ type: 'toggle', key: 'inputEchoCancellation' },
				],
				[
					'Automatic gain control',
					{ type: 'toggle', key: 'inputAutoGainControl' },
				],
				[
					'Input level meter',
					{ type: 'toggle', key: 'showInputLevelMeter' },
				],
				[
					'Recording stats',
					{ type: 'toggle', key: 'showRecordingStats' },
				],
				[
					'Detect silent channel after recording',
					{ type: 'toggle', key: 'detectSilentChannelOnSave' },
				],
				[
					'Mobile recording banner',
					{ type: 'toggle', key: 'mobileRecordingBanner' },
				],
			]);
		});
	});

	describe('the audio cleanup defaults', () => {
		const CLEANUP = 'Audio cleanup defaults';

		it('gives each stage a switch and its number on rows of their own', () => {
			// One control per row: a toggle and a number field side by side stack
			// vertically on mobile and break the rhythm of the tab.
			const group = groupOf(build(), CLEANUP);

			expect(group.items.map((item) => item.name)).toEqual([
				'High-pass filter',
				'High-pass cutoff',
				'Noise gate',
				'Noise gate threshold',
				'Loudness leveling',
				'Makeup gain',
			]);
		});

		it('bounds each stage parameter the way its processor does', () => {
			expect(rowOf(build(), CLEANUP, 'High-pass cutoff').control).toEqual(
				expect.objectContaining({
					type: 'number',
					key: 'cleanupHighPassHz',
					min: MIN_CLEANUP_HIGHPASS_HZ,
					max: MAX_CLEANUP_HIGHPASS_HZ,
					step: CLEANUP_HIGHPASS_STEP_HZ,
				}),
			);
		});

		it.each([
			['High-pass cutoff', 'cleanupHighPassEnabled'],
			['Noise gate threshold', 'cleanupNoiseGateEnabled'],
			['Makeup gain', 'cleanupLevelingEnabled'],
		])('disables %s while its stage is off', (rowName, enabledKey) => {
			// The parameter only takes effect once the stage runs, so it
			// reads as unavailable rather than as a value that does nothing.
			const settingsRecord = settings as unknown as Record<
				string,
				unknown
			>;
			settingsRecord[enabledKey] = false;
			const disabled = rowOf(build(), CLEANUP, rowName).control?.disabled;

			expect(typeof disabled === 'function' && disabled()).toBe(true);

			settingsRecord[enabledKey] = true;

			expect(typeof disabled === 'function' && disabled()).toBe(false);
		});
	});

	describe('the diagnostics section', () => {
		it('declares its three rows under one heading', () => {
			const group = diagnosticsGroupOf(build());

			expect(group.type).toBe('group');
			expect(group.heading).toBe('Diagnostics');
			expect(group.items.map((item) => item.name)).toEqual([
				'Test recording',
				'System info',
				'Debug mode',
			]);
		});

		it('binds debug mode to the settings key, so Obsidian owns the write', () => {
			expect(rowOf(build(), 'Diagnostics', 'Debug mode').control).toEqual(
				{
					type: 'toggle',
					key: 'debug',
				},
			);
		});

		it('opens the system information dialog from an action row', () => {
			const row = rowOf(build(), 'Diagnostics', 'System info');

			row.action?.(createDiv(), 1);

			expect(diagnostics.showSystemInfo).toHaveBeenCalledTimes(1);
		});

		it('starts the test capture in the row that reports it', () => {
			const definition = rowOf(build(), 'Diagnostics', 'Test recording');
			const { setting } = renderThroughFramework(
				definition as RenderDefinition,
			);

			setting.settingEl
				.querySelector<HTMLButtonElement>('button')
				?.click();

			expect(diagnostics.startTestRecording).toHaveBeenCalledWith(
				setting.settingEl,
			);
			// The row carries block content (status line, playback element)
			// under its control, which the stylesheet needs to know about.
			expect(
				setting.settingEl.classList.contains(SETTINGS_BLOCK_ROW_CLASS),
			).toBe(true);
		});

		it('releases the test capture through the cleanup the framework holds', () => {
			// The framework runs this before it renders the row again and before
			// it drops the row, which is the only teardown a render row gets
			// while the tab stays open.
			const definition = rowOf(build(), 'Diagnostics', 'Test recording');
			const frame = renderThroughFramework(
				definition as RenderDefinition,
			);

			expect(frame.cleanup).toEqual(expect.any(Function));
			expect(diagnostics.releaseTestRecording).not.toHaveBeenCalled();

			frame.cleanup?.();

			expect(diagnostics.releaseTestRecording).toHaveBeenCalledTimes(1);
		});
	});

	describe('collectDebouncedControlKeys', () => {
		it('collects the text-bearing controls, nested groups included', () => {
			const keys = collectDebouncedControlKeys([
				{
					name: 'Prefix',
					control: { type: 'text', key: 'filePrefix' },
				},
				{
					type: 'group',
					heading: 'Transcription',
					items: [
						{
							name: 'Prompt',
							control: { type: 'textarea', key: 'llmPrompt' },
						},
						{
							name: 'Enabled',
							control: {
								type: 'toggle',
								key: 'transcriptionEnabled',
							},
						},
					],
				},
			]);

			expect(keys).toEqual(new Set(['filePrefix', 'llmPrompt']));
		});

		it('leaves the controls that change once per interaction alone', () => {
			// A toggle, a dropdown, or a number field fires one change per
			// interaction: debouncing those would only delay the write.
			const keys = collectDebouncedControlKeys(build());

			expect(keys.has('debug')).toBe(false);
		});
	});
});
