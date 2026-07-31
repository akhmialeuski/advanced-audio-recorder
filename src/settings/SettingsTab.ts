/**
 * Settings tab UI for the Audio Recorder plugin.
 *
 * Rows that are plain toggles, dropdowns, text fields, or numeric inputs go
 * through the shared builders in `settingControls`, bound to the tab's save
 * hooks by {@link AudioRecorderSettingTab.sectionContext}. What stays
 * imperative here is what the declarative model does not cover: the device
 * dropdowns fed by live enumeration, the recording-format dropdown whose
 * options are blocked by an async encoder probe, the output summary that
 * recomputes from two other controls, the per-track rows built from a Map, the
 * part-suffix field with its own validation feedback, and the diagnostics
 * actions. The transcription settings live in their own section modules.
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
	buildSettingsDefinitions,
	collectDebouncedControlKeys,
	parseTrackControlKey,
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
	renderCloudEngineSettings,
	renderLocalWhisperSettings,
	renderWhisperChunkSize,
} from './sections/transcriptionEngineSection';
import {
	renderChapterPromptProfiles,
	renderDictionaryProfiles,
} from './sections/profileManagerSection';
import { renderLlmSection } from './sections/llmSettingsSection';
import { selectedTranscriptionEngine } from '../transcription/providers/engines';
import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
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

interface DeviceDropdownBinding {
	readonly dropdown: DropdownComponent;
	readonly getSelectedDeviceId: () => string;
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
	private deviceDropdowns: DeviceDropdownBinding[] = [];
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
	 * Re-evaluators for every channel-mode dropdown on the tab. Run
	 * after the capability map loads, after a device selection changes,
	 * and on devicechange events.
	 */
	private channelDropdownUpdaters: (() => void)[] = [];
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
	 * Creates a new AudioRecorderSettingTab.
	 * @param app - The Obsidian App instance
	 * @param plugin - The plugin instance
	 */
	constructor(app: App, plugin: AudioRecorderPluginInterface) {
		super(app, plugin);
		this.plugin = plugin;
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
			transcriptionBlocks: {
				renderEngineFields: (host): void => {
					this.renderTranscriptionBlock(host, (ctx) => {
						const engine = selectedTranscriptionEngine(
							ctx.settings,
						);
						if (
							ctx.settings.transcriptionProvider ===
							TRANSCRIPTION_PROVIDER_IDS.WHISPER_API
						) {
							renderWhisperChunkSize(ctx);
						}
						if (engine.credentials) {
							renderCloudEngineSettings(ctx, engine.credentials);
						} else {
							renderLocalWhisperSettings(ctx);
						}
					});
				},
				renderDictionaryProfiles: (host): void => {
					this.renderTranscriptionBlock(
						host,
						renderDictionaryProfiles,
					);
				},
				renderChapterProfiles: (host): void => {
					this.renderTranscriptionBlock(
						host,
						renderChapterPromptProfiles,
					);
				},
				renderLlmSection: (host): void => {
					this.renderTranscriptionBlock(host, renderLlmSection);
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
		const track = parseTrackControlKey(key);
		if (track) {
			this.writeTrackSource(track.track, track.field, String(value));
			return this.plugin.saveSettings();
		}
		(this.plugin.settings as unknown as Record<string, unknown>)[key] =
			value;
		if (this.debouncedControlKeys.has(key)) {
			// A text field changes on every keystroke. The value is live in
			// memory either way; only the write to disk waits.
			this.saveTextSettingDebounced();
			return;
		}
		return this.plugin.saveSettings();
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
	 * Runs every registered channel-dropdown re-evaluator.
	 */
	private runChannelDropdownUpdaters(): void {
		for (const update of this.channelDropdownUpdaters) {
			update();
		}
	}

	private async refreshDeviceList(): Promise<void> {
		const generation = ++this.deviceRefreshGeneration;
		const snapshot = await getAudioInputDeviceSnapshot();
		if (!this.isDisplayed || generation !== this.deviceRefreshGeneration) {
			return;
		}
		this.deviceSnapshot = snapshot;
		// The device-bound rows are built from this snapshot, so a changed
		// device list is a changed tree: ask for a re-render, which is the
		// documented way to react to state the settings tab does not own.
		// Compared by content, because a render enumerates again and an
		// unconditional re-render would never settle.
		const signature = snapshot.devices
			.map((device) => `${device.deviceId}:${device.label}`)
			.join('|');
		if (signature !== this.deviceSignature) {
			this.deviceSignature = signature;
			this.rerender();
			return;
		}
		if (snapshot.enumerationSucceeded) {
			for (const binding of this.deviceDropdowns) {
				const { dropdown } = binding;
				dropdown.selectEl.empty();
				for (const device of snapshot.devices) {
					const label =
						device.label ||
						`Audio device ${device.deviceId.substring(0, 8)}`;
					dropdown.addOption(device.deviceId, label);
				}
				const selectedDeviceId = binding.getSelectedDeviceId();
				const isPresent = snapshot.channelLimits.has(selectedDeviceId);
				dropdown.setValue(isPresent ? selectedDeviceId : '');
			}
		}
		this.runChannelDropdownUpdaters();
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
		this.deviceDropdowns = [];
		this.channelDropdownUpdaters = [];
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
