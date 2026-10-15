/**
 * The recording panel: a sidebar view showing what the plugin knows about the
 * recording in front of the user, and the actions it can take on it.
 *
 * "In front of the user" is the active file: a recording opened on its own, or
 * a note that embeds or links one - a meeting note, typically, with its
 * recording and its transcript. The panel follows the active file and redraws
 * when that note's links change or when the recording's sidecar does, so a
 * transcription finishing, a speaker being renamed or a chapter being added
 * shows up without the panel being reopened.
 *
 * It is built only from what Obsidian already offers: setting groups whose
 * rows show read-only values, and the recorder, queue, settings and "More
 * options" buttons in the heading of the first group. Obsidian hides a view's
 * own header in a sidebar, so buttons added with addAction would never be
 * seen where the panel lives. The panel carries no styles of its own. Every action it offers is a file action from the shared registry, so
 * the panel can never offer something the palette and the context menus do
 * not, nor drift from what they do.
 * @module panel/RecordingPanelView
 */

import { ItemView, Menu, Notice, SettingGroup } from 'obsidian';
import type {
	ExtraButtonComponent,
	TFile,
	ToggleComponent,
	WorkspaceLeaf,
} from 'obsidian';
import {
	COMMAND_IDS,
	PLUGIN_LOG_PREFIX,
	RECORDING_PANEL_VIEW_TYPE,
} from '../constants';
import { ICON_MIC, ICON_SAVING } from '../ui/RibbonIcon';
import type {
	ActionServices,
	FileAction,
	FileContext,
} from '../actions/PluginAction';
import { SIDECAR_SUFFIX } from '../sidecar/RecordingSidecarStore';
import {
	renderActionsIntoMenu,
	runActionLogged,
} from '../actions/renderActionsIntoMenu';
import { RecordingStatus } from '../types';
import { isAudioFile } from '../utils/audioFile';
import { fileNameOf } from '../utils/paths';
import { formatByteSize } from '../utils/formatBytes';
import { formatTimecode } from '../utils/TimeUtils';
import { ENHANCED_PLAYER_SETTING_NAME } from '../settings/sections/audioPlayerSection';
import { TRANSCRIBE_ON_SAVE_SETTING_NAME } from '../settings/sections/transcriptionSection';
import {
	formatPanelDate,
	recordingsReferencedBy,
	summarizeRecording,
	type RecordingPanelSummary,
} from './recordingPanelModel';

/** What a length nothing could read is shown as. */
const UNKNOWN_VALUE = 'unknown';

/** Shown while the length of a recording is still being read. */
const READING_VALUE = 'reading...';

/** What loadSummary answers for a sidecar that exists but cannot be read. */
const UNREADABLE = 'unreadable';

/** The record button in each state the recorder can be in. */
const RECORD_BUTTON = {
	idle: { icon: ICON_MIC, label: 'Start recording' },
	live: { icon: 'square', label: 'Stop recording' },
	saving: { icon: ICON_SAVING, label: 'Saving the recording' },
} as const;

/**
 * Actions the panel leaves to the menus. Deleting a recording is one click in
 * a menu that closes; in a panel that stays open next to the note, it is one
 * mis-click away from the button the user meant.
 */
const EXCLUDED_ACTIONS: ReadonlySet<string> = new Set([
	COMMAND_IDS.deleteRecording,
]);

/** A boolean setting the panel offers as a switch. */
interface QuickSetting {
	key: 'transcribeOnSave' | 'enhancedPlayerEnabled';
	/** The name the settings tab gives it, so both read the same. */
	name: string;
	/** Offered only while transcription is on, when it depends on it. */
	needsTranscription: boolean;
}

/** The settings a recording session reaches for most. */
const QUICK_SETTINGS: readonly QuickSetting[] = [
	{
		key: 'transcribeOnSave',
		name: TRANSCRIBE_ON_SAVE_SETTING_NAME,
		needsTranscription: true,
	},
	{
		key: 'enhancedPlayerEnabled',
		name: ENHANCED_PLAYER_SETTING_NAME,
		needsTranscription: false,
	},
];

