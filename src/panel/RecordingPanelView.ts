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
	RecordingSessionPort,
} from '../actions/PluginAction';
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
	readonly recording: Pick<
		RecordingSessionPort,
		'toggleRecording' | 'isSessionActive'
	>;
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
	/** Lengths already asked for, keyed by path and modification time. */
	private readonly durations = new Map<string, Promise<number | null>>();
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
				void this.host.recording.toggleRecording().finally(() => {
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
			vault.on('rename', () => {
				void this.refresh();
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
		const context = this.actionContext();
		if (!context) {
			return;
		}
		for (const action of this.availableActions(context)) {
			menu.addItem((item) =>
				item
					.setTitle(action.title)
					.setIcon(action.icon)
					.setSection('action')
					.onClick(() => {
						this.runAction(action, context);
					}),
			);
		}
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
		const active = this.host.recording.isSessionActive();
		const label = active ? 'Stop recording' : 'Start recording';
		setIcon(this.recordAction, active ? 'square' : RECORDING_PANEL_ICON);
		this.recordAction.setAttribute('aria-label', label);
	}

	/**
	 * Re-reads what the active file refers to and redraws the panel.
	 * @returns Resolves once the panel shows the current state
	 */
	async refresh(): Promise<void> {
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
	 * Reads what the sidecar stores about a recording. A read that fails is
	 * logged and shown as nothing stored, so a broken sidecar never takes the
	 * file details and the actions down with it.
	 * @param file - The recording
	 * @param notePath - The note in view, or ''
	 */
	private async loadSummary(
		file: TFile,
		notePath: string,
	): Promise<RecordingPanelSummary | null> {
		const sidecar = this.host.services.recordingSidecar;
		try {
			const [transcript, markers, failedParts] = await Promise.all([
				sidecar.getTranscript(file.path),
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
			return null;
		}
	}

	/**
	 * Draws the whole panel.
	 * @param target - What the active file refers to
	 * @param selected - The recording shown, or null for none
	 * @param summary - What its sidecar holds, or null when unread
	 */
	private render(
		target: PanelTarget,
		selected: TFile | null,
		summary: RecordingPanelSummary | null,
	): void {
		const root = this.contentEl;
		root.empty();
		if (!selected) {
			new Setting(root).setDesc(
				'Open a recording, or a note that embeds one, to see its details here.',
			);
		} else {
			this.renderFileSection(root, target.recordings, selected);
			if (summary) {
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
			return;
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
			this.linkRow(root, 'Note', path, baseName(path));
		}
		for (const output of summary.fileOutputs) {
			const label = output.language
				? `${output.format} (${output.language})`
				: output.format;
			this.linkRow(root, label, output.path, baseName(output.path));
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
					settings[entry.key] = value;
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
					void this.app.workspace.openLinkText(
						path,
						this.shownNotePath,
						false,
					);
				}),
		);
	}

	/** The file actions available for a recording, in menu order. */
	private availableActions(context: FileContext): FileAction[] {
		return this.host.actions.filter(
			(action) =>
				!EXCLUDED_ACTIONS.has(action.commandId) &&
				action.isAvailable(context),
		);
	}

	/** The context the file actions run against, or null with nothing shown. */
	private actionContext(): FileContext | null {
		return this.shownFile
			? { file: this.shownFile, services: this.host.services }
			: null;
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
		let pending = this.durations.get(key);
		if (!pending) {
			pending = this.host.readDuration(file).catch((error: unknown) => {
				console.warn(
					`${PLUGIN_LOG_PREFIX} Could not read the length of ${file.path}:`,
					error,
				);
				return null;
			});
			this.durations.set(key, pending);
		}
		return pending;
	}
}

/**
 * The file name of a vault path, without its folders.
 * @param path - Vault path
 */
function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}
