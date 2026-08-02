/**
 * Settings tab for the Audio Recorder plugin.
 *
 * The tab itself is described as data in
 * {@link module:settings/settingsDefinitions}; what lives here is everything
 * that tree needs from the plugin. Three things, in order of weight. The
 * version split: which Obsidian is running decides who renders the tree, and
 * {@link module:settings/settingsRenderMode} answers that once, in the
 * constructor. The value hooks: `getControlValue`/`setControlValue` are how
 * every control reads and writes, routed through `plugin.saveSettings()` so a
 * Map-valued setting survives, the per-platform write-back happens, and the
 * recording manager and player registrar hear about the change. And the
 * handlers the declarations call into - the list edits, the diagnostics
 * actions, and the few bodies no control type covers.
 * @module settings/SettingsTab
 */

import {
	App,
	DropdownComponent,
	PluginSettingTab,
	Setting,
	TFolder,
	Vault,
	debounce,
	setIcon,
} from 'obsidian';
import type { Plugin, SettingTab } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import {
	createSettingsRenderMode,
	type SettingsRenderMode,
} from './settingsRenderMode';
import {
	CONTROL_WRITE_EFFECTS,
	SETTINGS_TAB_CLASS,
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	parseProfileControlKey,
	parseTrackControlKey,
	type ProfileCatalogue,
} from './settingsDefinitions';
import { LegacySettingsRenderer } from './legacySettingsRenderer';
import type { AudioRecorderSettings } from './settingsSchema';
import {
	getSupportedSampleRates,
	buildMimeType,
	listFormatAvailability,
	resolveEffectiveOutputFormat,
	type FormatAvailabilityEntry,
} from '../audio/AudioCapabilityDetector';
import { AUDIO_FORMAT_IDS } from '../audio/formatRegistry';
import { isOfflineEncodingSupported } from '../audio/AudioEncoder';
import { CHANNEL_MODE_SOURCE, normalizeChannelMode } from '../audio/downmix';
import {
	channelSelectionAvailable,
	getAudioInputDeviceSnapshot,
	type AudioInputDeviceSnapshot,
} from '../recording/AudioStreamHandler';
import { getEncoderDescription } from '../ui/formatDescriptions';
import { TestRecorder } from '../recording/TestRecorder';
import { TextInputSuggest } from '../ui/TextInputSuggest';
import { DOCS_URL, FORMAT_WAV } from '../constants';
import { SystemDiagnostics } from '../diagnostics/SystemDiagnostics';
import { SystemInfoModal } from '../diagnostics/SystemInfoModal';
import {
	renderLocalWhisperSettings,
	renderProviderKeyField,
} from './sections/transcriptionEngineSection';
import { addModelToList, removeModelFromList } from './modelList';
import {
	addProfile,
	effectiveProfileId,
	findProfile,
	freeProfileName,
	removeAndReselectProfile,
	NEW_PROFILE_NAME,
	type Profile,
	type ProfileList,
} from './profiles';
import { ProfileNameModal } from '../ui/ProfileNameModal';
import { closeSettingsPage } from '../obsidian/settingsNavigation';
import { ENGINES, type ProviderModels } from '../providers/providers';
import { parseDictionary } from '../transcription/dictionary';
import { DICTIONARY_PROFILES } from './dictionaryProfiles';
import { CHAPTER_PROMPT_PROFILES } from './chapterPromptProfiles';

/**
 * The half of an engine or vendor descriptor a saved model list is edited
 * through: both name the same four operations over their own settings keys.
 */
interface ModelListAccess {
	models(settings: AudioRecorderSettings): string[];
	setModels(settings: AudioRecorderSettings, ids: string[]): void;
	model(settings: AudioRecorderSettings): string;
	setModel(settings: AudioRecorderSettings, id: string): void;
}
import { ModelIdModal } from '../ui/ModelIdModal';
import type { SettingsSectionContext } from './settingControls';

import {
	isAutoSplitSupported,
	isMultiTrackCaptureSupported,
} from '../platform/capabilities';

/** Debounce delay for saving text settings, in milliseconds. */
const TEXT_SETTING_SAVE_DEBOUNCE_MS = 500;

/** Duration of the diagnostics test recording, in milliseconds. */
const TEST_RECORDING_DURATION_MS = 5000;

/**
 * Plugin interface for settings tab.
 */
export interface AudioRecorderPluginInterface extends Plugin {
	settings: AudioRecorderSettings;
	saveSettings(): Promise<void>;
}

/**
 * A catalogue's fields, as the list edits read and write them. The page hands
 * back the provider capability it belongs to, so the tab edits any catalogue
 * through one path instead of resolving "the selected engine" first.
 * @param models - The catalogue's own settings fields
 */
function modelListAccess(models: ProviderModels): ModelListAccess {
	return {
		models: models.models,
		setModels: models.setModels,
		model: models.model,
		setModel: models.setModel,
	};
}

/**
 * What a dictionary profile's entry says about it without being opened: the
 * number of terms a run would actually bias toward, counted the way the run
 * counts them, so a body of blank lines does not read as a full glossary.
 * @param terms - The profile's raw term text
 */
