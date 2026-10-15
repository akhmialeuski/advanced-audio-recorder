/**
 * The recording panel: a sidebar view showing what the plugin knows about the
 * recording in front of the user, and the actions it can take on it.
 *
 * "In front of the user" is the active file: a recording opened on its own, or
 * a note that embeds or links one - a meeting note, typically, with its
 * recording and its transcript. The panel follows the active file and redraws
 * when that note's links change or when the recording's sidecar does, so a
 * transcription finishing or a speaker being renamed shows up without the
 * panel being reopened.
 *
 * It is laid out like Obsidian's own Properties pane, a collapsible block of
 * icon, key and value rows per section, so it reads like the panes beside it
 * and follows the theme. Its buttons are Obsidian's icon buttons with
 * tooltips, in a row at the top: Obsidian hides a view's own header in a
 * sidebar, so buttons added with addAction would never be seen there. Every
 * action it offers is a file action from the shared registry, so the panel
 * can never offer something the palette and the context menus do not, nor
 * drift from what they do.
 * @module panel/RecordingPanelView
 */

import {
	DropdownComponent,
	ExtraButtonComponent,
	ItemView,
	setIcon,
} from 'obsidian';
import type { Menu, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
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
import { renderActionsIntoMenu } from '../actions/renderActionsIntoMenu';
import { runReported } from '../actions/registerActionCommands';
import { RecordingStatus } from '../types';
import { isAudioFile } from '../utils/audioFile';
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

/** Root class of the panel's content, which its stylesheet rules hang on. */
const PANEL_CLASS = 'aar-recording-panel';

/** The row of icon buttons at the top: the file actions, then the panel's own. */
const TOOLBAR_CLASS = 'aar-recording-panel-toolbar';

/** The panel's own buttons, kept together at the end of the toolbar. */
const TOOLS_CLASS = 'aar-recording-panel-tools';

/** The sections of the panel, by the key their collapsed state is kept under. */
const PanelSection = {
	Recording: 'recording',
	Participants: 'participants',
} as const;

/** One section of the panel (derived from {@link PanelSection}). */
type PanelSection = (typeof PanelSection)[keyof typeof PanelSection];

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
	/**
	 * The sections the user folded. Kept in the view's state, so the layout
	 * Obsidian saves remembers them across restarts.
	 */
	private readonly collapsed = new Set<PanelSection>();
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

	/**
	 * The view's state as Obsidian saves it with the layout: which sections
	 * the user folded.
	 */
	override getState(): Record<string, unknown> {
		return { ...super.getState(), collapsed: [...this.collapsed] };
	}

	/**
	 * Restores the folded sections from a saved layout.
	 * @param state - The state Obsidian saved, of any shape
	 * @param result - Passed on to Obsidian's own handling
	 */
	override async setState(
		state: unknown,
		result: ViewStateResult,
	): Promise<void> {
		const saved =
			typeof state === 'object' && state !== null && 'collapsed' in state
				? state.collapsed
				: [];
		this.collapsed.clear();
		for (const section of Object.values(PanelSection)) {
			if (Array.isArray(saved) && saved.includes(section)) {
				this.collapsed.add(section);
			}
		}
		await super.setState(state, result);
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
	 * Redraws the start/stop button after the recorder changed state.
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
	 * it offers.
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
		const summary = selected ? await this.loadSummary(selected) : null;
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
			this.offeredActionIds(selected),
		]);
		if (key === this.shownKey) {
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
	 * Which actions the settings let the panel offer. Part of the redraw key,
	 * so a settings save that changes none of them costs no redraw.
	 * @param selected - The recording shown, or null
	 */
	private offeredActionIds(selected: TFile | null): string[] {
		return selected
			? this.availableActions({
					file: selected,
					services: this.host.services,
				}).map((action) => action.commandId)
			: [];
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
	 */
	private async loadSummary(
		file: TFile,
	): Promise<RecordingPanelSummary | typeof UNREADABLE> {
		const sidecar = this.host.services.recordingSidecar;
		try {
			// One read first: it caches the document, so the one after it is
			// answered from memory instead of reading the file again.
			const transcript = await sidecar.getTranscript(file.path);
			if (sidecar.isSidecarCorrupt(file.path)) {
				return UNREADABLE;
			}
			return summarizeRecording({
				transcript,
				failedParts: await sidecar.getFailedParts(file.path),
				profiles: this.host.services.getSettings().profiles,
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
	 * Draws the whole panel: one row of buttons, the recording, then who took
	 * part.
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
		root.addClass(PANEL_CLASS);
		this.renderToolbar(root, selected);
		if (!selected) {
			root.createDiv({
				cls: 'pane-empty',
				text: 'Open a recording, or a note that embeds one, to see its details here.',
			});
			return;
		}
		if (target.recordings.length > 1) {
			this.renderPicker(root, target.recordings, selected);
		}
		const recording = this.section(
			root,
			PanelSection.Recording,
			'Recording',
		);
		this.renderFileRows(recording, selected);
		if (summary === UNREADABLE) {
			root.createDiv({
				cls: 'pane-empty',
				text: `The stored data of this recording could not be read. Restore or remove ${selected.name}${SIDECAR_SUFFIX} to see it here.`,
			});
			return;
		}
		if (summary) {
			this.renderTranscribedRow(recording, summary);
			this.renderParticipants(root, summary);
		}
	}

	/** Picks one of several recordings the note refers to. */
	private renderPicker(
		root: HTMLElement,
		recordings: readonly TFile[],
		file: TFile,
	): void {
		const dropdown = new DropdownComponent(root);
		const names = recordings.map((recording) => recording.name);
		for (const recording of recordings) {
			// The path where two recordings share a name, so the two entries
			// can be told apart.
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
	}

	/**
	 * The one row of icon buttons at the top of the panel: the recording's
	 * file actions, then the panel's own buttons at the row's end. Obsidian
	 * shows no view header in a sidebar, so the panel's buttons live here
	 * rather than in addAction.
	 * @param root - The panel's content
	 * @param file - The recording shown, or null for none
	 */
	private renderToolbar(root: HTMLElement, file: TFile | null): void {
		const row = root.createDiv({ cls: TOOLBAR_CLASS });
		if (file) {
			const context: FileContext = { file, services: this.host.services };
			for (const action of this.availableActions(context)) {
				new ExtraButtonComponent(row)
					.setIcon(action.icon)
					.setTooltip(action.title)
					.onClick(() => {
						runReported(action, context, 'the recording panel');
					});
			}
		}
		const tools = row.createDiv({ cls: TOOLS_CLASS });
		this.recordButton = new ExtraButtonComponent(tools).onClick(() => {
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
		this.refreshRecordingState();
		new ExtraButtonComponent(tools)
			.setIcon('list-ordered')
			.setTooltip('Show the transcription queue')
			.onClick(() => {
				this.host.openTranscriptionQueue();
			});
		new ExtraButtonComponent(tools)
			.setIcon('settings')
			.setTooltip('Open settings')
			.onClick(() => {
				this.host.openSettings();
			});
	}

	/**
	 * A section built the way Obsidian builds its Properties block: a heading
	 * that folds it, and a list of property rows. Obsidian's stylesheet hides
	 * the rows of a folded block and turns its arrow.
	 * @param root - The panel's content
	 * @param key - The key its folded state is kept under
	 * @param title - Its heading
	 * @returns The list the section's rows go into
	 */
	private section(
		root: HTMLElement,
		key: PanelSection,
		title: string,
	): HTMLElement {
		const container = root.createDiv({ cls: 'metadata-container' });
		const heading = container.createDiv({
			cls: 'metadata-properties-heading',
			attr: { tabindex: '0', role: 'button' },
		});
		const arrow = heading.createDiv({
			cls: 'collapse-indicator collapse-icon',
		});
		setIcon(arrow, 'right-triangle');
		heading.createDiv({ cls: 'metadata-properties-title', text: title });
		// The block hides its rows and the arrow turns, each by its own class,
		// as in Obsidian's Properties block.
		const show = (): void => {
			const folded = this.collapsed.has(key);
			container.toggleClass('is-collapsed', folded);
			arrow.toggleClass('is-collapsed', folded);
			heading.setAttribute('aria-expanded', String(!folded));
		};
		const toggle = (): void => {
			if (this.collapsed.has(key)) {
				this.collapsed.delete(key);
			} else {
				this.collapsed.add(key);
			}
			show();
			this.app.workspace.requestSaveLayout();
		};
		show();
		heading.addEventListener('click', toggle);
		heading.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggle();
			}
		});
		return container
			.createDiv({ cls: 'metadata-content' })
			.createDiv({ cls: 'metadata-properties' });
	}

	/**
	 * One property row: an icon, a key and a value.
	 * @returns The value element, for a caller that fills it in later
	 */
	private property(
		list: HTMLElement,
		icon: string,
		key: string,
		value: string,
	): HTMLElement {
		const row = list.createDiv({ cls: 'metadata-property' });
		const keyEl = row.createDiv({ cls: 'metadata-property-key' });
		setIcon(keyEl.createSpan({ cls: 'metadata-property-icon' }), icon);
		// The Properties block's own key field, read-only: Obsidian lays the
		// key out for that input, and the panel edits nothing.
		keyEl.createEl('input', {
			cls: 'metadata-property-key-input',
			type: 'text',
			value: key,
			attr: { readonly: 'true', tabindex: '-1', 'aria-label': key },
		});
		return row
			.createDiv({ cls: 'metadata-property-value' })
			.createDiv({ cls: 'metadata-input-longtext', text: value });
	}

	/** The file itself: its name, length, size, format, when it was made. */
	private renderFileRows(list: HTMLElement, file: TFile): void {
		const name = this.property(list, 'file-audio', 'File', '');
		const link = name.createEl('a', {
			cls: 'internal-link',
			text: file.name,
			attr: { 'aria-label': `Open ${file.path}` },
		});
		link.addEventListener('click', (event) => {
			event.preventDefault();
			void this.app.workspace.getLeaf(false).openFile(file);
		});
		const duration = this.property(
			list,
			'clock',
			'Duration',
			READING_VALUE,
		);
		void this.durationOf(file).then((seconds) => {
			duration.setText(
				seconds === null ? UNKNOWN_VALUE : formatTimecode(seconds),
			);
		});
		this.property(
			list,
			'hard-drive',
			'Size',
			formatByteSize(file.stat.size, { decimals: 1, trimZeros: true }),
		);
		this.property(
			list,
			'file-type',
			'Format',
			file.extension.toUpperCase(),
		);
		this.property(
			list,
			'calendar',
			'Created',
			formatPanelDate(new Date(file.stat.ctime).toISOString()),
		);
	}

	/**
	 * How the recording was transcribed, in one row: the engine, the
	 * language and when. Absent for a recording never transcribed.
	 */
	private renderTranscribedRow(
		list: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		const parts = [
			summary.model,
			summary.language,
			summary.transcribedAt === null
				? null
				: formatPanelDate(summary.transcribedAt),
		].filter((part): part is string => part !== null);
		if (parts.length > 0) {
			this.property(list, 'captions', 'Transcribed', parts.join(' · '));
		}
	}

	/** Who took part, one person per row, with the speaker named after them. */
	private renderParticipants(
		root: HTMLElement,
		summary: RecordingPanelSummary,
	): void {
		if (summary.participants.length === 0) {
			return;
		}
		const title =
			summary.participantProfile === null
				? 'Participants'
				: `Participants · ${summary.participantProfile}`;
		const list = this.section(root, PanelSection.Participants, title);
		for (const { name, speaker } of summary.participants) {
			this.property(list, 'user', name, speaker ?? '');
		}
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