/** What the panel needs from the plugin. */
export interface RecordingPanelHost {
	/**
	 * The panel's title, which the sidebar shows as the tab's tooltip: the
	 * plugin's name, read from the manifest so it cannot drift from the one
	 * Obsidian shows everywhere else.
	 */
	readonly displayName: string;
	/** The services every file action runs against. */
	readonly services: ActionServices;
	/** The file actions to offer, in the order the menus list them. */
	readonly actions: readonly FileAction[];
	/** The recorder, for the start/stop button. */
	readonly recording: {
		/** Starts capture, or stops and saves a running session. */
		toggleRecording(): Promise<void>;
		/** What the recorder is doing. */
		getStatus(): RecordingStatus;
	};
	/** Reads a recording's length in seconds, or null when it cannot. */
	readonly readDuration: (file: TFile) => Promise<number | null>;
	/** Opens the plugin's settings tab. */
	readonly openSettings: () => void;
	/** Shows the transcription queue. */
	readonly openTranscriptionQueue: () => void;
}

/** The recordings the panel can show for the active file. */
interface PanelTarget {
	/** The note in view, or '' when the recording itself is open. */
	notePath: string;
	/** The recordings that note refers to, or the open recording alone. */
	recordings: TFile[];
}

/**
 * The sidebar view. One instance per leaf; Obsidian builds it through the
 * factory the plugin registers and restores it with the workspace.
 */
export class RecordingPanelView extends ItemView {
	/** The recording chosen among several, kept across redraws. */
	private selectedPath: string | null = null;
	/** The recording shown, for the "More options" menu to act on. */
	private shownFile: TFile | null = null;
	/** The recordings currently shown, to filter sidecar changes by. */
	private shownPaths = new Set<string>();
	/**
	 * The recordings a refresh still in flight is reading, so a change that
	 * lands before it draws them is not mistaken for one to a recording the
	 * panel does not show.
	 */
	private pendingPaths = new Set<string>();
	/** The switches drawn, kept to set in place when a setting changes. */
	private readonly toggles = new Map<QuickSetting['key'], ToggleComponent>();
	/** The note currently shown, to filter metadata changes by. */
	private shownNotePath = '';
	/** Bumped per refresh, so a slower earlier one never draws over a later. */
	private generation = 0;
	/**
	 * The length last asked for, keyed by path and modification time. One
	 * entry: a redraw of the same recording reuses it, and moving on to
	 * another recording replaces it rather than keeping every one ever shown.
	 */
	private duration: { key: string; seconds: Promise<number | null> } | null =
		null;
	/**
	 * What the last drawing showed, so a change that leaves it the same - a
	 * playback position written to the sidecar, say - does not rebuild it.
	 */
	private shownKey = '';
	/**
	 * How many parts of the recording shown failed, or null while unknown. The
	 * menus offer the top-up whatever this is, because their availability is
	 * decided before anything is read; the panel has read it, so it offers
	 * the top-up only when there is something to top up.
	 */
	private failedParts: number | null = null;
	/** The start/stop button, redrawn when the recorder changes. */
	private recordButton: ExtraButtonComponent | null = null;

	/**
	 * @param leaf - The leaf Obsidian opened the view in
	 * @param host - What the panel needs from the plugin
	 */
	constructor(
		leaf: WorkspaceLeaf,
		private readonly host: RecordingPanelHost,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return RECORDING_PANEL_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return this.host.displayName;
	}

	override getIcon(): string {
		return ICON_MIC;
	}

