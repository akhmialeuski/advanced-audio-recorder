/**
 * Unit tests for the tab's definition tree: what each migrated section declares,
 * and how the row hosting the not-yet-migrated sections behaves under the
 * framework that owns it.
 * @module tests/unit/settingsDefinitions.test
 */

import { Platform } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
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
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
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
	let settings: AudioRecorderSettings;
	let renderDocs: jest.Mock;
	let renderFormatRow: jest.Mock;
	let addModel: jest.Mock;
	let removeModel: jest.Mock;
	let renderSummaryRow: jest.Mock;
	let renderTranscriptionRest: jest.Mock;
	let diagnostics: { [K in keyof DiagnosticsActions]: jest.Mock };

	beforeEach(() => {
		settings = { ...DEFAULT_SETTINGS };
		// Stands in for the real body with one marker element, so a test can see
		// which host it was rendered into and whether it survived.
		renderDocs = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-doc-callout' });
		});
		renderFormatRow = jest.fn();
		addModel = jest.fn();
		removeModel = jest.fn();
		renderSummaryRow = jest.fn();
		renderTranscriptionRest = jest.fn((host: HTMLElement) => {
			host.createDiv({ cls: 'aar-transcription-rest' });
		});
		diagnostics = {
			startTestRecording: jest.fn(),
			releaseTestRecording: jest.fn(),
			showSystemInfo: jest.fn(),
		};
	});

	const createContext = (): SettingsDefinitionContext => ({
		settings,
		sampleRates: [44100, 48000],
		outputFormat: {
			renderFormatRow: renderFormatRow as (setting: Setting) => void,
			renderSummaryRow: renderSummaryRow as (setting: Setting) => void,
		},
		renderDocumentationLink: renderDocs as (host: HTMLElement) => void,
		devices: {
			inputs: {
				'mic-1': 'Built-in microphone',
				'iface-1': 'Audio interface',
			},
			channelSelectable: (deviceId: string): boolean =>
				deviceId === 'iface-1',
		},
		diagnostics: diagnostics,
		transcriptionBlocks: {
			renderEngineFields: renderTranscriptionRest as (
				host: HTMLElement,
			) => void,
			addModel: addModel as () => void,
			removeModel: removeModel as (index: number) => void,
			addLlmModel: jest.fn(),
			removeLlmModel: jest.fn(),
			renderDictionaryProfiles: jest.fn(),
			renderChapterProfiles: jest.fn(),
			renderLlmSection: jest.fn(),
		},
	});

	const build = (): SettingDefinitionItem[] =>
		buildSettingsDefinitions(createContext());

	/** The diagnostics group of a built tree. */
	const diagnosticsGroupOf = (
		definitions: SettingDefinitionItem[],
	): GroupDefinition => groupOf(definitions, 'Diagnostics');

	describe('the documentation row', () => {
		it('renders the callout into the row the framework hands over', () => {
			const { setting, containerEl } = renderThroughFramework(
				renderDefinitionOf(build()),
			);

			expect(renderDocs).toHaveBeenCalledWith(setting.settingEl);
			// The body survives the framework's post-render pass because it
			// lives inside the tracked row.
			expect(
				containerEl.querySelector('.aar-doc-callout'),
			).not.toBeNull();
		});

		it('marks the row so the stylesheet can strip its setting-row layout', () => {
			const { setting } = renderThroughFramework(
				renderDefinitionOf(build()),
			);

			expect(
				setting.settingEl.classList.contains(SETTINGS_ROOT_CLASS),
			).toBe(true);
			expect(setting.settingEl.contains(setting.nameEl)).toBe(false);
		});

		it('stays out of the settings search, having nothing to configure', () => {
			expect(
				(renderDefinitionOf(build()) as { searchable?: boolean })
					.searchable,
			).toBe(false);
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

		it('hosts the engine credentials, which are not a declared control', () => {
			// The API key is a password field, which no control type covers.
			settings.transcriptionEnabled = true;
			const definition = rowOf(
				build(),
				TRANSCRIPTION,
				'Transcription engine credentials',
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

	describe('the multi-track section', () => {
		const MULTI = 'Multi-track recording';

		/** Whether a row's visible predicate holds for the current settings. */
		const isVisible = (name: string): boolean => {
			const visible = rowOf(build(), MULTI, name).visible;
			return typeof visible === 'function'
				? visible()
				: visible !== false;
		};

		it('offers a row per track and reveals only the configured ones', () => {
			// Declared once for every track the section can offer and revealed
			// by predicate: changing the count reveals rows instead of
			// rebuilding the tab.
			settings.enableMultiTrack = true;
			settings.maxTracks = 2;

			expect(isVisible('Audio source for track 2')).toBe(true);
			expect(isVisible('Audio source for track 3')).toBe(false);

			settings.maxTracks = 3;

			expect(isVisible('Audio source for track 3')).toBe(true);
		});

		it('hides every track row while multi-track is off', () => {
			settings.enableMultiTrack = false;

			expect(isVisible('Audio source for track 1')).toBe(false);
			expect(isVisible('Maximum tracks')).toBe(false);
		});

		it('lists the enumerated devices as the track input options', () => {
			const control = rowOf(
				build(),
				MULTI,
				'Audio source for track 1',
			).control;

			expect(control?.key).toBe('track.1.deviceId');
			expect(control?.options).toEqual({
				'mic-1': 'Built-in microphone',
				'iface-1': 'Audio interface',
			});
		});

		it('disables the channel layout of a track whose device has one channel', () => {
			settings.enableMultiTrack = true;
			settings.trackAudioSources.set(1, {
				deviceId: 'mic-1',
				channelMode: 'source',
			});
			const disabled = rowOf(build(), MULTI, 'Channels for track 1')
				.control?.disabled;

			expect(typeof disabled === 'function' && disabled()).toBe(true);

			settings.trackAudioSources.set(1, {
				deviceId: 'iface-1',
				channelMode: 'source',
			});

			expect(typeof disabled === 'function' && disabled()).toBe(false);
		});
	});

	describe('the audio splitting section', () => {
		const SPLITTING = 'Audio splitting';

		it('rejects a part suffix that would not make a valid file name', () => {
			const validate = rowOf(build(), SPLITTING, 'Part name suffix')
				.control?.validate as (value: string) => string | undefined;

			expect(validate('part')).toBeUndefined();
			expect(validate('take_2')).toBeUndefined();
			expect(validate('bad suffix')).toBe(
				'Letters, digits, hyphens and underscores only.',
			);
			expect(validate('')).toBe(
				'Letters, digits, hyphens and underscores only.',
			);
		});

		it('bounds the part duration', () => {
			expect(rowOf(build(), SPLITTING, 'Part duration').control).toEqual(
				expect.objectContaining({
					type: 'number',
					key: 'splitChunkMinutes',
					min: MIN_SPLIT_CHUNK_MINUTES,
					max: MAX_SPLIT_CHUNK_MINUTES,
				}),
			);
		});
	});

	describe('the model list', () => {
		const seedModels = (): void => {
			settings.transcriptionEnabled = true;
			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
			settings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			settings.whisperApiModel = 'whisper-1';
		};

		/** The engine's model list, narrowed to what these tests read. */
		const modelList = (): {
			type: string;
			emptyState?: string;
			search?: { match: (def: { name: string }, q: string) => boolean };
			addItem?: { name: string; action: (el: HTMLElement) => void };
			onDelete?: (index: number) => void;
			items: Array<{ name: string; desc?: string }>;
		} => groupOf(build(), 'Whisper model') as never;

		it('declares the saved models as a list the user can edit', () => {
			seedModels();
			const list = modelList();

			// A collection with add and delete affordances is a list, not a
			// group: the framework renders those affordances itself.
			expect(list.type).toBe('list');
			expect(list.items.map((item) => item.name)).toEqual([
				'whisper-1',
				'whisper-large-v3',
			]);
		});

		it('marks which saved model is the one in use', () => {
			seedModels();

			expect(modelList().items[0]?.desc).toBe('In use');
			expect(modelList().items[1]?.desc).toBeUndefined();
		});

		it('filters the list through the group search', () => {
			seedModels();
			const match = modelList().search?.match;

			expect(match?.({ name: 'whisper-large-v3' }, 'large')).toBe(true);
			expect(match?.({ name: 'whisper-1' }, 'large')).toBe(false);
		});

		it('adds and deletes through the tab, which owns the settings', () => {
			seedModels();
			const list = modelList();

			list.addItem?.action(createDiv());
			list.onDelete?.(1);

			expect(addModel).toHaveBeenCalledTimes(1);
			expect(removeModel).toHaveBeenCalledWith(1);
		});

		it('offers an empty state instead of a bare heading', () => {
			seedModels();
			settings.whisperApiModels = [];

			expect(modelList().emptyState).toContain('No models saved yet');
		});

		it('stays hidden for the local engine, which has no model list', () => {
			settings.transcriptionEnabled = true;
			settings.transcriptionProvider =
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER;
			const visible = (
				groupOf(build(), 'Models') as { visible?: () => boolean }
			).visible;

			expect(typeof visible === 'function' && visible()).toBe(false);
		});
	});

	describe('the transcript output section', () => {
		const OUTPUT = 'Transcript output';

		it('offers the file format only when a file is written', () => {
			settings.transcriptDestination = 'note';
			const visible = rowOf(build(), OUTPUT, 'File format').visible;

			expect(typeof visible === 'function' && visible()).toBe(false);

			settings.transcriptDestination = 'file';

			expect(typeof visible === 'function' && visible()).toBe(true);
		});

		it.each(['Include speakers', 'Merge speaker turns', 'Speaker format'])(
			'disables %s without diarization in effect',
			(rowName) => {
				// The row exists; this engine and these settings just produce no
				// speaker labels for it to format.
				settings.transcriptionProvider =
					TRANSCRIPTION_PROVIDER_IDS.WHISPER_API;
				settings.transcriptionDiarize = true;
				const disabled = rowOf(build(), OUTPUT, rowName).control
					?.disabled;

				expect(typeof disabled === 'function' && disabled()).toBe(true);

				settings.transcriptionProvider =
					TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM;

				expect(typeof disabled === 'function' && disabled()).toBe(
					false,
				);
			},
		);

		it('refuses an empty output template', () => {
			// An empty template would render every line as nothing at all.
			const validate = rowOf(build(), OUTPUT, 'Line format').control
				?.validate as (value: string) => string | undefined;

			expect(validate('{timestamp} {text}')).toBeUndefined();
			expect(validate('  ')).toBe('A template cannot be empty.');
		});
	});

	describe('the advanced transcription section', () => {
		it('keeps the two-pass safeguard behind both switches', () => {
			settings.transcriptionEnabled = true;
			settings.transcriptionAdvancedSettingsEnabled = true;
			settings.transcriptionAdvancedEnabled = false;
			const visible = rowOf(
				build(),
				'Advanced',
				'Second-pass length safeguard',
			).visible;

			expect(typeof visible === 'function' && visible()).toBe(false);

			settings.transcriptionAdvancedEnabled = true;

			expect(typeof visible === 'function' && visible()).toBe(true);
		});

		it('hides the whole block while transcription is off', () => {
			settings.transcriptionEnabled = false;
			const group = groupOf(build(), 'Advanced');

			expect(typeof group.visible === 'function' && group.visible()).toBe(
				false,
			);
		});
	});

	describe('the audio player section', () => {
		const PLAYER = 'Audio player';

		it('binds the player options to their settings keys', () => {
			const group = groupOf(build(), PLAYER);

			expect(group.items.map((item) => item.name)).toEqual([
				'Enhanced audio player',
				'Show waveform',
				'Markers and chapters',
			]);
			expect(rowOf(build(), PLAYER, 'Show waveform').control).toEqual({
				type: 'toggle',
				key: 'playerShowWaveform',
			});
		});

		it('reveals the player windows only while the player is on', () => {
			settings.enhancedPlayerEnabled = false;
			const visible = rowOf(build(), PLAYER, 'Show waveform').visible;

			expect(typeof visible === 'function' && visible()).toBe(false);

			settings.enhancedPlayerEnabled = true;

			expect(typeof visible === 'function' && visible()).toBe(true);
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
