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
 * It is built only from what Obsidian already offers a view: the header
 * buttons are view actions, the "More options" menu lists the file actions,
 * and the body is setting rows and headings, so the panel looks and behaves
 * like the Properties or Outline panes next to it and carries no styles of its
 * own. Every action it offers is a file action from the shared registry, so
 * the panel can never offer something the palette and the context menus do
 * not, nor drift from what they do.
 * @module panel/RecordingPanelView
 */

import { ItemView, Setting, setIcon } from 'obsidian';
import type { Menu, TFile, WorkspaceLeaf } from 'obsidian';
import {
	COMMAND_IDS,
	PLUGIN_LOG_PREFIX,
	RECORDING_PANEL_ICON,
	RECORDING_PANEL_VIEW_TYPE,
} from '../constants';
import type {
	ActionServices,
	FileAction,
	FileContext,
} from '../actions/PluginAction';
import { SIDECAR_SUFFIX } from '../sidecar/RecordingSidecarStore';
import { renderActionsIntoMenu } from '../actions/renderActionsIntoMenu';
import { RecordingStatus } from '../types';
import { isAudioFile } from '../utils/audioFile';
import { fileNameOf } from '../utils/paths';
import { formatByteSize } from '../utils/formatBytes';
import { formatTimecode } from '../utils/TimeUtils';
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
	idle: { icon: RECORDING_PANEL_ICON, label: 'Start recording' },
	live: { icon: 'square', label: 'Stop recording' },
	saving: { icon: 'loader', label: 'Saving the recording' },
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
		name: 'Transcribe after recording',
		needsTranscription: true,
	},
	{
		key: 'enhancedPlayerEnabled',
		name: 'Enhanced audio player',
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
	/** A redraw was asked for regardless of the data, and is still owed. */
	private forceRedraw = false;
	/** The start/stop header action, redrawn when the recorder changes. */
	private recordAction: HTMLElement | null = null;

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
		return RECORDING_PANEL_ICON;
	}

	override async onOpen(): Promise<void> {
		this.addAction('settings', 'Open settings', () => {
			this.host.openSettings();
		});
		this.addAction('list-ordered', 'Show the transcription queue', () => {
			this.host.openTranscriptionQueue();
		});
		this.recordAction = this.addAction(
			RECORDING_PANEL_ICON,
			'Start recording',
			() => {
				if (this.recorderState() === 'saving') {
					return;
				}
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
			},
		);
		this.refreshRecordingState();

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
				if (
					this.shownPaths.has(oldPath) ||
					oldPath === this.shownNotePath ||
					file.path === this.shownNotePath
				) {
					void this.refreshAfterRename();
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
				if (this.shownPaths.has(path)) {
					void this.refresh();
				}
			}),
		);
		await this.refresh();
	}

	override async onClose(): Promise<void> {
		this.generation++;
		this.recordAction = null;
		this.contentEl.empty();
		await Promise.resolve();
	}

	/**
	 * Lists the file actions in the view's "More options" menu, the same
	 * entries the file menu offers for the recording shown.
	 * @param menu - The menu Obsidian is building
	 * @param source - Which of the view's menus it is
	 */
	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (this.shownFile) {
			renderActionsIntoMenu(
				menu,
				this.panelActions(),
				{ file: this.shownFile, services: this.host.services },
				new Set(),
			);
		}
	}

	/**
	 * Redraws after a rename that touched what the panel shows, once the
	 * sidecar store has moved the recording's document. The store's own
	 * rename handler only queues the move, so a read made right away finds
	 * nothing at the new path yet - and caching that empty answer would let
	 * the next write replace the moved document with it.
	 */
	private async refreshAfterRename(): Promise<void> {
		// One turn first, so every rename handler of this event has queued
		// its work before the store is asked to settle.
		await Promise.resolve();
		await this.host.services.recordingSidecar.settled();
		await this.refresh();
	}

	/**
	 * Redraws the start/stop header action after the recorder changed state.
	 * Cheap, so the plugin calls it on every status change rather than
	 * redrawing the whole panel.
	 */
	refreshRecordingState(): void {
		if (!this.recordAction) {
			return;
		}
		const { icon, label } = RECORD_BUTTON[this.recorderState()];
		setIcon(this.recordAction, icon);
		this.recordAction.setAttribute('aria-label', label);
	}

	/**
	 * What the record button can do now. A session that is saving can be
	 * neither started nor stopped, so the button says so instead of offering
	 * a start the recorder would answer with a refusal.
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
	 * it shows changed.
	 * @param force - Redraw even when the data is the same, for a change the
	 *   data does not carry (the settings that gate the actions and switches)
	 * @returns Resolves once the panel shows the current state
	 */
	async refresh(force = false): Promise<void> {
		// Kept until a redraw happens: a later refresh can overtake a forced
		// one, and must not then skip the redraw the forced one was owed.
		this.forceRedraw ||= force;
		const generation = ++this.generation;
		const target = this.resolveTarget();
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
		const key = JSON.stringify([
			target.notePath,
			target.recordings.map((file) => file.path),
			selected && [
				selected.path,
				selected.stat.mtime,
				selected.stat.size,
			],
			summary,
		]);
		if (!this.forceRedraw && key === this.shownKey) {
			return;
		}
		this.forceRedraw = false;
		this.shownKey = key;
		this.shownNotePath = target.notePath;
		this.shownPaths = new Set(target.recordings.map((file) => file.path));
		this.selectedPath = selected?.path ?? null;
		this.shownFile = selected;
		this.render(target, selected, summary);
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
			const [transcript, markers, failedParts] = await Promise.all([
				sidecar.getTranscript(file.path),
				sidecar.getMarkers(file.path),
				sidecar.getFailedParts(file.path),
			]);
			if (sidecar.isSidecarCorrupt(file.path)) {
				return UNREADABLE;
			}
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
	 * Draws the whole panel.
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
		if (!selected) {
			new Setting(root).setDesc(
				'Open a recording, or a note that embeds one, to see its details here.',
			);
		} else {
			this.renderFileSection(root, target.recordings, selected);
			if (summary === UNREADABLE) {
				new Setting(root).setDesc(
					`The stored data of this recording could not be read. Restore or remove ${selected.name}${SIDECAR_SUFFIX} to see it here.`,
				);
			} else if (summary) {
				this.renderTranscriptSection(root, summary);
				this.renderPeopleSection(root, summary);
				this.renderMarkerSection(root, summary);
			}
			this.renderActions(root, selected);
		}
		this.renderQuickSettings(root);
	}

	/** The file itself: name, length, size, format, when it was made. */
	private renderFileSection(
		root: HTMLElement,
		recordings: readonly TFile[],
		file: TFile,
	): void {
		new Setting(root).setName('Recording').setHeading();
		if (recordings.length > 1) {
			new Setting(root).setName('Shown').addDropdown((dropdown) => {
				for (const recording of recordings) {
					dropdown.addOption(recording.path, recording.name);
				}
				dropdown.setValue(file.path).onChange((path) => {
					this.selectedPath = path;
					void this.refresh();
				});
			});
		}
		this.linkRow(root, 'File', file.path, file.name);
		const duration = this.row(root, 'Duration', READING_VALUE);
		void this.durationOf(file).then((seconds) => {
			duration.setDesc(
				seconds === null ? UNKNOWN_VALUE : formatTimecode(seconds),
			);
		});
		this.row(
			root,
			'Size',
			formatByteSize(file.stat.size, { decimals: 1, trimZeros: true }),
		);
		this.row(root, 'Format', file.extension.toUpperCase());
		this.row(root, 'Created', new Date(file.stat.ctime).toLocaleString());
	}

	/** How the recording was transcribed, and where the transcript went. */
	private renderTranscriptSection(
		root: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		new Setting(root).setName('Transcript').setHeading();
		const written =
			summary.noteOutputs.length > 0 || summary.fileOutputs.length > 0;
		if (!written && summary.transcribedAt === null) {
			new Setting(root).setDesc('Not transcribed yet.');
		}
		if (summary.transcribedAt !== null) {
			this.row(
				root,
				'Transcribed',
				formatPanelDate(summary.transcribedAt),
			);
		}
		if (summary.model !== null) {
			this.row(root, 'Model', summary.model);
		}
		if (summary.language !== null) {
			this.row(root, 'Language', summary.language);
		}
		if (summary.lineTemplate !== null) {
			this.row(root, 'Template', summary.lineTemplate);
		}
		for (const path of summary.noteOutputs) {
			this.linkRow(root, 'Note', path, fileNameOf(path));
		}
		for (const output of summary.fileOutputs) {
			const label = output.language
				? `${output.format} (${output.language})`
				: output.format;
			this.linkRow(root, label, output.path, fileNameOf(output.path));
		}
		if (summary.failedParts > 0) {
			this.row(root, 'Failed parts', String(summary.failedParts));
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
		new Setting(root).setName('Participants').setHeading();
		if (summary.participantProfile !== null) {
			this.row(root, 'Profile', summary.participantProfile);
		}
		if (summary.participants.length > 0) {
			this.row(root, 'Names', summary.participants.join(', '));
		}
		for (const speaker of summary.speakers) {
			this.row(root, speaker.label, speaker.name ?? 'not named');
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
		new Setting(root).setName('Markers').setHeading();
		this.row(root, 'Chapters', String(summary.chapters));
		this.row(root, 'Bookmarks', String(summary.bookmarks));
	}

	/** One row per file action that is available for the recording. */
	private renderActions(root: HTMLElement, file: TFile): void {
		const context: FileContext = { file, services: this.host.services };
		const actions = this.availableActions(context);
		if (actions.length === 0) {
			return;
		}
		new Setting(root).setName('Actions').setHeading();
		for (const action of actions) {
			new Setting(root).setName(action.title).addExtraButton((button) =>
				button
					.setIcon(action.icon)
					.setTooltip(action.title)
					.onClick(() => {
						this.runAction(action, context);
					}),
			);
		}
	}

	/** Switches for the settings a recording session reaches for most. */
	private renderQuickSettings(root: HTMLElement): void {
		new Setting(root).setName('Settings').setHeading();
		const settings = this.host.services.getSettings();
		for (const entry of QUICK_SETTINGS) {
			if (entry.needsTranscription && !settings.transcriptionEnabled) {
				continue;
			}
			new Setting(root).setName(entry.name).addToggle((toggle) =>
				toggle.setValue(settings[entry.key]).onChange(async (value) => {
					// Read again rather than captured: settings synced in from
					// another device replace the object, and a change made to
					// the old one would be saved nowhere.
					this.host.services.getSettings()[entry.key] = value;
					await this.host.services.saveSettings();
				}),
			);
		}
	}

	/**
	 * A label and a value on one setting row.
	 * @returns The row, for a caller that fills the value in later
	 */
	private row(parent: HTMLElement, label: string, value: string): Setting {
		return new Setting(parent).setName(label).setDesc(value);
	}

	/** A row whose button opens a vault file the way a link does. */
	private linkRow(
		parent: HTMLElement,
		label: string,
		path: string,
		text: string,
	): void {
		this.row(parent, label, text).addExtraButton((button) =>
			button
				.setIcon('file-symlink')
				.setTooltip(`Open ${path}`)
				.onClick(() => {
					// By the file rather than as link text: a '#' or '^' in a
					// file name would be read as a heading or block reference.
					const file = this.app.vault.getFileByPath(path);
					if (file) {
						void this.app.workspace.getLeaf(false).openFile(file);
					}
				}),
		);
	}

	/** The file actions the panel offers, in menu order. */
	private panelActions(): FileAction[] {
		return this.host.actions.filter(
			(action) => !EXCLUDED_ACTIONS.has(action.commandId),
		);
	}

	/** The file actions available for a recording, in menu order. */
	private availableActions(context: FileContext): FileAction[] {
		return this.panelActions().filter((action) =>
			action.isAvailable(context),
		);
	}

	/** Runs one file action, logging a failure it did not report itself. */
	private runAction(action: FileAction, context: FileContext): void {
		void Promise.resolve(action.run(context)).catch((error: unknown) => {
			console.error(
				`${PLUGIN_LOG_PREFIX} ${action.commandId} failed from the recording panel:`,
				error,
			);
		});
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
				});
			this.duration = { key, seconds };
		}
		return this.duration.seconds;
	}
}