function termCountSummary(terms: string): string {
	const count = parseDictionary(terms).length;
	if (count === 0) {
		return 'No terms';
	}
	return count === 1 ? '1 term' : `${String(count)} terms`;
}

/**
 * What a chapter-guidance profile's entry says about it. The body is a
 * paragraph of instructions, so the entry reports whether there is one rather
 * than quoting the start of it.
 * @param prompt - The profile's guidance prompt
 */
function promptSummary(prompt: string): string {
	return prompt.trim() === '' ? 'No prompt' : 'Prompt set';
}

const EMPTY_DEVICE_SNAPSHOT: AudioInputDeviceSnapshot = {
	enumerationSucceeded: false,
	devices: [],
	channelLimits: new Map(),
};

/**
 * Settings tab for the Audio Recorder plugin.
 */
export class AudioRecorderSettingTab extends PluginSettingTab {
	plugin: AudioRecorderPluginInterface;
	private readonly testRecorder = new TestRecorder();
	private testAudioElement: HTMLAudioElement | null = null;
	/**
	 * Device-change listener active while the settings tab is open.
	 * Registered via addEventListener so other consumers of the event
	 * are not overwritten, and removed in hide() so the handler cannot
	 * outlive the tab (or the plugin).
	 */
	private deviceChangeHandler: (() => void) | null = null;
	/**
	 * Maximum capture channels per device id (null = unknown), read
	 * from device capabilities without opening the microphone. Channel
	 * selectors consult this to grey themselves out for devices that
	 * positively report a single channel.
	 */
	private deviceSnapshot: AudioInputDeviceSnapshot = EMPTY_DEVICE_SNAPSHOT;
	/**
	 * The device list the tree was last built from, as a comparable string. A
	 * re-render enumerates again, so only a real change asks for another one.
	 */
	private deviceSignature = '';
	/** Latest device refresh generation; older async results are discarded. */
	private deviceRefreshGeneration = 0;
	/** Latest format-availability probe; older async results are discarded. */
	private formatAvailabilityGeneration = 0;
	/** Prevents a refresh from updating controls after the tab is hidden. */
	private isDisplayed = false;
	/**
	 * Debounced settings save shared by the text fields, which fire
	 * onChange on every keystroke and would otherwise rewrite data.json
	 * per character. Toggles, dropdowns, and sliders save directly.
	 */
	private readonly saveTextSettingDebounced = debounce(
		() => {
			void this.plugin.saveSettings();
		},
		TEXT_SETTING_SAVE_DEBOUNCE_MS,
		true,
	);

	/**
	 * How this tab reaches the screen on the running Obsidian: through the
	 * declarative definitions of 1.13+, or through display() below it. Chosen
	 * once here - the app version cannot change under a live tab - so nothing
	 * else in the tab has to know which Obsidian it is on.
	 */
	private readonly renderMode: SettingsRenderMode;

	/**
	 * Renders the definition tree on the Obsidian that has no declarative
	 * settings API. Holds the rendered rows, so it can re-evaluate their
	 * predicates and run their cleanups the way the framework does.
	 */
	private readonly legacyRenderer = new LegacySettingsRenderer(this, {
		// The folder control is native from 1.13 on; below it, the tab's own
		// suggester is what puts the vault's folders under the field.
		attachFolderSuggest: (inputEl: HTMLInputElement): void => {
			new TextInputSuggest(this.app, inputEl, () =>
				this.getFolderOptions(),
			);
		},
	});

	/**
	 * Keys whose control is a text field, collected from the definition tree on
	 * every build. Their writes are debounced: a text control fires a change per
	 * keystroke, and each one would otherwise rewrite data.json.
	 */
	private debouncedControlKeys: ReadonlySet<string> = new Set();

	/**
	 * Base control keys addressing the body of a profile. A profile is an entry
	 * in a stored list rather than a settings property, so the key its page
	 * carries names the field here and the profile by id.
	 */
	private readonly profileAccess = new Map<
		string,
		{
			list: ProfileList<Profile>;
			read: (profile: Profile) => string;
			write: (profile: Profile, value: string) => void;
		}
	>();

	/**
	 * Base control keys addressing whether a profile is the selected one. The
	 * row is a toggle per profile, so the value is a comparison against the
	 * stored selection rather than a field of the profile.
	 */
	private readonly profileSelections = new Map<
		string,
		ProfileList<Profile>
	>();

	/**
	 * Creates a new AudioRecorderSettingTab.
	 * @param app - The Obsidian App instance
	 * @param plugin - The plugin instance
	 */
	constructor(app: App, plugin: AudioRecorderPluginInterface) {
		super(app, plugin);
		this.plugin = plugin;
		// The container belongs to this tab on both Obsidians and survives every
		// render, so it is where the stylesheet is told which settings are ours.
		this.containerEl.addClass(SETTINGS_TAB_CLASS);
		// SettingTab.update() is the 1.13 API this probe is looking for: the
		// typings declare it unconditionally, so only the runtime tells the two
		// versions apart. Its absence selects the imperative mode, which is
		// what keeps the tab working down to minAppVersion. The call itself
		// stays on the instance, so the framework - or a test double standing
		// in for it - always drives its own re-render.
		const hasFrameworkUpdate =
			// eslint-disable-next-line obsidianmd/no-unsupported-api -- probing for the 1.13 API is how the pre-1.13 fallback is chosen; the call below is guarded by this result
			typeof (this as Partial<SettingTab>).update === 'function';
		this.renderMode = createSettingsRenderMode({
			frameworkUpdate: hasFrameworkUpdate
				? (): void => {
						// eslint-disable-next-line obsidianmd/no-unsupported-api -- reached only when the probe above found update(), i.e. on Obsidian 1.13+
						this.update();
					}
				: undefined,
			buildDefinitions: (): SettingDefinitionItem[] =>
				this.buildDefinitions(),
			renderLegacy: (): void => {
				this.renderLegacy();
			},
		});
	}

