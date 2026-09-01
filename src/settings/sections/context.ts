/**
 * The context every settings section is handed, and the classes the stylesheet
 * finds its blocks by.
 *
 * A section describes rows and reads live settings, but it never reaches for a
 * collaborator itself: the devices it can offer, the profiles it can list, and
 * the handful of rows that have to be drawn by hand all arrive through one
 * object built once by the tab. Keeping that object and the class names here,
 * rather than in any one section, is what lets the sections stay leaves of the
 * import graph.
 * @module settings/sections/context
 */

import type { EngineId } from '../../providers/providers';
import type { ProfileSection } from '../profileKinds';
import type { AudioRecorderSettings } from '../settingsSchema';
import type { Setting } from 'obsidian';

/**
 * Marks a row whose whole body is drawn by hand: the documentation callout and
 * the credential blocks. From 1.13 on, the row of a render definition is the
 * only DOM that definition owns, so the stylesheet strips that row's own flex
 * layout, padding, background, and divider to let the body inside it read as an
 * ordinary settings column rather than as one setting's control.
 */
export const SETTINGS_ROOT_CLASS = 'aar-settings-root';

/**
 * Marks a row whose render callback puts block content (a status line, a
 * playback element) under its control instead of beside it. The stylesheet lets
 * such a row wrap so the block starts on its own line.
 */
export const SETTINGS_BLOCK_ROW_CLASS = 'aar-setting-block-row';

/**
 * Marks a block whose rows are all multi-line editors, laid out with the field
 * under its name across the whole row. A glossary or a guidance prompt is
 * edited in paragraphs, and the control column a row gives a text area by
 * default is a few characters wide.
 *
 * Only a group takes a class - a row cannot - so a text area is put in a block
 * of its own rather than beside the switches and pickers it belongs with. That
 * is what lets the stylesheet find it without asking which rows hold a text
 * area, a question CSS can only answer by testing every element on the page.
 */
export const STACKED_TEXT_CLASS = 'aar-stacked-text';

/**
 * Marks a block of settings: a group of this tree, whatever it is headed by.
 *
 * The block is what the eye should group by, so the stylesheet draws the line
 * between blocks and switches off the one Obsidian draws between the rows
 * inside them. It needs a handle for that, and a group is the only shape in the
 * tree that takes a class, so every group declared here carries this one - the
 * class is also the whole scope of those rules, so nothing outside this tab's
 * own blocks is restyled.
 *
 * That scope only holds while the tree leaves no row loose: Obsidian collects
 * every run of rows that sits outside a group into a block of its own, and such
 * a block carries no class to find it by. Every level of this tree therefore
 * declares its blocks itself, {@link sectionItems} being the shorthand for it.
 */
export const SETTINGS_SECTION_CLASS = 'aar-settings-section';

/**
 * Marks the tab's own container. On 1.13 the blocks carry their own class and
 * the stylesheet finds them there, but the Obsidian below it renders the same
 * tree as a flat list of rows with no group element at all, and its only block
 * boundaries are the heading rows. This is what scopes that half to this tab.
 */
export const SETTINGS_TAB_CLASS = 'aar-settings-tab';

/**
 * Marks the block whose rows repeat the same pair of pickers. Sized to its own
 * text, each picker ends where its longest option ends, which turns a block of
 * identical rows into a ragged column; the stylesheet gives them one width.
 */
export const TRACK_ROWS_CLASS = 'aar-track-rows';

/**
 * The live audio-input picture the device-bound rows are built from. The tab
 * enumerates devices asynchronously and asks for a re-render when the list
 * changes, so the definitions themselves only read what is already known.
 */
export interface DeviceOptions {
	/** Device id to label, for the input dropdowns. */
	readonly inputs: Record<string, string>;
	/**
	 * Whether the device list could be read at all. False where the
	 * environment exposes no device API, or where enumeration was refused: an
	 * empty dropdown then means "nothing could be asked" rather than "no
	 * microphone", and the rows say which.
	 */
	readonly enumerated: boolean;
	/**
	 * Whether a device offers a channel layout worth choosing. False for a
	 * device that positively reports a single capture channel, and for no
	 * device at all.
	 */
	channelSelectable(deviceId: string): boolean;
}

/**
 * What the transcription sections need from the tab: the two credential blocks
 * rendered by hand into the row their section keeps for them, and the edits
 * behind the add and delete affordances of the two model lists, which the
 * framework draws but the tab owns.
 */
