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
import type { ProfileSection } from 'src/settings/profileKinds';
import {
	CHANNEL_MODE_LABELS,
	CONVERSION_LINK_ACTION_LABELS,
	LLM_PROVIDER_LABELS,
	LLM_TASK_LABELS,
	TRANSCRIPTION_PROVIDER_LABELS,
	TRANSCRIPT_DESTINATION_LABELS,
	TRANSCRIPT_FILE_FORMAT_LABELS,
} from 'src/settings/labels';
import { ENGINE_IDS, type EngineId } from 'src/providers/providers';
import {
	CLEANUP_HIGHPASS_STEP_HZ,
	MAX_CLEANUP_HIGHPASS_HZ,
	MIN_CLEANUP_HIGHPASS_HZ,
	MIN_SPLIT_CHUNK_MINUTES,
	MAX_SPLIT_CHUNK_MINUTES,
	MAX_LLM_MAX_TOKENS,
	TRANSCRIPTION_PROVIDER_IDS,
	WHISPER_API_MODELS_DOC_URL,
} from 'src/constants';
import {
	SETTINGS_BLOCK_ROW_CLASS,
	SETTINGS_ROOT_CLASS,
	SETTINGS_SECTION_CLASS,
	STACKED_TEXT_CLASS,
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	numberControlRejection,
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
		profiles: [
			catalogue('advanced', 'Dictionary profiles', 'Terms'),
			catalogue(
				'chapters',
				'Chapter guidance profiles',
				'Guidance prompt',
			),
			catalogue('transcription', 'Participant profiles', 'Participants'),
		],
		declareListAddRow,
		transcriptionBlocks: {
			renderProviderKey: renderTranscriptionRest as (
				host: HTMLElement,
			) => void,
			renderLocalWhisperFields: jest.fn(),
			addModel: addModel as (engine: EngineId) => void,
			removeModel: removeModel as (
				engine: EngineId,
				model: string,
			) => void,
			selectModel: selectModel as (
				engine: EngineId,
				model: string,
			) => void,
		},
	});

	/** A profile catalogue whose edits are spies. */
	const catalogue = (
		section: ProfileSection,
		heading: string,
		bodyName: string,
	): ProfileCatalogue => ({
		section,
		heading,
		selectorDesc: 'Pick the profile to use.',
		bodyName,
		bodyDesc: 'The profile body.',
		selectionName: 'Use by default',
		selectionDesc: 'Offer this profile in the Transcribe dialog.',
		selectionKey: `${heading} id`,
		bodyKey: `${heading}.body`,
		entries: () => profileEntries,
		visible: () => true,
		add: addProfile as () => void,
		rename: renameProfile as (id: string) => void,
		remove: removeProfile as (id: string) => void,
	});

	const build = (): SettingDefinitionItem[] =>
		buildSettingsDefinitions(createContext());

	/**
	 * Names of a page's own children, rows and entries alike. A page whose rows
	 * are one block declares that block itself, so what it shows is a level in.
	 * @param name - Name on the page's entry
	 */
	const pageEntryNames = (name: string): string[] => {
		const [block] = pageOf(build(), name).items as GroupDefinition[];
		return (block?.items ?? []).map((item) => item.name ?? '');
	};

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
			// The search indexes definitions, and a key block is one
			// definition, so the password field has no row of its own to match.
			expect(aliasesOf('Deepgram API key')).toContain('token');
			expect(aliasesOf('Binary and model paths')).toContain('offline');
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
			expect(
				listIn(pageOf(build(), 'Whisper API (OpenAI-compatible)'))
					.items,
			).toHaveLength(2);
		});

		it('says on the entry which model and profile are in use', () => {
			settings.transcriptionEnabled = true;
			settings.whisperApiModels = ['whisper-1'];
			settings.whisperApiModel = 'whisper-1';
			// The test catalogue keys its selection by heading, so the entry
			// reads the same field the tree binds the picker to.
			(settings as unknown as Record<string, string>)[
				'Dictionary profiles id'
			] = 'b';

			// The value a page holds belongs on the entry, so opening it is a
			// choice rather than the only way to see what is set.
			const displayValue = (name: string): string | undefined =>
				(
					pageOf(build(), name) as {
						displayValue?: () => string;
					}
				).displayValue?.();
			settings.whisperApiKey = 'sk-test';

			// An engine entry reports what it holds: the model it uses once it
			// is reachable, and what is missing until then.
			expect(displayValue('Whisper API (OpenAI-compatible)')).toBe(
				'whisper-1',
			);
			expect(displayValue('Dictionary profiles')).toBe('Legal');

			// Both halves are needed to run, so an engine reachable but with
			// nothing to run says which half is still missing rather than
			// reading as configured.
			settings.whisperApiModel = '';

			expect(displayValue('Whisper API (OpenAI-compatible)')).toBe(
				'No model',
			);
		});

		it('counts a configured engine by its account, not by its engines', () => {
			// One key configures the account it belongs to. The Whisper API and
			// OpenAI engines name the same account, so entering that one key is
			// one answer on the entry, not two.
			settings.transcriptionEnabled = true;
			const engines = (): string | undefined =>
				(
					pageOf(build(), 'Engines') as {
						displayValue?: () => string;
					}
				).displayValue?.();

			expect(engines()).toBe('0 configured');

			settings.whisperApiKey = 'sk-test';

			expect(engines()).toBe('1 configured');

			settings.deepgramApiKey = 'dg-test';

			expect(engines()).toBe('2 configured');
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

		/** Whether the row that picks the engine is shown. */
		const engineEntryVisible = (): boolean =>
			isVisible('Transcription engine');

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
			const control = rowOf(
				build(),
				TRANSCRIPTION,
				'Transcription engine',
			).control;

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

		it('hosts a provider key on that provider\u2019s page', () => {
			// A password field is the one row no control type covers, and it
			// belongs to the service rather than to either use of it.
			expect(pageEntryNames('Deepgram')).toEqual([
				'Base URL',
				'Deepgram API key',
				'Model',
			]);
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
		} =>
			listIn(pageOf(build(), 'Whisper API (OpenAI-compatible)')) as never;

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

			expect(selectModel).toHaveBeenCalledWith(
				ENGINE_IDS.WHISPER_API,
				'whisper-large-v3',
			);
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

			expect(addModel).toHaveBeenCalledWith(ENGINE_IDS.WHISPER_API);
			// By id, not by position: the row was built from the catalogue as
			// it stood, and the edit runs against it as it stands.
			expect(removeModel).toHaveBeenCalledWith(
				ENGINE_IDS.WHISPER_API,
				'whisper-large-v3',
			);
		});

		it('offers an empty state instead of a bare heading', () => {
			seedModels();
			settings.whisperApiModels = [];

			expect(modelList().emptyState).toContain('No models saved yet');
		});

		it('declares no catalogue for the local engine, which serves none', () => {
			// It runs a binary against a file on disk: there is no list of
			// served ids to keep, so its page holds the paths instead.
			expect(() =>
				pageOf(build(), 'Local whisper.cpp (desktop)'),
			).not.toThrow();
			expect(pageEntryNames('Local whisper.cpp (desktop)')).toEqual([
				'Binary and model paths',
			]);
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

		/**
		 * A profile's page under one catalogue. Both catalogues are seeded with
		 * the same entries here, so the lookup has to say which one it means.
		 * @param heading - The catalogue holding it
		 * @param name - The profile's name
		 */
		const profilePageOf = (
			heading: string,
			name: string,
		): GroupDefinition =>
			pageOf(
				listIn(pageOf(build(), heading))
					.items as unknown as SettingDefinitionItem[],
				name,
			);

		it('edits each profile on its own page, keyed by that profile', () => {
			const page = profilePageOf('Dictionary profiles', 'Standup');

			expect(rowIn(page, 'Terms').control).toEqual(
				expect.objectContaining({
					type: 'textarea',
					key: 'Dictionary profiles.body#a',
				}),
			);
			expect(rowIn(page, 'Use by default').control).toEqual(
				expect.objectContaining({
					type: 'toggle',
					key: 'Dictionary profiles id#a',
				}),
			);
		});

		it('lays the body out under its name across the row', () => {
			// A glossary is edited in paragraphs; the control column a row gives
			// a text area by default is a few characters wide.
			const page = profilePageOf('Dictionary profiles', 'Legal');
			const stacked = (page.items as GroupDefinition[]).find((item) =>
				(item.cls ?? '').split(' ').includes(STACKED_TEXT_CLASS),
			);

			expect(
				stacked?.items.map((item) => (item as RowDefinition).name),
			).toContain('Terms');
		});

		it('renames and deletes from the page of the profile itself', () => {
			const page = profilePageOf('Dictionary profiles', 'Legal');

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

		it('configures every provider on one page each, under Engines', () => {
			// One place to set up a service, whatever it is later asked to do:
			// the endpoint, the key, and the catalogues it serves.
			const engines = pageOf(build(), 'Engines');
			const providers = (engines.items[0] as GroupDefinition).items.map(
				(item) => item.name ?? '',
			);

			expect(providers).toEqual([
				'Whisper API (OpenAI-compatible)',
				'OpenAI',
				'Deepgram',
				'Google Gemini',
				'Anthropic (Claude)',
				'Local whisper.cpp (desktop)',
			]);
			// A provider that both transcribes and answers prompts keeps one
			// key and one endpoint, with a catalogue per capability.
			// One catalogue for both jobs, because the ids are the same family.
			// One catalogue for both jobs, and the ceiling of the engine that
			// has to honour it.
			expect(pageEntryNames('Google Gemini')).toEqual([
				'Base URL',
				'Google Gemini API key',
				'Model',
				'Max output tokens',
			]);
		});

		it('carries the catalogue link on the catalogue, not on the key field', () => {
			// The link lists the ids the endpoint serves, so it belongs with
			// those ids; hanging it off the API-key row put a model catalogue
			// under a password field.
			const catalogue = pageOf(build(), 'Model');
			const desc = catalogue.desc;
			if (!(desc instanceof DocumentFragment)) {
				throw new Error('The catalogue carries no link');
			}
			const link = desc.querySelector('a');

			expect(link?.textContent).toBe('Whisper API models');
			expect(link?.getAttribute('href')).toBe(WHISPER_API_MODELS_DOC_URL);
		});

		it('offers a chunk size only on the engine that splits an upload', () => {
			// A limit is the engine's own fact, and so is the field holding the
			// chunk size, so no second engine can edit the first one's.
			expect(pageEntryNames('Whisper API (OpenAI-compatible)')).toContain(
				'Upload chunk size',
			);
			expect(pageEntryNames('Deepgram')).not.toContain(
				'Upload chunk size',
			);
		});

		it('leaves each use holding only the choice', () => {
			expect(childNamesOf('Transcription')).toContain(
				'Transcription engine',
			);
			// The engine is picked here; how much it may write is its own.
			expect(childNamesOf('LLM post-processing').slice(0, 2)).toEqual([
				'Enable LLM post-processing',
				'Post-processing engine',
			]);
			expect(childNamesOf('LLM post-processing')).not.toContain(
				'Max output tokens',
			);
			// The key and the endpoint are the provider's, not the use's.
			expect(childNamesOf('LLM post-processing')).not.toContain(
				'LLM credentials',
			);
			expect(childNamesOf('Transcription')).not.toContain(
				'Transcription engine credentials',
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

		it('leaves the transcription page holding blocks and entries only', () => {
			for (const item of pageOf(build(), 'Transcription').items) {
				expect('type' in item && item.type).toMatch(/group|page/);
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

	describe('dropdown options', () => {
		/**
		 * Every dropdown whose options are a settled label map, paired with the
		 * map they have to be. Each of these used to be spelled out as the same
		 * map taken apart into value/label pairs and put back together, which is
		 * a second copy of a list that already exists - and one that drifts the
		 * moment a label is added on one side only.
		 */
		const labelledDropdowns: ReadonlyArray<{
			heading: string;
			name: string;
			labels: Record<string, string>;
		}> = [
			{
				heading: 'Output format',
				name: 'Update links after conversion',
				labels: CONVERSION_LINK_ACTION_LABELS,
			},
			{
				heading: 'Audio input',
				name: 'Recording channels',
				labels: CHANNEL_MODE_LABELS,
			},
			{
				heading: 'Transcription',
				name: 'Transcription engine',
				labels: TRANSCRIPTION_PROVIDER_LABELS,
			},
			{
				heading: 'Transcript output',
				name: 'Destination',
				labels: TRANSCRIPT_DESTINATION_LABELS,
			},
			{
				heading: 'Transcript output',
				name: 'File format',
				labels: TRANSCRIPT_FILE_FORMAT_LABELS,
			},
			{
				heading: 'LLM post-processing',
				name: 'Task',
				labels: LLM_TASK_LABELS,
			},
		];

		it.each(labelledDropdowns)(
			'offers $name exactly what its label map holds',
			({ heading, name, labels }) => {
				const control = rowOf(build(), heading, name).control;

				expect(control?.options).toEqual(labels);
			},
		);

		it('offers the same engines on every row that picks one', () => {
			// Three jobs pick an engine, on three pages. They are the same
			// engines, so the list of them belongs in one place rather than
			// once per row.
			settings.transcriptionEnabled = true;
			settings.transcriptionAdvancedSettingsEnabled = true;
			settings.transcriptionAdvancedEnabled = true;
			settings.transcriptionAutoChaptersEnabled = true;
			const definitions = build();
			const engineRows = [
				rowOf(
					definitions,
					'LLM post-processing',
					'Post-processing engine',
				),
				rowOf(definitions, 'Auto chapters', 'Chapters engine'),
				rowOf(definitions, 'Advanced', 'Context agents engine'),
			];

			for (const row of engineRows) {
				expect(row.control?.options).toEqual(LLM_PROVIDER_LABELS);
			}
		});
	});

	describe('numeric bounds', () => {
		/** The bounds one number control declares, with the row it belongs to. */
		interface NumericBounds {
			name: string;
			min: number | undefined;
			max: number | undefined;
			step: number | undefined;
		}

		/** Every number control in the tree, with the row that declares it. */
		const numberControls = (): NumericBounds[] => {
			const found: NumericBounds[] = [];
			const walk = (
				entries: ReadonlyArray<RowDefinition | GroupDefinition>,
			): void => {
				for (const entry of entries) {
					if ('type' in entry) {
						walk(entry.items);
						continue;
					}
					if (entry.control?.type === 'number') {
						found.push({
							name: entry.name,
							min: entry.control.min as number | undefined,
							max: entry.control.max as number | undefined,
							step: entry.control.step as number | undefined,
						});
					}
				}
			};
			walk(build() as ReadonlyArray<RowDefinition | GroupDefinition>);
			return found;
		};

		it('declares every bound on the grid its own step describes', () => {
			// A number control's step is its value space, not a convenience for
			// the stepper arrows: the framework offers exactly `min + n * step`
			// and refuses everything between. A ceiling off that grid is a value
			// the field shows, the arrows cannot reach, and typing will not
			// save - which is what a 512-token grid ending at 32000 was.
			//
			// Asked through the rule the renderers apply, so a grid of tenths
			// is judged the way it is enforced rather than by an exact modulo
			// that binary arithmetic fails for values the field does accept.
			const unreachable = numberControls().filter((control) =>
				[control.min, control.max].some(
					(bound) =>
						bound !== undefined &&
						numberControlRejection(control, bound) !== undefined,
				),
			);

			expect(unreachable).toEqual([]);
		});

		it('finds every numeric row, so the invariant covers the tree', () => {
			expect(numberControls().length).toBeGreaterThan(5);
		});

		it('accepts the ceiling of the answer budget an engine may write', () => {
			// The reported defect: the row showed 32000 and refused to store it.
			const row = rowIn(
				pageOf(build(), 'Anthropic (Claude)'),
				'Max output tokens',
			);

			expect(
				numberControlRejection(
					row.control as {
						min?: number;
						max?: number;
						step?: number;
					},
					MAX_LLM_MAX_TOKENS,
				),
			).toBeUndefined();
		});

		it('accepts the round numbers a model catalogue quotes', () => {
			const row = rowIn(pageOf(build(), 'OpenAI'), 'Max output tokens')
				.control as { min?: number; max?: number; step?: number };

			for (const tokens of [4000, 8000, 16000, 32000]) {
				expect(numberControlRejection(row, tokens)).toBeUndefined();
			}
		});
	});

	describe('numberControlRejection', () => {
		it('accepts a value inside the bounds and on the grid', () => {
			expect(
				numberControlRejection({ min: 1, max: 60, step: 1 }, 20),
			).toBeUndefined();
		});

		it('refuses a value below the floor or above the ceiling', () => {
			expect(
				numberControlRejection({ min: 1, max: 60, step: 1 }, 0),
			).toBeDefined();
			expect(
				numberControlRejection({ min: 1, max: 60, step: 1 }, 61),
			).toBeDefined();
		});

		it('refuses a value between two grid points', () => {
			expect(
				numberControlRejection({ min: 20, max: 300, step: 5 }, 137),
			).toBeDefined();
			expect(
				numberControlRejection({ min: 20, max: 300, step: 5 }, 135),
			).toBeUndefined();
		});

		it('accepts a grid point binary arithmetic cannot land on exactly', () => {
			// 0.5 + 7 * 0.05 is not 0.85 in floating point, so the question is
			// asked of the nearest grid point rather than of the quotient.
			expect(
				numberControlRejection({ min: 0.5, max: 1, step: 0.05 }, 0.85),
			).toBeUndefined();
			expect(
				numberControlRejection({ min: 0.5, max: 1, step: 0.05 }, 0.87),
			).toBeDefined();
		});

		it('constrains nothing where no grid is declared', () => {
			expect(
				numberControlRejection({ min: 1, max: 60 }, 20.5),
			).toBeUndefined();
			expect(
				numberControlRejection({ min: 1, max: 60, step: 'any' }, 20.5),
			).toBeUndefined();
		});

		it('refuses what is not a number at all', () => {
			expect(
				numberControlRejection(
					{ min: 1, max: 60, step: 1 },
					Number.NaN,
				),
			).toBeDefined();
		});
	});
});