	/**
	 * Builds the tab's definition tree and notes which of its controls are text
	 * fields, so their writes can be debounced.
	 * @returns The definitions, in render order
	 */
	private buildDefinitions(): SettingDefinitionItem[] {
		const definitions = buildSettingsDefinitions({
			settings: this.plugin.settings,
			sampleRates: getSupportedSampleRates(),
			outputFormat: {
				renderFormatRow: (setting): void => {
					this.renderFormatRow(setting);
				},
				renderSummaryRow: (setting): void => {
					this.renderSummaryRow(setting);
				},
			},
			// Asked per build: the answer depends on the platform, which a tab
			// outlives, and the tree is rebuilt for every pass anyway.
			declareListAddRow: !this.renderMode.rendersListAddRow(),
			renderDocumentationLink: (host): void => {
				// The first row of every pass, and the one place that knows the
				// tab is on screen on both render paths.
				this.ensureDeviceWatch();
				this.renderDocumentationLink(host);
			},
			devices: {
				inputs: Object.fromEntries(
					this.deviceSnapshot.devices.map((device) => [
						device.deviceId,
						device.label ||
							`Audio device ${device.deviceId.substring(0, 8)}`,
					]),
				),
				channelSelectable: (deviceId): boolean => {
					if (!deviceId) {
						return false;
					}
					const { enumerationSucceeded, channelLimits } =
						this.deviceSnapshot;
					// An enumeration that failed says nothing about the device,
					// so the choice stays open rather than silently locked.
					return (
						!enumerationSucceeded ||
						(channelLimits.has(deviceId) &&
							channelSelectionAvailable(
								channelLimits.get(deviceId),
							))
					);
				},
			},
			profiles: {
				dictionary: this.profileCatalogue(DICTIONARY_PROFILES, {
					heading: 'Dictionary profiles',
					selectorDesc:
						'Named glossaries of names, abbreviations, and domain terms. Pick one, or None, per run in the Transcribe dialog.',
					bodyName: 'Terms',
					bodyDesc:
						'One term per line. A term may contain spaces; blank lines and case-insensitive duplicates are ignored.',
					selectionName: 'Use by default',
					selectionDesc:
						'Offer this glossary in the Transcribe dialog. Turning it off leaves the run starting from None.',
					selectionKey: 'transcriptionDictionaryProfileId',
					bodyKey: 'dictionaryProfile.terms',
					visible: (settings) =>
						settings.transcriptionEnabled &&
						settings.transcriptionAdvancedSettingsEnabled,
					body: (profile) => profile.terms,
					setBody: (profile, value) => (profile.terms = value),
					summary: (profile) => termCountSummary(profile.terms),
				}),
				chapters: this.profileCatalogue(CHAPTER_PROMPT_PROFILES, {
					heading: 'Chapter guidance profiles',
					selectorDesc:
						'Named prompts describing how to divide a recording into chapters. The response format is fixed, so editing one is safe.',
					bodyName: 'Guidance prompt',
					bodyDesc:
						'How to divide the recording into chapters. Appended to the fixed base prompt; blank leaves the base behaviour.',
					selectionName: 'Use by default',
					selectionDesc:
						'Offer this prompt in the Transcribe dialog. Turning it off leaves the run on the base behaviour.',
					selectionKey: 'transcriptionChapterPromptProfileId',
					bodyKey: 'chapterProfile.prompt',
					visible: (settings) =>
						settings.transcriptionEnabled &&
						settings.transcriptionAutoChaptersEnabled,
					body: (profile) => profile.prompt,
					setBody: (profile, value) => (profile.prompt = value),
					summary: (profile) => promptSummary(profile.prompt),
				}),
			},
			transcriptionBlocks: {
				renderProviderKey: (host, engineId): void => {
					this.renderTranscriptionBlock(host, (ctx) => {
						renderProviderKeyField(ctx, ENGINES[engineId]);
					});
				},
				renderLocalWhisperFields: (host): void => {
					this.renderTranscriptionBlock(
						host,
						renderLocalWhisperSettings,
					);
				},
				// One mechanism for every catalogue: the page hands back the
				// fields it belongs to, so the tab needs no idea which provider
				// or which capability asked.
				addModel: (models): void => {
					this.addModelTo(modelListAccess(models));
				},
				removeModel: (models, index): void => {
					this.removeModelFrom(modelListAccess(models), index);
				},
				selectModel: (models, id): void => {
					this.selectModelIn(modelListAccess(models), id);
				},
			},
			diagnostics: {
				startTestRecording: (rowEl): void => {
					void this.runTestRecording(rowEl);
				},
				releaseTestRecording: (): void => {
					this.cleanupTestRecording();
				},
				showSystemInfo: (): void => {
					void SystemDiagnostics.collect(
						this.plugin.settings,
						this.app,
					).then((data) => {
						new SystemInfoModal(this.app, data).open();
					});
				},
			},
		});
		this.debouncedControlKeys = collectDebouncedControlKeys(definitions);
		return definitions;
	}