export interface TranscriptionBlocks {
	/**
	 * A provider's API key, which is a password field rather than a plain one,
	 * so no control type covers it.
	 */
	readonly renderProviderKey: (host: HTMLElement, engineId: EngineId) => void;
	/** The local engine's binary and model paths, which are file pickers. */
	readonly renderLocalWhisperFields: (host: HTMLElement) => void;
	/**
	 * The three edits a model catalogue takes, named by the engine whose
	 * catalogue it is: one mechanism for every provider and both capabilities.
	 *
	 * A model is addressed by its id rather than by its position. The rows are
	 * built from the catalogue as it stood when the tree was built, while the
	 * edit runs against the catalogue as it stands when the row is clicked, and
	 * between those two moments the list can move - another window, a config
	 * reloaded from disk, an id added from a dialog. An id means the same thing
	 * in both.
	 */
	readonly addModel: (engine: EngineId) => void;
	readonly removeModel: (engine: EngineId, model: string) => void;
	readonly selectModel: (engine: EngineId, model: string) => void;
}

/**
 * The output-format rows that stay imperative. The format list is blocked per
 * option by an asynchronous encoder probe, which no control type expresses, and
 * the summary is derived from two other rows rather than stored.
 */
export interface OutputFormatRows {
	/** Fills the recording-format row and starts its availability probe. */
	readonly renderFormatRow: (setting: Setting) => void;
	/** Fills the row that summarises the effective output. */
	readonly renderSummaryRow: (setting: Setting) => void;
}

/**
 * The diagnostics actions, which act on the plugin rather than on a setting.
 */
export interface DiagnosticsActions {
	/** Starts the fixed-length test capture, reporting into the row it is given. */
	startTestRecording(rowEl: HTMLElement): void;
	/** Releases the test capture and the blob URL of its playback element. */
	releaseTestRecording(): void;
	/** Opens the system-information dialog. */
	showSystemInfo(): void;
}

/** One stored profile, as its entry in the catalogue presents it. */
export interface ProfileEntry {
	/** Stable id. Control keys and the edit actions address a profile by it. */
	readonly id: string;
	/** Display name, which is also the name of this profile's page. */
	readonly name: string;
	/** What the entry says about the profile without opening it. */
	readonly summary: string;
}

/** One profile catalogue, as the definitions address it. */
export interface ProfileCatalogue {
	/** Block of the settings this catalogue is shown in. */
	readonly section: ProfileSection;
	/** Heading of the catalogue page, e.g. "Dictionary profiles". */
	readonly heading: string;
	/** Description of the entry that opens the catalogue. */
	readonly selectorDesc: string;
	/** Label and description of the profile body field. */
	readonly bodyName: string;
	readonly bodyDesc: string;
	/** Label and description of the row that makes a profile the default one. */
	readonly selectionName: string;
	readonly selectionDesc: string;
	/** The profile of this kind a run applies ('' for none). */
	selectedId(settings: AudioRecorderSettings): string;
	/** Control key of the row that picks the profile in use. */
	readonly selectionKey: string;
	/** Control key of a profile's body. */
	readonly bodyKey: string;
	/** The stored profiles, in the order they are shown. */
	entries(settings: AudioRecorderSettings): readonly ProfileEntry[];
	/** Whether this catalogue is on screen at all. */
	visible(settings: AudioRecorderSettings): boolean;
	/** Adds an empty profile under a free name. */
	add(): void;
	/** Asks for a new name for a profile and applies it. */
	rename(id: string): void;
	/** Removes a profile. */
	remove(id: string): void;
	/**
	 * Moves a profile from one position in the catalogue to another, by index
	 * into {@link ProfileCatalogue.entries}.
	 */
	reorder(from: number, to: number): void;
}

/**
 * What the definitions need from the tab that owns them.
 */
export interface SettingsDefinitionContext {
	/**
	 * The live settings, read by the `visible` and `disabled` predicates. Values
	 * themselves travel through the tab's control-value hooks, not from here.
	 */
	readonly settings: AudioRecorderSettings;
	/** Input devices and their channel capability, as last enumerated. */
	readonly devices: DeviceOptions;
	/**
	 * Every profile catalogue, in the order their kinds are declared. A block
	 * takes the ones whose section names it, so a kind added to the registry
	 * needs no branch here.
	 */
	readonly profiles: readonly ProfileCatalogue[];
	/**
	 * Whether a list in this tree needs a labelled add row of its own. False
	 * wherever the renderer already draws one, which the render mode answers.
	 */
	readonly declareListAddRow: boolean;
	/** Capture sample rates this device offers. */
	readonly sampleRates: readonly number[];
	/** The two output-format rows the declarative controls cannot express. */
	readonly outputFormat: OutputFormatRows;
	/** Draws the documentation callout that opens the tab. */
	renderDocumentationLink(host: HTMLElement): void;
	/** Handlers for the diagnostics rows. */
	readonly diagnostics: DiagnosticsActions;
	/** The transcription blocks that are not definitions yet. */
	readonly transcriptionBlocks: TranscriptionBlocks;
}
