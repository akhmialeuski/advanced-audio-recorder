/**
 * Unit tests for the tab's definition tree: what each section declares, and how
 * the rows that keep a render callback - the ones no control type covers -
 * behave under the framework that owns them.
 * @module tests/unit/settingsDefinitions.test
 */

import { Platform } from 'obsidian';
import type { Setting, SettingDefinitionItem } from 'obsidian';
import {
	groupOf,
	listIn,
	pageOf,
	renderDefinitionOf,
	rowIn,
	renderThroughFramework,
	rowNamesIn,
	rowOf,
	type GroupDefinition,
	type RenderDefinition,
	type RowDefinition,
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
	SETTINGS_SECTION_CLASS,
	STACKED_TEXT_CLASS,
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	type DiagnosticsActions,
	type ProfileCatalogue,
	type SettingsDefinitionContext,
} from 'src/settings/settingsDefinitions';

describe('settings definitions', () => {
	let settings: AudioRecorderSettings;
	let renderDocs: jest.Mock;
	let renderFormatRow: jest.Mock;
	let addModel: jest.Mock;
	let addProfile: jest.Mock;
	let renameProfile: jest.Mock;
	let removeProfile: jest.Mock;
	let profileEntries: Array<{ id: string; name: string; summary: string }>;
	let declareListAddRow: boolean;
	let removeModel: jest.Mock;
	let selectModel: jest.Mock;
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
		addProfile = jest.fn();
		renameProfile = jest.fn();
		removeProfile = jest.fn();
		profileEntries = [
			{ id: 'a', name: 'Standup', summary: '3 terms' },
			{ id: 'b', name: 'Legal', summary: 'In use, 12 terms' },
		];
		declareListAddRow = false;
		removeModel = jest.fn();
		selectModel = jest.fn();
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
		profiles: {
			dictionary: catalogue('Dictionary profiles', 'Terms'),
			chapters: catalogue('Chapter guidance profiles', 'Guidance prompt'),
		},
		declareListAddRow,
		transcriptionBlocks: {
			renderEngineFields: renderTranscriptionRest as (
				host: HTMLElement,
			) => void,
			addModel: addModel as () => void,
			removeModel: removeModel as (index: number) => void,
			selectModel: selectModel as (id: string) => void,
			addLlmModel: jest.fn(),
			removeLlmModel: jest.fn(),
			selectLlmModel: jest.fn(),
			renderLlmSection: jest.fn(),
		},
	});

	/** A profile catalogue whose edits are spies. */
	const catalogue = (
		heading: string,
		bodyName: string,
	): ProfileCatalogue => ({
		heading,
		selectorDesc: 'Pick the profile to use.',
		bodyName,
		bodyDesc: 'The profile body.',
		selectionName: 'Use by default',
		selectionDesc: 'Offer this profile in the Transcribe dialog.',
		selectionKey:
			heading === 'Dictionary profiles'
				? 'transcriptionDictionaryProfileId'
				: 'transcriptionChapterPromptProfileId',
		bodyKey: `${heading}.body`,
		entries: () => profileEntries,
		visible: () => true,
		add: addProfile as () => void,
		rename: renameProfile as (id: string) => void,
		remove: removeProfile as (id: string) => void,
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

	describe('search terms', () => {
		/** Every row in the tree, at any depth. */
		const allRows = (
			entries: readonly SettingDefinitionItem[],
		): RowDefinition[] =>
			entries.flatMap((entry) =>
				'type' in entry
					? allRows((entry.items ?? []) as SettingDefinitionItem[])
					: [entry as unknown as RowDefinition],
			);

		/** The declared aliases of a row, addressed by name. */
		const aliasesOf = (name: string): string[] => {
			const row = allRows(build()).find((entry) => entry.name === name);
			if (!row) {
				throw new Error(`No "${name}" row declared`);
			}
			return row.aliases ?? [];
		};

		it('lets the settings search find a row by what it does', () => {
			// The framework indexes a row by its name and its aliases, so a
			// user who searches for the thing rather than for our word for it
			// still lands on the row.
			expect(aliasesOf('Input device')).toContain('microphone');
			expect(aliasesOf('Enable transcription')).toContain(
				'speech to text',
			);
			expect(aliasesOf('Loudness leveling')).toContain('normalize');
		});

		it('makes the fields inside a hand-rendered block findable', () => {
			// The search indexes definitions, and a credential block is one
			// definition, so its API-key field has no row of its own to match.
			expect(aliasesOf('Transcription engine credentials')).toContain(
				'api key',
			);
			expect(aliasesOf('LLM credentials')).toContain('api key');
		});

		it('declares no alias that repeats the row name', () => {
			for (const row of allRows(build())) {
				expect(row.aliases ?? []).not.toContain(row.name.toLowerCase());
			}
		});
	});

	describe('the transcription sub-page', () => {
		/** The transcription page entry. */
		const transcriptionPage = (): GroupDefinition & {
			displayValue?: () => string;
		} => pageOf(build(), 'Transcription');

		it('gathers the transcription groups behind one entry', () => {
			const page = transcriptionPage();

			expect(page.name).toBe('Transcription');
			// Every transcription group moved onto the page, so the main tab
			// carries none of them.
			expect(
				page.items.map((item) => (item as GroupDefinition).heading),
			).toEqual(
				expect.arrayContaining([
					'Transcription',
					'Transcript output',
					'Auto chapters',
					'LLM post-processing',
				]),
			);
			expect(
				build().some(
					(item) =>
						'type' in item &&
						item.type !== 'page' &&
						item.heading === 'Transcript output',
				),
			).toBe(false);
		});

		it('keeps a collection off the page that owns it', () => {
			settings.transcriptionEnabled = true;
			settings.whisperApiModels = ['whisper-1', 'whisper-large-v3'];
			settings.whisperApiModel = 'whisper-1';

			// A vendor catalogue runs to thirty-odd ids, and inline that is
			// thirty rows between the engine and everything after it. Each
			// collection sits on a page of its own, which costs one row.
			const inline = transcriptionPage().items.filter(
				(item) => (item as GroupDefinition).type !== 'page',
			);
			for (const section of inline) {
				expect((section as GroupDefinition).type === 'list').toBe(
					false,
				);
			}
			expect(listIn(pageOf(build(), 'Whisper model')).items).toHaveLength(
				2,
			);
		});

		it('says on the entry which model and profile are in use', () => {
			settings.transcriptionEnabled = true;
			settings.whisperApiModels = ['whisper-1'];
			settings.whisperApiModel = 'whisper-1';
			settings.transcriptionDictionaryProfileId = 'b';

			// The value a page holds belongs on the entry, so opening it is a
			// choice rather than the only way to see what is set.
			const displayValue = (name: string): string | undefined =>
				(
					pageOf(build(), name) as {
						displayValue?: () => string;
					}
				).displayValue?.();
			expect(displayValue('Whisper model')).toBe('whisper-1');
			expect(displayValue('Dictionary profiles')).toBe('Legal');
		});

		it('reports on the entry whether transcription is on', () => {
			settings.transcriptionEnabled = false;

			expect(transcriptionPage().displayValue?.()).toBe('Off');

			settings.transcriptionEnabled = true;

			expect(transcriptionPage().displayValue?.()).toBe('On');
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

		/** Whether the entry that opens the engine page is shown. */
		const engineEntryVisible = (): boolean => {
			const visible = (
				pageOf(build(), 'Engine') as { visible?: () => boolean }
			).visible;
			return typeof visible === 'function' ? visible() : true;
		};

		it('keeps every option behind the section switch', () => {
			// A predicate, not a re-render: the framework hides and shows these
			// rows in place, and the legacy renderer does the same.
			settings.transcriptionEnabled = false;

			expect(isVisible('Enable transcription')).toBe(true);
			expect(engineEntryVisible()).toBe(false);
			expect(isVisible('Language')).toBe(false);

			settings.transcriptionEnabled = true;

			expect(engineEntryVisible()).toBe(true);
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

			expect(isVisible('Track 2 input')).toBe(true);
			expect(isVisible('Track 3 input')).toBe(false);

			settings.maxTracks = 3;

			expect(isVisible('Track 3 input')).toBe(true);
		});

		it('hides every track row while multi-track is off', () => {
			settings.enableMultiTrack = false;

			expect(isVisible('Track 1 input')).toBe(false);
			expect(isVisible('Maximum tracks')).toBe(false);
		});

		it('lists the enumerated devices as the track input options', () => {
			const control = rowOf(build(), MULTI, 'Track 1 input').control;

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
			const disabled = rowOf(build(), MULTI, 'Track 1 channels').control
				?.disabled;

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
			items: Array<{
				name: string;
				desc?: string;
				action?: (el: HTMLElement, index: number) => void;
			}>;
		} => listIn(pageOf(build(), 'Whisper model')) as never;

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

		it('makes a tapped id the model in use', () => {
			seedModels();

			// The list is the picker: the row is the choice, so there is no
			// dropdown beside it saying the same thing.
			modelList().items[1]?.action?.(createDiv(), 1);

			expect(selectModel).toHaveBeenCalledWith('whisper-large-v3');
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
				pageOf(build(), 'Model') as { visible?: () => boolean }
			).visible;

			expect(typeof visible === 'function' && visible()).toBe(false);
		});
	});

	describe('the profile catalogues', () => {
		/** A catalogue list, narrowed to what these tests read. */
		const listOf = (
			heading: string,
		): {
			type: string;
			emptyState?: string;
			addItem?: { action: (el: HTMLElement) => void };
			onDelete?: (index: number) => void;
			items: Array<{ name: string; desc?: string }>;
		} => listIn(pageOf(build(), heading)) as never;

		it('declares every stored profile as a page of its own', () => {
			const list = listOf('Dictionary profiles');

			expect(list.type).toBe('list');
			expect(list.items.map((item) => item.name)).toEqual([
				'Standup',
				'Legal',
			]);
			// Each entry says what the profile holds and whether a run uses it,
			// so opening one is a choice rather than the only way to see it.
			expect(
				list.items.map(
					(item) => (item as { displayValue?: string }).displayValue,
				),
			).toEqual(['3 terms', 'In use, 12 terms']);
			for (const item of list.items) {
				expect((item as { type?: string }).type).toBe('page');
			}
		});

		it('leaves the list without a per-row delete affordance', () => {
			// Deleting belongs on the profile's own page: a cross on every row
			// turns a list of names into a list of buttons.
			expect(listOf('Dictionary profiles').onDelete).toBeUndefined();
		});

		it('edits each profile on its own page, keyed by that profile', () => {
			const page = pageOf(build(), 'Standup');

			expect(rowIn(page, 'Terms').control).toEqual(
				expect.objectContaining({
					type: 'textarea',
					key: 'Dictionary profiles.body#a',
				}),
			);
			expect(rowIn(page, 'Use by default').control).toEqual(
				expect.objectContaining({
					type: 'toggle',
					key: 'transcriptionDictionaryProfileId#a',
				}),
			);
		});

		it('lays the body out under its name across the row', () => {
			// A glossary is edited in paragraphs; the control column a row gives
			// a text area by default is a few characters wide.
			const page = pageOf(build(), 'Legal');
			const stacked = (page.items as GroupDefinition[]).find((item) =>
				(item.cls ?? '').split(' ').includes(STACKED_TEXT_CLASS),
			);

			expect(
				stacked?.items.map((item) => (item as RowDefinition).name),
			).toContain('Terms');
		});

		it('renames and deletes from the page of the profile itself', () => {
			const page = pageOf(build(), 'Legal');

			rowIn(page, 'Rename profile').action?.(createDiv(), 0);
			rowIn(page, 'Delete profile').action?.(createDiv(), 0);

			expect(renameProfile).toHaveBeenCalledWith('b');
			expect(removeProfile).toHaveBeenCalledWith('b');
		});

		it('adds through the tab, which owns the profiles', () => {
			listOf('Chapter guidance profiles').addItem?.action(createDiv());

			expect(addProfile).toHaveBeenCalledTimes(1);
		});

		/** Whether a page declares a row of its own under a name. */
		const hasRow = (page: GroupDefinition, name: string): boolean =>
			page.items.some((item) => !('type' in item) && item.name === name);

		it('declares a labelled add row only where the renderer draws none', () => {
			expect(
				hasRow(pageOf(build(), 'Dictionary profiles'), 'Add profile'),
			).toBe(false);

			declareListAddRow = true;
			const page = pageOf(build(), 'Dictionary profiles');
			rowIn(page, 'Add profile').action?.(createDiv(), 0);

			expect(addProfile).toHaveBeenCalledTimes(1);
			// Beside the list, not in it: a row inside would be filtered away
			// by the list's own search exactly when nothing matches.
			expect(listIn(page).items.map((item) => item.name)).not.toContain(
				'Add profile',
			);
		});
	});

	describe('what each block holds', () => {
		/** Names of a block's own children, rows and page entries alike. */
		const childNamesOf = (heading: string): string[] =>
			groupOf(build(), heading).items.map((item) => item.name ?? '');

		/** The same, for a page whose rows are one block. */
		const entryNamesOf = (page: string): string[] => {
			const [block] = pageOf(build(), page).items as GroupDefinition[];
			return (block?.items ?? []).map((item) => item.name ?? '');
		};

		it('names the engine model once, on the entry that picks it', () => {
			const names = entryNamesOf('Engine');

			// One place says which model is in use: the entry that opens the
			// ids it was chosen from, on the row after the endpoint serving it.
			expect(names.filter((name) => name === 'Whisper model')).toEqual([
				'Whisper model',
			]);
			expect(names.indexOf('Whisper model')).toBe(
				names.indexOf('Whisper API base URL') + 1,
			);
		});

		it('opens the transcription block with the engine', () => {
			// The first thing to settle once transcription is on: what turns
			// speech into text, before how the run behaves.
			expect(childNamesOf('Transcription').slice(0, 2)).toEqual([
				'Enable transcription',
				'Engine',
			]);
		});

		it('keeps the engine and its own settings on one page', () => {
			// The picker used to sit five rows above the fields it decides,
			// with the settings that hold for every engine in between.
			expect(entryNamesOf('Engine')).toEqual([
				'Engine',
				'Whisper API base URL',
				'Whisper model',
				'Transcription engine credentials',
			]);
			expect(childNamesOf('Transcription')).toContain('Engine');
		});

		it('names the LLM model once, the same way', () => {
			const names = childNamesOf('LLM post-processing');

			expect(names.filter((name) => name === 'LLM model')).toEqual([
				'LLM model',
			]);
			expect(names.indexOf('LLM model')).toBe(
				names.indexOf('LLM base URL') + 1,
			);
		});

		it('keeps each profile catalogue inside the block that gates it', () => {
			// A glossary is only reachable while the advanced settings are on,
			// and a guidance prompt only while chapters are generated.
			expect(childNamesOf('Advanced')).toContain('Dictionary profiles');
			expect(childNamesOf('Auto chapters')).toContain(
				'Chapter guidance profiles',
			);
		});

		it('leaves the transcription page holding blocks and nothing else', () => {
			for (const item of pageOf(build(), 'Transcription').items) {
				expect('type' in item && item.type).toBe('group');
			}
		});
	});

	describe('the blocks the stylesheet separates', () => {
		/** Every group, list, and page of a tree, at any depth. */
		const everyContainer = (
			entries: ReadonlyArray<RowDefinition | GroupDefinition>,
		): GroupDefinition[] =>
			entries.flatMap((entry) =>
				'type' in entry
					? [entry, ...everyContainer(entry.items ?? [])]
					: [],
			);

		it('marks every group it declares as a block', () => {
			// The class is the only handle the stylesheet has: a group carries
			// it, a row cannot, and a group left unmarked keeps Obsidian's
			// divider between its rows and loses the line above itself.
			const unmarked = everyContainer(
				build() as Array<RowDefinition | GroupDefinition>,
			)
				.filter((entry) => entry.type !== 'page')
				.filter(
					(entry) =>
						!(entry.cls ?? '')
							.split(' ')
							.includes(SETTINGS_SECTION_CLASS),
				);

			expect(unmarked).toEqual([]);
		});

		it('gives a page of loose rows a block of its own', () => {
			// Without it the framework wraps those rows in a group of its own,
			// which carries no class and is left ruled between every row.
			const page = pageOf(build(), 'Audio splitting');

			expect(
				(page.items as GroupDefinition[]).map((item) => item.cls),
			).toEqual([SETTINGS_SECTION_CLASS]);
			expect(rowOf(build(), 'Audio splitting', 'Part duration')).toEqual(
				expect.objectContaining({ name: 'Part duration' }),
			);
		});
	});

	describe('the sections that sit behind an entry', () => {
		/** What a page's entry shows without being opened. */
		const displayValueOf = (name: string): string | undefined =>
			(
				pageOf(build(), name) as {
					displayValue?: (() => string) | string;
				}
			).displayValue as string | undefined;

		/** The same, for the entries whose value is computed per read. */
		const readValue = (name: string): string | undefined => {
			const value = (
				pageOf(build(), name) as {
					displayValue?: (() => string) | string;
				}
			).displayValue;
			return typeof value === 'function' ? value() : value;
		};

		it.each([
			'Audio splitting',
			'Multi-track recording',
			'Audio player',
			'Audio processing & feedback',
			'Audio cleanup defaults',
			'Diagnostics',
		])('declares %s behind an entry rather than inline', (name) => {
			// Sections nobody reads on the way to something else: inline they
			// are twenty rows between the recording settings and diagnostics.
			expect(pageOf(build(), name).type).toBe('page');
			expect(displayValueOf(name) ?? readValue(name)).toBeDefined();
		});

		it('says on the splitting entry whether recordings split, and how often', () => {
			settings.autoSplitEnabled = false;

			expect(readValue('Audio splitting')).toBe('Off');

			settings.autoSplitEnabled = true;
			settings.splitChunkMinutes = 23;

			expect(readValue('Audio splitting')).toBe('Every 23 min');
		});

		it('says on the multi-track entry how many tracks are configured', () => {
			settings.enableMultiTrack = false;

			expect(readValue('Multi-track recording')).toBe('Off');

			settings.enableMultiTrack = true;
			settings.maxTracks = 3;

			expect(readValue('Multi-track recording')).toBe('3 tracks');
		});

		it('says on the diagnostics entry whether verbose logging is on', () => {
			settings.debug = false;

			expect(readValue('Diagnostics')).toBe('Debug off');

			settings.debug = true;

			expect(readValue('Diagnostics')).toBe('Debug on');
		});

		it('says on the player entry whether the enhanced embed is on', () => {
			settings.enhancedPlayerEnabled = true;

			expect(readValue('Audio player')).toBe('On');

			settings.enhancedPlayerEnabled = false;

			expect(readValue('Audio player')).toBe('Off');
		});

		it('counts the switches that are on for the processing entry', () => {
			settings.inputNoiseSuppression = true;
			settings.inputEchoCancellation = true;
			settings.inputAutoGainControl = false;
			settings.showInputLevelMeter = false;
			settings.showRecordingStats = false;
			settings.detectSilentChannelOnSave = false;
			settings.mobileRecordingBanner = false;

			// Seven independent switches have no single value, so the entry
			// reports how many of them are on.
			expect(readValue('Audio processing & feedback')).toBe('2 of 7 on');
		});

		it('names the stages the cleanup dialog would open with', () => {
			settings.cleanupHighPassEnabled = true;
			settings.cleanupNoiseGateEnabled = false;
			settings.cleanupLevelingEnabled = true;

			// A count would not say which two, and which two is the answer
			// worth having before opening the page.
			expect(readValue('Audio cleanup defaults')).toBe(
				'High-pass, Leveling',
			);

			settings.cleanupHighPassEnabled = false;
			settings.cleanupLevelingEnabled = false;

			expect(readValue('Audio cleanup defaults')).toBe('Off');
		});

		it('keeps every row of those sections reachable', () => {
			// Moving a section behind an entry must not drop a setting: the
			// rows are the same rows, one navigation step further in.
			expect(
				rowOf(build(), 'Audio splitting', 'Part duration').control
					?.type,
			).toBe('number');
			expect(
				rowOf(build(), 'Audio player', 'Show waveform').control?.type,
			).toBe('toggle');
			expect(
				rowOf(build(), 'Audio cleanup defaults', 'Makeup gain').control
					?.type,
			).toBe('number');
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
			expect(rowNamesIn(groupOf(build(), PLAYER))).toEqual([
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
			const rows = rowNamesIn(
				groupOf(build(), 'Audio processing & feedback'),
			).map((name) => [
				name,
				rowOf(build(), 'Audio processing & feedback', name).control,
			]);

			expect(rows).toEqual([
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
			expect(rowNamesIn(groupOf(build(), CLEANUP))).toEqual([
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
		it('declares its three rows behind one entry', () => {
			const group = diagnosticsGroupOf(build());

			// Opened when something is wrong rather than while a recording is
			// being set up, so it costs the main tab one row.
			expect(group.type).toBe('page');
			expect(group.name).toBe('Diagnostics');
			expect(rowNamesIn(group)).toEqual([
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