	override async onOpen(): Promise<void> {
		const { workspace, metadataCache, vault } = this.app;
		this.registerEvent(
			workspace.on('file-open', () => {
				void this.refresh();
			}),
		);
		this.registerEvent(
			metadataCache.on('changed', (file) => {
				if (file.path === this.shownNotePath) {
					void this.refresh();
				}
			}),
		);
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				// The recording picked in the dropdown keeps being the one
				// shown under its new name.
				if (oldPath === this.selectedPath) {
					this.selectedPath = file.path;
				}
				if (
					this.shownPaths.has(oldPath) ||
					oldPath === this.shownNotePath ||
					file.path === this.shownNotePath
				) {
					void this.refresh();
				}
			}),
		);
		this.registerEvent(
			// A link the note already had starts resolving once the file it
			// names arrives - synced in, or created after the link was typed.
			metadataCache.on('resolved', () => {
				if (this.shownNotePath !== '') {
					void this.refresh();
				}
			}),
		);
		this.registerEvent(
			// A recording rewritten in place: its size and length changed.
			vault.on('modify', (file) => {
				if (this.shownPaths.has(file.path)) {
					void this.refresh();
				}
			}),
		);
		this.registerEvent(
			vault.on('delete', (file) => {
				if (this.shownPaths.has(file.path)) {
					void this.refresh();
				}
			}),
		);
		this.register(
			this.host.services.recordingSidecar.onChange((path) => {
				if (this.shownPaths.has(path) || this.pendingPaths.has(path)) {
					void this.refresh();
				}
			}),
		);
		await this.refresh();
	}

	override onClose(): Promise<void> {
		this.generation++;
		this.recordButton = null;
		this.contentEl.empty();
		return Promise.resolve();
	}

	/**
	 * Lists the file actions in the view's "More options" menu, the same
	 * entries the file menu offers for the recording shown.
	 * @param menu - The menu Obsidian is building
	 * @param source - Which of the view's menus it is
	 */
	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		// The "More options" menu only: the tab header's right-click menu is
		// about the tab, not the recording in it.
		if (source === 'more-options') {
			this.addFileActionsTo(menu);
		}
	}

	/**
	 * Lists the file actions of the recording shown in a menu: every one,
	 * delete included, because a menu closes like the file menu does, so
	 * nothing in it is a mis-click away.
	 * @param menu - The menu being built
	 */
	private addFileActionsTo(menu: Menu): void {
		if (!this.shownFile) {
			return;
		}
		renderActionsIntoMenu(
			menu,
			this.offeredActions(this.host.actions),
			{ file: this.shownFile, services: this.host.services },
			new Set(),
		);
	}

	/**
	 * Redraws the start/stop header action after the recorder changed state.
	 * Cheap, so the plugin calls it on every status change rather than
	 * redrawing the whole panel.
	 */
	refreshRecordingState(): void {
		if (!this.recordButton) {
			return;
		}
		const state = this.recorderState();
		const { icon, label } = RECORD_BUTTON[state];
		this.recordButton
			.setIcon(icon)
			.setTooltip(label)
			.setDisabled(state === 'saving');
	}

	/**
	 * What the record button can do now. A session that is saving can be
	 * neither started nor stopped, so the button says so and is disabled
	 * instead of offering a start the recorder would answer with a refusal.
	 */
	private recorderState(): keyof typeof RECORD_BUTTON {
		switch (this.host.recording.getStatus()) {
			case RecordingStatus.Recording:
			case RecordingStatus.Paused:
				return 'live';
			case RecordingStatus.Idle:
				return 'idle';
			default:
				return 'saving';
		}
	}

	/**
	 * Re-reads what the active file refers to and redraws the panel when what
	 * it shows changed: the data, or the settings that decide which actions
	 * and switches it offers.
	 * @returns Resolves once the panel shows the current state
	 */
	async refresh(): Promise<void> {
		const generation = ++this.generation;
		const target = this.resolveTarget();
		this.pendingPaths = new Set(target.recordings.map((file) => file.path));
		const selected =
			target.recordings.find((file) => file.path === this.selectedPath) ??
			target.recordings[0] ??
			null;
		const summary = selected
			? await this.loadSummary(selected, target.notePath)
			: null;
		if (generation !== this.generation) {
			return;
		}
		this.failedParts =
			summary && summary !== UNREADABLE ? summary.failedParts : null;
		const key = JSON.stringify([
			target.notePath,
			target.recordings.map((file) => file.path),
			selected && [
				selected.path,
				selected.stat.mtime,
				selected.stat.size,
			],
			summary,
			this.offeredSettings(selected),
		]);
		if (key === this.shownKey) {
			this.syncToggles();
			return;
		}
		this.shownKey = key;
		this.shownNotePath = target.notePath;
		this.shownPaths = new Set(target.recordings.map((file) => file.path));
		// selectedPath is left as the user's choice: a refresh that briefly
		// cannot resolve it - a rename seen before the note's links are
		// rewritten - shows another recording, but must not forget the one
		// picked.
		this.shownFile = selected;
		this.render(target, selected, summary);
	}

	/**
	 * What the settings let the panel offer: which actions are available and
	 * which switches show. Part of the redraw key, so a settings save that
	 * changes none of it costs no redraw. The switches' own values are not:
	 * they are set in place, so flipping one does not rebuild the panel under
	 * the user's pointer and take the focus away.
	 * @param selected - The recording shown, or null
	 */
	private offeredSettings(selected: TFile | null): unknown[] {
		const settings = this.host.services.getSettings();
		return [
			selected
				? this.availableActions({
						file: selected,
						services: this.host.services,
					}).map((action) => action.commandId)
				: [],
			settings.transcriptionEnabled,
		];
	}

	/**
	 * The recordings the active file refers to: itself when it is one, the
	 * recordings it embeds or links when it is a note, none otherwise.
	 */
	private resolveTarget(): PanelTarget {
		const active = this.app.workspace.getActiveFile();
		if (!active) {
			return { notePath: '', recordings: [] };
		}
		if (isAudioFile(active)) {
			return { notePath: '', recordings: [active] };
		}
		const recordings = recordingsReferencedBy(
			this.app.metadataCache.getFileCache(active),
			(link) =>
				this.app.metadataCache.getFirstLinkpathDest(link, active.path),
		);
		return { notePath: active.path, recordings };
	}

	/**
	 * Reads what the sidecar stores about a recording. A sidecar that exists
	 * but cannot be read answers as an empty document, which would read as a
	 * recording nobody transcribed, so it is reported as unreadable instead;
	 * either way the file details and the actions still show.
	 * @param file - The recording
	 * @param notePath - The note in view, or ''
	 */
	private async loadSummary(
		file: TFile,
		notePath: string,
	): Promise<RecordingPanelSummary | typeof UNREADABLE> {
		const sidecar = this.host.services.recordingSidecar;
		try {
			// One read first: it caches the document, so the two after it are
			// answered from memory instead of each reading the file again.
			const transcript = await sidecar.getTranscript(file.path);
			if (sidecar.isSidecarCorrupt(file.path)) {
				return UNREADABLE;
			}
			const [markers, failedParts] = await Promise.all([
				sidecar.getMarkers(file.path),
				sidecar.getFailedParts(file.path),
			]);
			return summarizeRecording({
				transcript,
				markers,
				failedParts,
				profiles: this.host.services.getSettings().profiles,
				notePath,
			});
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Could not read the stored data of ${file.path}:`,
				error,
			);
			return UNREADABLE;
		}
	}

	/**
	 * Draws the whole panel: the recording first, with the buttons that act on
	 * it, then what can be done with it, then what is known about it.
	 * @param target - What the active file refers to
	 * @param selected - The recording shown, or null for none
	 * @param summary - What its sidecar holds, null with nothing selected
	 */
	private render(
		target: PanelTarget,
		selected: TFile | null,
		summary: RecordingPanelSummary | typeof UNREADABLE | null,
	): void {
		const root = this.contentEl;
		root.empty();
		const recording = new SettingGroup(root).setHeading('Recording');
		this.addHeadingButtons(recording, selected !== null);
		if (!selected) {
			recording.addSetting((setting) => {
				setting.setDesc(
					'Open a recording, or a note that embeds one, to see its details here.',
				);
			});
		} else {
			this.renderFileSection(recording, target.recordings, selected);
			if (summary === UNREADABLE) {
				recording.addSetting((setting) => {
					setting.setDesc(
						`The stored data of this recording could not be read. Restore or remove ${selected.name}${SIDECAR_SUFFIX} to see it here.`,
					);
				});
			}
			this.renderActions(root, selected);
			if (summary && summary !== UNREADABLE) {
				this.renderTranscriptSection(root, summary);
				this.renderPeopleSection(root, summary);
				this.renderMarkerSection(root, summary);
			}
		}
		this.renderQuickSettings(root);
	}

	/**
	 * The panel's own buttons, in the heading of its first group: the place a
	 * sidebar pane keeps them, since Obsidian shows no view header there.
	 * @param group - The first group of the panel
	 * @param withMenu - Whether a recording is shown for the menu to act on
	 */
	private addHeadingButtons(group: SettingGroup, withMenu: boolean): void {
		group.addExtraButton((button) => {
			this.recordButton = button;
			button.onClick(() => {
				void this.host.recording
					.toggleRecording()
					.catch((error: unknown) => {
						console.error(
							`${PLUGIN_LOG_PREFIX} Starting or stopping a recording from the panel failed:`,
							error,
						);
					})
					.finally(() => {
						this.refreshRecordingState();
					});
			});
		});
		this.refreshRecordingState();
		group.addExtraButton((button) =>
			button
				.setIcon('list-ordered')
				.setTooltip('Show the transcription queue')
				.onClick(() => {
					this.host.openTranscriptionQueue();
				}),
		);
		group.addExtraButton((button) =>
			button
				.setIcon('settings')
				.setTooltip('Open settings')
				.onClick(() => {
					this.host.openSettings();
				}),
		);
		if (withMenu) {
			group.addExtraButton((button) =>
				button
					.setIcon('more-horizontal')
					.setTooltip('More options')
					.onClick(() => {
						const menu = new Menu();
						this.addFileActionsTo(menu);
						const box =
							button.extraSettingsEl.getBoundingClientRect();
						menu.showAtPosition({ x: box.left, y: box.bottom });
					}),
			);
		}
	}

	/** The file itself: name, length, size, format, when it was made. */
	private renderFileSection(
		group: SettingGroup,
		recordings: readonly TFile[],
		file: TFile,
	): void {
		if (recordings.length > 1) {
			group.addSetting((setting) => {
				setting.setName('Shown').addDropdown((dropdown) => {
					const names = recordings.map((recording) => recording.name);
					for (const recording of recordings) {
						// The path where two recordings share a name, so the
						// two entries can be told apart.
						const shared =
							names.indexOf(recording.name) !==
							names.lastIndexOf(recording.name);
						dropdown.addOption(
							recording.path,
							shared ? recording.path : recording.name,
						);
					}
					dropdown.setValue(file.path).onChange((path) => {
						this.selectedPath = path;
						void this.refresh();
					});
				});
			});
		}
		this.linkRow(group, 'File', file.path, file.name);
		this.row(
			group,
			'Duration',
			this.durationOf(file).then((seconds) =>
				seconds === null ? UNKNOWN_VALUE : formatTimecode(seconds),
			),
		);
		this.row(
			group,
			'Size',
			formatByteSize(file.stat.size, { decimals: 1, trimZeros: true }),
		);
		this.row(group, 'Format', file.extension.toUpperCase());
		this.row(group, 'Created', new Date(file.stat.ctime).toLocaleString());
	}

	/** How the recording was transcribed, and where the transcript went. */
	private renderTranscriptSection(
		root: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		const group = new SettingGroup(root).setHeading('Transcript');
		const written =
			summary.noteOutputs.length > 0 || summary.fileOutputs.length > 0;
		if (!written && summary.transcribedAt === null) {
			group.addSetting((setting) => {
				setting.setDesc('Not transcribed yet.');
			});
		}
		if (summary.transcribedAt !== null) {
			this.row(
				group,
				'Transcribed',
				formatPanelDate(summary.transcribedAt),
			);
		}
		if (summary.model !== null) {
			this.row(group, 'Model', summary.model);
		}
		if (summary.language !== null) {
			this.row(group, 'Language', summary.language);
		}
		if (summary.lineTemplate !== null) {
			this.row(group, 'Template', summary.lineTemplate);
		}
		for (const path of summary.noteOutputs) {
			this.linkRow(group, 'Note', path, fileNameOf(path));
		}
		for (const output of summary.fileOutputs) {
			const label = output.language
				? `${output.format} (${output.language})`
				: output.format;
			this.linkRow(group, label, output.path, fileNameOf(output.path));
		}
		if (summary.failedParts > 0) {
			this.row(group, 'Failed parts', String(summary.failedParts));
		}
	}

	/** Who took part: the participant roster and the named speakers. */
	private renderPeopleSection(
		root: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		if (
			summary.participants.length === 0 &&
			summary.speakers.length === 0
		) {
			return;
		}
		const group = new SettingGroup(root).setHeading('Participants');
		if (summary.participantProfile !== null) {
			this.row(group, 'Profile', summary.participantProfile);
		}
		if (summary.participants.length > 0) {
			this.row(group, 'Names', summary.participants.join(', '));
		}
		for (const speaker of summary.speakers) {
			this.row(group, speaker.label, speaker.name ?? 'not named');
		}
	}

	/** How many chapters and bookmarks the recording carries. */
	private renderMarkerSection(
		root: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		if (summary.chapters === 0 && summary.bookmarks === 0) {
			return;
		}
		const group = new SettingGroup(root).setHeading('Markers');
		this.row(group, 'Chapters', String(summary.chapters));
		this.row(group, 'Bookmarks', String(summary.bookmarks));
	}

	/** One row per file action that is available for the recording. */
	private renderActions(root: HTMLElement, file: TFile): void {
		const context: FileContext = { file, services: this.host.services };
		const actions = this.availableActions(context);
		if (actions.length === 0) {
			return;
		}
		const group = new SettingGroup(root).setHeading('Actions');
		for (const action of actions) {
			group.addSetting((setting) => {
				setting.setName(action.title).addExtraButton((button) =>
					button
						.setIcon(action.icon)
						.setTooltip(action.title)
						.onClick(() => {
							runActionLogged(
								action,
								context,
								'the recording panel',
							);
						}),
				);
			});
		}
	}

	/** Sets every drawn switch to the value its setting now holds. */
	private syncToggles(): void {
		const settings = this.host.services.getSettings();
		for (const [key, toggle] of this.toggles) {
			if (toggle.getValue() !== settings[key]) {
				toggle.setValue(settings[key]);
			}
		}
	}

	/** Switches for the settings a recording session reaches for most. */
	private renderQuickSettings(root: HTMLElement): void {
		const group = new SettingGroup(root).setHeading('Settings');
		this.toggles.clear();
		const settings = this.host.services.getSettings();
		for (const entry of QUICK_SETTINGS) {
			if (entry.needsTranscription && !settings.transcriptionEnabled) {
				continue;
			}
			group.addSetting((setting) => {
				setting.setName(entry.name).addToggle((toggle) => {
					this.toggles.set(entry.key, toggle);
					toggle
						.setValue(settings[entry.key])
						.onChange(async (value) => {
							// Read again rather than captured: settings synced in from
							// another device replace the object, and a change made to
							// the old one would be saved nowhere.
							const live = this.host.services.getSettings();
							// Obsidian also calls this when the switch is set in place
							// to a value the settings already hold. Saving then would
							// write a synced data.json straight back to where it came
							// from, so only the user's own flip is saved.
							if (live[entry.key] === value) {
								return;
							}
							live[entry.key] = value;
							await this.host.services
								.saveSettings()
								.catch((error: unknown) => {
									console.error(
										`${PLUGIN_LOG_PREFIX} Saving ${entry.key} from the recording panel failed:`,
										error,
									);
									new Notice(
										`Could not save "${entry.name}".`,
									);
								});
						});
				});
			});
		}
	}

	/**
	 * A row showing a read-only value beside its label.
	 * @param group - The group the row goes into
	 * @param label - What the value is
	 * @param value - The value, or a promise of it for one read later
	 */
	private row(
		group: SettingGroup,
		label: string,
		value: string | Promise<string>,
	): void {
		group.addSetting((setting) => {
			setting.setName(label).addDisplayValue((display) => {
				if (typeof value === 'string') {
					display.setValue(value);
					return;
				}
				display.setValue(READING_VALUE);
				void value.then((read) => display.setValue(read));
			});
		});
	}

	/** A value row whose button opens a vault file the way a link does. */
	private linkRow(
		group: SettingGroup,
		label: string,
		path: string,
		text: string,
	): void {
		group.addSetting((setting) => {
			setting
				.setName(label)
				.addDisplayValue((display) => display.setValue(text))
				.addExtraButton((button) =>
					button
						.setIcon('file-symlink')
						.setTooltip(`Open ${path}`)
						.onClick(() => {
							// By the file rather than as link text: a '#' or
							// '^' in a file name would be read as a heading or
							// block reference.
							const file = this.app.vault.getFileByPath(path);
							if (file) {
								void this.app.workspace
									.getLeaf(false)
									.openFile(file);
							} else {
								new Notice(
									`${path} is no longer in the vault.`,
								);
							}
						}),
				);
		});
	}

	/** The file actions the panel offers, in menu order. */
	private panelActions(): FileAction[] {
		return this.host.actions.filter(
			(action) => !EXCLUDED_ACTIONS.has(action.commandId),
		);
	}

	/** The file actions available for a recording, in menu order. */
	private availableActions(context: FileContext): FileAction[] {
		return this.offeredActions(this.panelActions()).filter((action) =>
			action.isAvailable(context),
		);
	}

	/**
	 * Leaves out the top-up when the recording has no failed parts. The
	 * menus offer it whatever the count, because their availability is
	 * decided before anything is read; the panel has read it.
	 * @param actions - Actions to filter
	 */
	private offeredActions(actions: readonly FileAction[]): FileAction[] {
		return actions.filter(
			(action) =>
				action.commandId !== COMMAND_IDS.retryFailedParts ||
				this.failedParts !== 0,
		);
	}

	/**
	 * A recording's length, read once per version of the file. Reading it
	 * can mean a ranged fetch of the container, so a redraw caused by a
	 * renamed speaker does not repeat it.
	 * @param file - The recording
	 */
	private durationOf(file: TFile): Promise<number | null> {
		const key = `${file.path}@${String(file.stat.mtime)}`;
		if (this.duration?.key !== key) {
			const seconds = this.host
				.readDuration(file)
				.catch((error: unknown) => {
					console.warn(
						`${PLUGIN_LOG_PREFIX} Could not read the length of ${file.path}:`,
						error,
					);
					return null;
				})
				.then((read) => {
					// A failed read may be a passing one - a file synced in a
					// moment ago - so the next redraw asks again.
					if (read === null && this.duration?.key === key) {
						this.duration = null;
					}
					return read;
				});
			this.duration = { key, seconds };
		}
		return this.duration.seconds;
	}
}