	/**
	 * Reads a control's value. Obsidian calls this on every render of a control
	 * definition on 1.13+, and the legacy renderer calls it for the same reason.
	 * @param key - The settings key the control is bound to
	 * @returns The stored value
	 */
	override getControlValue(key: string): unknown {
		const field = this.profileFieldFor(key);
		if (field) {
			// A profile deleted while its page was open leaves the controls of
			// that page standing until the page is torn down; an empty body is
			// what they read then.
			return field.profile ? field.access.read(field.profile) : '';
		}
		const selection = this.profileSelectionFor(key);
		if (selection) {
			return (
				selection.list.selectedId(this.plugin.settings) === selection.id
			);
		}
		const track = parseTrackControlKey(key);
		if (track) {
			const source = this.plugin.settings.trackAudioSources.get(
				track.track,
			);
			return track.field === 'deviceId'
				? (source?.deviceId ?? '')
				: (source?.channelMode ?? CHANNEL_MODE_SOURCE);
		}
		const stored = (
			this.plugin.settings as unknown as Record<string, unknown>
		)[key];
		// A feature switched on where the platform cannot honour it reads as
		// off, so the control never claims a result this device cannot give.
		// The stored value is left alone, so the setting survives a sync back
		// to a device that can.
		if (key === 'enableMultiTrack') {
			return stored === true && isMultiTrackCaptureSupported();
		}
		if (key === 'autoSplitEnabled') {
			return stored === true && isAutoSplitSupported();
		}
		return stored;
	}

	/**
	 * Persists a control's value.
	 *
	 * The inherited implementation writes `plugin.settings[key]` and then calls
	 * `plugin.saveData(settings)`, which is wrong for this plugin three times
	 * over: the settings hold a Map that JSON would flatten to `{}`, the device
	 * fields have to be written back into their per-platform branch, and the
	 * recording manager and the player registrar have to be told that settings
	 * changed. `saveSettings()` is what does all three, so every write goes
	 * through it.
	 * @param key - The settings key the control is bound to
	 * @param value - The value the control produced
	 */
	override setControlValue(
		key: string,
		value: unknown,
	): void | Promise<void> {
		const field = this.profileFieldFor(key);
		if (field) {
			if (field.profile) {
				field.access.write(field.profile, String(value));
			}
			// The body is a text area, so this fires per keystroke: the value
			// is live in memory either way, only the write to disk waits.
			this.saveTextSettingDebounced();
			return;
		}
		const selection = this.profileSelectionFor(key);
		if (selection) {
			const settings = this.plugin.settings;
			// Off means "no default of this kind", which is what the run-time
			// resolver reads as None. Turning another profile on moves the
			// selection; turning this one off only clears its own.
			if (value === true) {
				selection.list.setSelectedId(settings, selection.id);
			} else if (selection.list.selectedId(settings) === selection.id) {
				selection.list.setSelectedId(settings, '');
			}
			// Every entry of the catalogue says whether it is the one in use,
			// so the tree is read again rather than re-evaluated in place.
			return this.plugin.saveSettings().then(() => {
				this.rerender();
			});
		}
		const track = parseTrackControlKey(key);
		if (track) {
			this.writeTrackSource(track.track, track.field, String(value));
			return this.plugin.saveSettings();
		}
		const effect = CONTROL_WRITE_EFFECTS[key];
		(this.plugin.settings as unknown as Record<string, unknown>)[key] =
			effect?.normalize && typeof value === 'string'
				? effect.normalize(value)
				: value;
		effect?.follow?.(this.plugin.settings);
		if (this.debouncedControlKeys.has(key)) {
			// A text field changes on every keystroke. The value is live in
			// memory either way; only the write to disk waits.
			this.saveTextSettingDebounced();
			return;
		}
		const saved = this.plugin.saveSettings();
		if (!effect?.reshapesTree) {
			return saved;
		}
		// The rows this write changed are the rows already on screen, holding
		// something else now, so they are read again rather than re-evaluated.
		return saved.then(() => {
			this.rerender();
		});
	}

	private getCompressionDescription(format: string): string {
		const encoder = getEncoderDescription(format);
		if (format === FORMAT_WAV) {
			return `Uncompressed WAV (larger size). Encoder: ${encoder}.`;
		}
		if (
			isOfflineEncodingSupported(format) &&
			!this.isMediaRecorderFormat(format)
		) {
			return `Compressed audio via offline encoding. Encoder: ${encoder}.`;
		}
		return `Compressed audio (smaller size; saved directly from recorder output). Encoder: ${encoder}.`;
	}

	private isMediaRecorderFormat(format: string): boolean {
		if (typeof MediaRecorder === 'undefined') {
			return false;
		}
		return MediaRecorder.isTypeSupported(buildMimeType(format));
	}

