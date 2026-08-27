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
	requireApiVersion,
	setIcon,
} from 'obsidian';
import type { Plugin } from 'obsidian';
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
	controlValue,
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
	audioDeviceApi,
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
import {
	addProfile,
	createProfile,
	findProfile,
	freeProfileName,
	moveProfile,
	profileNameRejection,
	profilesOfKind,
	removeAndReselectProfile,
	selectedProfileId,
	setSelectedProfileId,
	NEW_PROFILE_NAME,
	type Profile,
	type ProfileKindId,
} from './profiles';
import { PROFILE_KINDS, type ProfileKind } from './profileKinds';
import { ProfileNameModal } from '../ui/ProfileNameModal';
import { closeSettingsPage } from '../obsidian/settingsNavigation';
import { ENGINES, type EngineId } from '../providers/providers';
import {
	applyEngineSettingsField,
	engineFieldOf,
	engineSettingsStore,
	type EngineSettingsStore,
} from '../providers/engineSettings';
import { ModelIdModal } from '../ui/ModelIdModal';
import type { SettingsSectionContext } from './settingControls';
import { isMultiTrackCaptureSupported } from '../platform/capabilities';

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
	/**
	 * Latest device refresh generation; older async results are discarded.
	 *
	 * This is also what stops a result landing on a tab that has been left:
	 * `hide()` bumps the generation, so everything in flight at that moment is
	 * already stale by the time it resolves. A second "is the tab shown" flag
	 * beside it would be the same guard written twice, and the two could
	 * disagree.
	 */
	private deviceRefreshGeneration = 0;
	/** Latest format-availability probe; older async results are discarded. */
	private formatAvailabilityGeneration = 0;
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
	private readonly profileAccess = new Map<string, ProfileKindId>();

	/**
	 * Base control keys addressing whether a profile is the selected one. The
	 * row is a toggle per profile, so the value is a comparison against the
	 * stored selection rather than a field of the profile.
	 */
	private readonly profileSelections = new Map<string, ProfileKindId>();

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
		// Obsidian 1.13 is where the declarative settings API begins, and with
		// it SettingTab.update(), the framework's own re-render of the
		// definitions. The typings declare that method unconditionally, so the
		// running app is what has to be asked; below 1.13 the answer selects
		// the imperative mode, which is what keeps the tab working down to
		// minAppVersion. The re-render itself stays a call on the instance, so
		// the framework - or a test double standing in for it - always drives
		// its own pass.
		this.renderMode = createSettingsRenderMode({
			frameworkUpdate: requireApiVersion('1.13.0')
				? (): void => {
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
				// The tab's "it reached the screen" signal, which is why this
				// row stays first and stays a render row. From 1.13 nothing
				// else says so: display() is not called, and
				// getSettingDefinitions() also runs once at plugin load to
				// index the settings search, so enumerating there would leave
				// a device listener open on a tab nobody opened. A render
				// callback runs only when rows are actually drawn, which is
				// exactly the question being asked.
				this.ensureDeviceWatch();
				this.renderDocumentationLink(host);
			},
			devices: {
				enumerated: this.deviceSnapshot.enumerationSucceeded,
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
			// Every kind of profile is built the same way, from the one list
			// that describes them, so a kind added there arrives with the same
			// rules rather than with a block of its own here.
			profiles: PROFILE_KINDS.map((kind) => this.profileCatalogue(kind)),
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
				// One mechanism for every catalogue: the page names the engine
				// it belongs to and that engine's own store performs the edit,
				// so the tab needs no idea which provider or which capability
				// asked, and never writes half of one.
				addModel: (engine): void => {
					new ModelIdModal(this.app, (id) => {
						void this.engineSettings(engine).addModel(id);
					}).open();
				},
				removeModel: (engine, model): void => {
					void this.engineSettings(engine).removeModel(model);
				},
				selectModel: (engine, model): void => {
					void this.engineSettings(engine).selectModel(model);
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
			return field.profile?.body ?? '';
		}
		const selection = this.profileSelectionFor(key);
		if (selection) {
			return (
				selectedProfileId(this.plugin.settings, selection.kind) ===
				selection.id
			);
		}
		const picker = this.profileSelections.get(key);
		if (picker) {
			// The catalogue's own dropdown, which names a kind rather than one
			// profile of it. A stale stored id reads as None, so the row never
			// shows an option the list no longer offers.
			return selectedProfileId(this.plugin.settings, picker);
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
		// A dropdown over a numeric setting reads it as the option value it
		// offers, which is that number written out.
		return controlValue.read(key, stored);
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
				field.profile.body = String(value);
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
				setSelectedProfileId(settings, selection.kind, selection.id);
			} else if (
				selectedProfileId(settings, selection.kind) === selection.id
			) {
				setSelectedProfileId(settings, selection.kind, '');
			}
			// Every entry of the catalogue says whether it is the one in use,
			// so the tree is read again rather than re-evaluated in place.
			return this.commit();
		}
		const picker = this.profileSelections.get(key);
		if (picker) {
			// The dropdown picks among the kind's profiles, so it writes the
			// same selection the per-profile toggle does; '' is its None.
			setSelectedProfileId(this.plugin.settings, picker, String(value));
			return this.commit();
		}
		const track = parseTrackControlKey(key);
		if (track) {
			this.writeTrackSource(track.track, track.field, String(value));
			return this.plugin.saveSettings();
		}
		const effect = CONTROL_WRITE_EFFECTS[key];
		const settings = this.plugin.settings as unknown as Record<
			string,
			unknown
		>;
		const stored = controlValue.write(key, value, settings[key]);
		// A field an engine owns is written by that engine rather than into the
		// settings object behind its back, so a row on an engine's page and an
		// edit from a dialog go through the same writer and the same rules -
		// among them that a catalogue always offers the id it names.
		const engineField = engineFieldOf(key);
		if (engineField) {
			applyEngineSettingsField(this.plugin.settings, engineField, stored);
		} else {
			settings[key] = stored;
		}
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
	 * The profile whose body a control key addresses. The key names the kind
	 * the field belongs to and the profile it belongs to, so a row on one
	 * profile's page can never write to another's.
	 * @param key - The control key to resolve
	 * @returns The profile, or undefined for any other key. The `profile` is
	 * undefined when the key addresses a kind that no longer holds this id.
	 */
	private profileFieldFor(
		key: string,
	): { profile: Profile | undefined } | undefined {
		const parsed = parseProfileControlKey(key);
		const kind = parsed && this.profileAccess.get(parsed.base);
		if (!parsed || !kind) {
			return undefined;
		}
		const profile = findProfile(this.plugin.settings.profiles, parsed.id);
		return { profile: profile?.kind === kind ? profile : undefined };
	}

	/**
	 * The profile a selection toggle addresses.
	 * @param key - The control key to resolve
	 * @returns The kind and the id the toggle speaks for, or undefined for any
	 * other key
	 */
	private profileSelectionFor(
		key: string,
	): { kind: ProfileKindId; id: string } | undefined {
		const parsed = parseProfileControlKey(key);
		const kind = parsed && this.profileSelections.get(parsed.base);
		if (!parsed || !kind) {
			return undefined;
		}
		return { kind, id: parsed.id };
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
	 * One profile catalogue for the definitions: the kind's copy, the control
	 * keys its rows bind to, and the add, rename and remove edits, all over the
	 * list the kind names. Every kind goes through here, so they cannot drift.
	 * @param kind - The kind of profile being described
	 */
	private profileCatalogue(kind: ProfileKind): ProfileCatalogue {
		const kindId = kind.id;
		const ofKind = (): Profile[] =>
			profilesOfKind(this.plugin.settings.profiles, kindId);
		this.profileAccess.set(kind.bodyKey, kindId);
		this.profileSelections.set(kind.selectionKey, kindId);
		const rejection = (id: string, name: string): string | undefined =>
			profileNameRejection(
				this.plugin.settings.profiles,
				kindId,
				id,
				name,
			);
		return {
			section: kind.section,
			heading: kind.heading,
			selectorDesc: kind.catalogueDesc,
			bodyName: kind.bodyName,
			bodyDesc: kind.bodyDesc,
			selectionName: kind.selectionName,
			selectionDesc: kind.selectionDesc,
			selectedId: (settings) => selectedProfileId(settings, kindId),
			selectionKey: kind.selectionKey,
			bodyKey: kind.bodyKey,
			entries: (settings) =>
				profilesOfKind(settings.profiles, kindId).map((profile) => ({
					id: profile.id,
					name: profile.name,
					summary:
						profile.id === selectedProfileId(settings, kindId)
							? `In use, ${kind.summary(profile)}`
							: kind.summary(profile),
				})),
			visible: kind.visible,
			add: (): void => {
				const settings = this.plugin.settings;
				const created = createProfile(
					kindId,
					freeProfileName(ofKind(), NEW_PROFILE_NAME),
				);
				// Asked of the catalogue as it stands, before the new profile
				// joins it: what decides whether the profile is adopted is
				// whether there was anything to use in the first place.
				const hadNothingToUse =
					ofKind().length === 0 &&
					selectedProfileId(settings, kindId) === '';
				settings.profiles = addProfile(settings.profiles, created);
				// Adding a profile must not silently change which one a run
				// uses; only a catalogue with nothing usable selected adopts it.
				if (hadNothingToUse) {
					setSelectedProfileId(settings, kindId, created.id);
				}
				void this.commit();
			},
			rename: (id): void => {
				const profile = findProfile(ofKind(), id);
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
						void this.commit().then(() => {
							// The page is addressed by the name it just lost,
							// so it cannot stay open on it.
							closeSettingsPage(this.app);
						});
					},
				}).open();
			},
			reorder: (from, to): void => {
				const settings = this.plugin.settings;
				const profiles = settings.profiles;
				const moved = moveProfile(profiles, kindId, from, to);
				// A drop that changes nothing - the same position, or an index
				// the list does not hold - is not a write.
				if (
					moved.every((profile, index) => profile === profiles[index])
				) {
					return;
				}
				settings.profiles = moved;
				void this.commit();
			},
			remove: (id): void => {
				const profile = findProfile(ofKind(), id);
				if (!profile) {
					return;
				}
				removeAndReselectProfile(
					this.plugin.settings,
					kindId,
					profile.id,
				);
				void this.commit().then(() => {
					// Deleted from its own page, which the framework addresses
					// by a name that resolves to nothing now.
					closeSettingsPage(this.app);
				});
			},
		};
	}

	/**
	 * One engine's own settings store, bound to this tab's way of persisting: a
	 * change is written by the engine that owns the fields, saved, and the tree
	 * read again, because an engine's entry says what it is configured with.
	 * @param id - The engine being configured
	 */
	private engineSettings(id: EngineId): EngineSettingsStore {
		return engineSettingsStore(
			id,
			() => this.plugin.settings,
			() => this.commit(),
		);
	}

	/**
	 * Persists a change and reads the definition tree again.
	 *
	 * What every edit that moves what other rows *show* needs, as opposed to
	 * whether they show: a model put to work, a profile added, renamed, or
	 * removed, a recording format that rewrites the summary beneath it. The
	 * rows are the same rows holding something else, which no predicate
	 * expresses, so they are read again rather than re-evaluated in place.
	 */
	private commit(): Promise<void> {
		return this.plugin.saveSettings().then(() => {
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
		// Absent outside a secure context and in some embedded WebViews. This
		// runs from the first row the tab renders, so reading through it
		// unguarded took the whole tab down - every setting, including the ones
		// that have nothing to do with audio devices. Without a device list
		// there is nothing to watch; the rows below still report that the
		// enumeration failed.
		const devices = audioDeviceApi();
		if (devices && !this.deviceChangeHandler) {
			this.deviceChangeHandler = (): void => {
				void this.refreshDeviceList();
			};
			devices.addEventListener('devicechange', this.deviceChangeHandler);
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
				// The summary row reads this, and the format list may need a
				// fallback note, so the tree is rebuilt rather than patched.
				await this.commit();
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
		if (generation !== this.formatAvailabilityGeneration) {
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
		if (generation !== this.formatAvailabilityGeneration) {
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
		if (generation !== this.deviceRefreshGeneration) {
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
		const devices = audioDeviceApi();
		if (devices && this.deviceChangeHandler) {
			devices.removeEventListener(
				'devicechange',
				this.deviceChangeHandler,
			);
		}
		this.deviceChangeHandler = null;
	}
}