	/**
	 * Gets folder options for autocomplete.
	 */
	getFolderOptions(): string[] {
		const folders: string[] = [];
		Vault.recurseChildren(this.app.vault.getRoot(), (file) => {
			if (file instanceof TFolder) {
				folders.push(file.path);
			}
		});
		return folders;
	}

	/**
	 * The profile body a control key addresses. The key names the field and the
	 * profile it belongs to, so a row on one profile's page can never write to
	 * another's.
	 * @param key - The control key to resolve
	 * @returns The field's accessors and the profile, or undefined for any
	 * other key. The profile is undefined when the key resolves to a kind of
	 * profile that no longer holds this id.
	 */
	private profileFieldFor(key: string):
		| {
				profile: Profile | undefined;
				access: {
					read: (profile: Profile) => string;
					write: (profile: Profile, value: string) => void;
				};
		  }
		| undefined {
		const parsed = parseProfileControlKey(key);
		const access = parsed && this.profileAccess.get(parsed.base);
		if (!parsed || !access) {
			return undefined;
		}
		return {
			profile: findProfile(
				access.list.get(this.plugin.settings),
				parsed.id,
			),
			access,
		};
	}

	/**
	 * The profile a selection toggle addresses.
	 * @param key - The control key to resolve
	 * @returns The profile list and the id the toggle speaks for, or undefined
	 * for any other key
	 */
	private profileSelectionFor(
		key: string,
	): { list: ProfileList<Profile>; id: string } | undefined {
		const parsed = parseProfileControlKey(key);
		const list = parsed && this.profileSelections.get(parsed.base);
		if (!parsed || !list) {
			return undefined;
		}
		return { list, id: parsed.id };
	}

	/**
	 * Writes one field of a track's audio source. The sources live in a Map
	 * keyed by track number, so a control key addresses an entry rather than a
	 * settings property; clearing the device drops the entry entirely.
	 * @param track - The track number the control belongs to
	 * @param field - Which half of the source the control writes
	 * @param value - The value the control produced
	 */
	private writeTrackSource(
		track: number,
		field: 'deviceId' | 'channelMode',
		value: string,
	): void {
		const sources = this.plugin.settings.trackAudioSources;
		const current = sources.get(track);
		if (field === 'channelMode') {
			if (!current) {
				// No device on this track: there is nothing to bind a layout to.
				return;
			}
			sources.set(track, {
				...current,
				channelMode: normalizeChannelMode(value),
			});
			return;
		}
		if (!value) {
			sources.delete(track);
			return;
		}
		// Keep the track's channel layout across a device swap.
		sources.set(track, {
			deviceId: value,
			channelMode: current?.channelMode ?? CHANNEL_MODE_SOURCE,
		});
	}

	/**
	 * Renders the tab into its own container. This is Obsidian's render call
	 * before 1.13; from 1.13 on the framework renders the tab from
	 * getSettingDefinitions() and never calls this.
	 */
	override display(): void {
		this.renderLegacy();
	}

	/**
	 * Declarative settings entry (Obsidian 1.13+): the tab's definition tree,
	 * which the framework renders, indexes for the settings search, and reads
	 * and writes values through. On older Obsidian the render mode returns no
	 * definitions, which is what makes that Obsidian call display() instead;
	 * both paths render the same tree.
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return this.renderMode.getDefinitions();
	}

	/**
	 * Renders the definition tree with the pre-1.13 API. The render call on
	 * older Obsidian, for the first render and for every re-render, since there
	 * is no framework update() to hand the work back to.
	 */
	private renderLegacy(): void {
		this.legacyRenderer.render(this.containerEl, this.buildDefinitions());
	}

	/**
	 * Re-renders the tab after a change that adds or removes settings (for
	 * example toggling multi-track or Save near active file), on whichever
	 * terms the running Obsidian sets.
	 */
	private rerender(): void {
		this.renderMode.rerender();
	}

	/**
	 * Builds one profile catalogue for the definitions: the list's copy, the
	 * control keys its editor rows bind to, and the add and remove edits, all
	 * over the profile list the caller names.
	 * @param list - Where this kind of profile lives in settings
	 * @param copy - The catalogue's copy, keys, visibility, and body accessors
	 */
	private profileCatalogue<T extends Profile>(
		list: ProfileList<T>,
		copy: {
			heading: string;
			selectorDesc: string;
			bodyName: string;
			bodyDesc: string;
			selectionName: string;
			selectionDesc: string;
			selectionKey: string;
			bodyKey: string;
			visible: (settings: AudioRecorderSettings) => boolean;
			body: (profile: T) => string;
			setBody: (profile: T, value: string) => void;
			summary: (profile: T) => string;
		},
	): ProfileCatalogue {
		this.profileAccess.set(copy.bodyKey, {
			list: list,
			read: (profile) => copy.body(profile as T),
			write: (profile, value) => {
				copy.setBody(profile as T, value);
			},
		});
		this.profileSelections.set(copy.selectionKey, list);
		const rejection = (id: string, name: string): string | undefined => {
			if (name === '') {
				return 'Give the profile a name.';
			}
			return list
				.get(this.plugin.settings)
				.some((profile) => profile.id !== id && profile.name === name)
				? 'Another profile already uses this name.'
				: undefined;
		};
		return {
			heading: copy.heading,
			selectorDesc: copy.selectorDesc,
			bodyName: copy.bodyName,
			bodyDesc: copy.bodyDesc,
			selectionName: copy.selectionName,
			selectionDesc: copy.selectionDesc,
			selectionKey: copy.selectionKey,
			bodyKey: copy.bodyKey,
			entries: (settings) =>
				list.get(settings).map((profile) => ({
					id: profile.id,
					name: profile.name,
					summary:
						profile.id === list.selectedId(settings)
							? `In use, ${copy.summary(profile)}`
							: copy.summary(profile),
				})),
			visible: copy.visible,
			add: (): void => {
				const created = addProfile(
					list.get(this.plugin.settings),
					list.create(
						freeProfileName(
							list.get(this.plugin.settings),
							NEW_PROFILE_NAME,
						),
					),
				);
				list.set(this.plugin.settings, created);
				// Adding a glossary must not silently change which one a run
				// uses; only a catalogue with nothing usable selected adopts it.
				if (
					effectiveProfileId(
						created,
						list.selectedId(this.plugin.settings),
					) === '' &&
					created.length === 1
				) {
					list.setSelectedId(
						this.plugin.settings,
						created[0]?.id ?? '',
					);
				}
				void this.plugin.saveSettings().then(() => {
					this.rerender();
				});
			},
			rename: (id): void => {
				const profile = findProfile(list.get(this.plugin.settings), id);
				if (!profile) {
					return;
				}
				new ProfileNameModal(this.app, {
					title: 'Rename profile',
					confirmText: 'Rename',
					initial: profile.name,
					rejection: (name) => rejection(id, name),
					onSubmit: (name) => {
						profile.name = name;
						void this.plugin.saveSettings().then(() => {
							this.rerender();
							// The page is addressed by the name it just lost,
							// so it cannot stay open on it.
							closeSettingsPage(this.app);
						});
					},
				}).open();
			},
			remove: (id): void => {
				const profile = findProfile(list.get(this.plugin.settings), id);
				if (!profile) {
					return;
				}
				removeAndReselectProfile(
					list,
					this.plugin.settings,
					profile.id,
				);
				void this.plugin.saveSettings().then(() => {
					this.rerender();
					// Deleted from its own page, which the framework addresses
					// by a name that resolves to nothing now.
					closeSettingsPage(this.app);
				});
			},
		};
	}

	/**
	 * Makes a saved id the one in use, which is what tapping a row of a model
	 * catalogue does now that the catalogue is the picker. The entry that opens
	 * it says which id is in use, so the tree is read again rather than
	 * re-evaluated in place.
	 * @param access - Reads and writes the list and its selection
	 * @param id - The id to transcribe (or answer) with from now on
	 */
	private selectModelIn(access: ModelListAccess, id: string): void {
		access.setModel(this.plugin.settings, id);
		void this.plugin.saveSettings().then(() => {
			this.rerender();
		});
	}

	/**
	 * Adds a model id to a saved list and selects it, which is what a list's add
	 * affordance does for both the engine and the LLM catalogues.
	 * @param access - Reads and writes the list and its selection
	 */
	private addModelTo(access: ModelListAccess): void {
		new ModelIdModal(this.app, (id) => {
			const settings = this.plugin.settings;
			access.setModels(
				settings,
				addModelToList(access.models(settings), id),
			);
			access.setModel(settings, id);
			void this.plugin.saveSettings().then(() => {
				this.rerender();
			});
		}).open();
	}

	/**
	 * Removes the model id at a position in a saved list. The list is the
	 * catalogue and the selection points into it, so dropping the selected id
	 * moves the selection rather than leaving it pointing at nothing.
	 * @param access - Reads and writes the list and its selection
	 * @param index - Position of the id to remove
	 */
	private removeModelFrom(access: ModelListAccess, index: number): void {
		const settings = this.plugin.settings;
		const models = access.models(settings);
		const removed = models[index];
		if (removed === undefined) {
			return;
		}
		const next = removeModelFromList(models, removed);
		access.setModels(settings, next);
		if (access.model(settings) === removed) {
			access.setModel(settings, next[0] ?? '');
		}
		void this.plugin.saveSettings().then(() => {
			this.rerender();
		});
	}

	/**
	 * Renders one transcription block that is not a definition yet, into the row
	 * its section keeps for it. A reveal inside the block redraws the block,
	 * which is confined to that row.
	 * @param host - The row element the block is rendered into
	 * @param render - Draws the block into the section context it is given
	 */
	private renderTranscriptionBlock(
		host: HTMLElement,
		render: (ctx: SettingsSectionContext) => void,
	): void {
		const draw = (): void => {
			host.empty();
			render({
				containerEl: host,
				settings: this.plugin.settings,
				save: () => this.plugin.saveSettings(),
				rerender: draw,
				saveDebounced: () => {
					this.saveTextSettingDebounced();
				},
			});
		};
		draw();
	}

	/**
	 * Starts watching the audio inputs while the tab is on screen. The device
	 * rows are built from the last enumeration, so the tab enumerates once per
	 * open and again whenever the system reports a change.
	 */
	private ensureDeviceWatch(): void {
		this.isDisplayed = true;
		if (!this.deviceChangeHandler) {
			this.deviceChangeHandler = (): void => {
				void this.refreshDeviceList();
			};
			navigator.mediaDevices.addEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
		}
		void this.refreshDeviceList();
	}

	/**
	 * Fills the recording-format row. The format list is rendered from the
	 * registry at once and the options this device cannot record are blocked by
	 * an asynchronous encoder probe, which no control type expresses.
	 * @param setting - The row to fill
	 */
	private renderFormatRow(setting: Setting): void {
		setting.addDropdown((dropdown) => {
			for (const format of AUDIO_FORMAT_IDS) {
				dropdown.addOption(format, format.toUpperCase());
			}
			// A stored format outside the registry (hand-edited or from a
			// future version) still needs an option so setValue holds it.
			const stored = this.plugin.settings.recordingFormat;
			if (!AUDIO_FORMAT_IDS.some((format) => format === stored)) {
				dropdown.addOption(stored, stored.toUpperCase());
			}
			dropdown.setValue(stored);
			dropdown.onChange(async (value) => {
				this.plugin.settings.recordingFormat = value;
				await this.plugin.saveSettings();
				// The summary row reads this, and the format list may need a
				// fallback note, so the tree is rebuilt rather than patched.
				this.rerender();
			});
			void this.applyFormatAvailability(dropdown, setting.descEl);
		});
	}

	/**
	 * Fills the row that summarises the effective output, which is derived from
	 * the format and bitrate rows rather than stored.
	 * @param setting - The row to fill
	 */
	private renderSummaryRow(setting: Setting): void {
		const format = this.plugin.settings.recordingFormat;
		const kbps = Math.round(this.plugin.settings.bitrate / 1000);
		setting.descEl
			.createDiv()
			.setText(
				`Output: ${format.toUpperCase()}, ${String(kbps)} kbps. ${this.getCompressionDescription(format)}`,
			);
	}

	/**
	 * Renders a compact callout at the top of the settings tab linking to the
	 * full online documentation, so the per-feature guides and use-case
	 * walkthroughs are one click away instead of requiring the user to find
	 * them in the GitHub repository.
	 * @param containerEl - The settings container element
	 */
	private renderDocumentationLink(containerEl: HTMLElement): void {
		const callout = containerEl.createDiv({ cls: 'aar-doc-callout' });
		const icon = callout.createSpan({ cls: 'aar-doc-callout-icon' });
		setIcon(icon, 'book-open');

		const body = callout.createDiv({ cls: 'aar-doc-callout-body' });
		body.createSpan({
			text:
				'New here or stuck on a setting? The full guides, setup ' +
				'walkthroughs, and use cases live in the docs. ',
		});
		const link = body.createEl('a', {
			text: 'Open the documentation',
			cls: 'aar-doc-callout-link',
			attr: {
				href: DOCS_URL,
				target: '_blank',
				rel: 'noopener',
			},
		});
		link.setAttribute(
			'aria-label',
			'Open the documentation in your browser',
		);
	}

	/**
	 * Applies the probed per-format recordability to the format
	 * dropdown: unavailable formats are blocked (visible but
	 * unselectable) and every option gets its accurate label. When the
	 * STORED format itself is blocked (a synced or stale preference),
	 * a note under the setting names the format recordings will fall
	 * back to, so the disabled selection never reads as "this is what
	 * you will get". Async because encoder support is probed for real;
	 * guarded by the display generation so a probe that resolves after
	 * the tab re-rendered or closed never touches stale controls.
	 * @param dropdown - The recording-format dropdown to annotate
	 * @param descEl - The setting's description element for the note
	 */
	private async applyFormatAvailability(
		dropdown: DropdownComponent,
		descEl: HTMLElement,
	): Promise<void> {
		const generation = ++this.formatAvailabilityGeneration;
		let entries: FormatAvailabilityEntry[];
		try {
			entries = await listFormatAvailability();
		} catch {
			// Probing failed entirely: leave the options selectable, the
			// recording-start validation still guards the session
			return;
		}
		if (
			!this.isDisplayed ||
			generation !== this.formatAvailabilityGeneration
		) {
			return;
		}
		for (const option of Array.from(dropdown.selectEl.options)) {
			const entry = entries.find(
				(candidate) => candidate.format === option.value,
			);
			if (!entry) {
				continue;
			}
			option.disabled = !entry.available;
			option.textContent = !entry.available
				? `${entry.format.toUpperCase()} (not supported on this device)`
				: entry.direct
					? entry.format.toUpperCase()
					: `${entry.format.toUpperCase()} (offline)`;
		}

		const stored = this.plugin.settings.recordingFormat;
		const storedEntry = entries.find((entry) => entry.format === stored);
		descEl.querySelector('.aar-format-fallback-note')?.remove();
		if (!storedEntry || storedEntry.available) {
			return;
		}
		// Built detached with createDiv, then appended to descEl below so the
		// note lands in the setting's own window (including a settings popout);
		// appendChild adopts the detached node into descEl's document.
		const note = createDiv({ cls: 'aar-format-fallback-note' });
		try {
			const effective = await resolveEffectiveOutputFormat(stored);
			note.textContent = `This device cannot record ${stored.toUpperCase()}; recordings are saved as ${effective.format.toUpperCase()} instead.`;
		} catch {
			note.textContent = `This device cannot record ${stored.toUpperCase()}. Select a different format.`;
		}
		if (
			!this.isDisplayed ||
			generation !== this.formatAvailabilityGeneration
		) {
			return;
		}
		descEl.appendChild(note);
	}

	/**
	 * Re-reads the audio inputs and asks for a re-render when they changed.
	 *
	 * The device-bound rows are declarations built from the last snapshot, so
	 * there is nothing to patch in place: either the list is the one the tree
	 * was built from, or the tree is stale and the framework rebuilds it.
	 */
	private async refreshDeviceList(): Promise<void> {
		const generation = ++this.deviceRefreshGeneration;
		const snapshot = await getAudioInputDeviceSnapshot();
		if (!this.isDisplayed || generation !== this.deviceRefreshGeneration) {
			return;
		}
		this.deviceSnapshot = snapshot;
		// Compared by content, because a render enumerates again and an
		// unconditional re-render would never settle.
		const signature = snapshot.devices
			.map((device) => `${device.deviceId}:${device.label}`)
			.join('|');
		if (signature === this.deviceSignature) {
			return;
		}
		this.deviceSignature = signature;
		this.rerender();
	}

	/**
	 * Runs a short test recording and plays back the result. The
	 * microphone stream is released in a finally block so an error in
	 * recorder setup (or the tab being hidden during the wait) can
	 * never leave the device captured.
	 * @param container - DOM element to append playback controls to
	 */
	private async runTestRecording(container: HTMLElement): Promise<void> {
		try {
			this.cleanupTestRecording();

			const result = await this.testRecorder.record(
				this.plugin.settings,
				TEST_RECORDING_DURATION_MS,
				() => {
					this.showTestStatus(
						container,
						'\u25CF Recording... (5 seconds)',
						false,
						'aar-test-recording',
					);
				},
			);

			if (result.kind === 'cancelled') {
				// The tab was hidden during the wait: cleanup already
				// discarded the recorder and the result has nowhere to go
				return;
			}
			if (result.kind === 'unsupported') {
				this.showTestStatus(
					container,
					`Format "${this.plugin.settings.recordingFormat}" is not supported in this browser.`,
					true,
				);
				return;
			}
			if (result.kind === 'empty') {
				this.showTestStatus(
					container,
					'Test recording produced no data. Try a different format or device.',
					true,
				);
				return;
			}

			const url = URL.createObjectURL(result.blob);

			this.showTestStatus(
				container,
				'\u2714 Test recording complete. Listen below:',
				false,
				'aar-test-success',
			);

			this.testAudioElement = container.createEl('audio', {
				attr: { controls: 'true', src: url },
			});
			this.testAudioElement.addClass('aar-test-audio');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			this.showTestStatus(
				container,
				`Test recording failed: ${message}`,
				true,
			);
		}
	}

	/**
	 * Displays test status message in the container.
	 */
	private showTestStatus(
		container: HTMLElement,
		message: string,
		isError: boolean,
		extraClass?: string,
	): void {
		const existingStatus = container.querySelector('.aar-test-status');
		if (existingStatus) {
			existingStatus.remove();
		}
		const existingAudio = container.querySelector('.aar-test-audio');
		if (existingAudio) {
			// Revoke the element's blob URL before dropping it: repeated
			// test recordings would otherwise leak one blob per rerun
			// until the settings tab is closed
			const src = existingAudio.getAttribute('src');
			if (src?.startsWith('blob:')) {
				URL.revokeObjectURL(src);
			}
			if (existingAudio === this.testAudioElement) {
				this.testAudioElement = null;
			}
			existingAudio.remove();
		}

		const statusEl = container.createDiv({ cls: 'aar-test-status' });
		statusEl.setText(message);
		if (isError) {
			statusEl.addClass('aar-test-error');
		}
		if (extraClass) {
			statusEl.addClass(extraClass);
		}
	}

	/**
	 * Removes test recording resources.
	 */
	private cleanupTestRecording(): void {
		this.testRecorder.cancel();

		if (this.testAudioElement) {
			const src = this.testAudioElement.src;
			if (src.startsWith('blob:')) {
				URL.revokeObjectURL(src);
			}
			this.testAudioElement.remove();
			this.testAudioElement = null;
		}
	}

	/**
	 * Cleans up test recording resources when settings tab is hidden,
	 * flushes a pending debounced text-setting save, and detaches the
	 * device-change listener registered in display().
	 */
	override hide(): void {
		this.isDisplayed = false;
		// Invalidate every in-flight enumeration and probe before
		// detaching controls.
		this.deviceRefreshGeneration++;
		this.formatAvailabilityGeneration++;
		this.saveTextSettingDebounced.run();
		// On the legacy path the renderer holds the rows and their cleanups;
		// releasing it is what runs them when the tab is left. On 1.13 the
		// framework runs them itself and this renderer holds nothing.
		this.legacyRenderer.release();
		this.cleanupTestRecording();
		if (this.deviceChangeHandler) {
			navigator.mediaDevices.removeEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
			this.deviceChangeHandler = null;
		}
	}
}
