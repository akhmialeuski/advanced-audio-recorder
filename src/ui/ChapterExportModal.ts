/**
 * Writes a recording's markers out in one of the three representations the
 * world outside the plugin accepts, to the place that representation belongs.
 *
 * The two file formats are written beside the recording, because that is where
 * a cue sheet has to sit to point at its audio and where a description list is
 * looked for later. The outline is Markdown meant to live inside a note, so it
 * is inserted into one or put on the clipboard.
 * @module ui/ChapterExportModal
 */

import { Notice, Setting, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PluginModal } from './PluginModal';
import { PLUGIN_LOG_PREFIX } from '../constants';
import {
	formatChapterList,
	formatChapterOutline,
	formatCueSheet,
} from '../chapters/chapterExport';
import { resolveUniquePathInDirectory } from '../audio/RecordingFileManager';
import { directoryOf } from '../utils/paths';
import { insertTranscriptIntoNote } from '../transcription/transcriptOutput';
import type { PlayerMarker } from '../markers/markerModel';

/** The representations the markers can be written in. */
export const CHAPTER_EXPORT_VIEWS = ['list', 'cue', 'outline'] as const;

/** One representation of a recording's markers. */
export type ChapterExportView = (typeof CHAPTER_EXPORT_VIEWS)[number];

/** What each representation is called, and what it is for. */
const VIEW_LABELS: Record<ChapterExportView, string> = {
	list: 'Timecoded list (video description)',
	cue: 'Cue sheet (players and audio editors)',
	outline: 'Markdown outline (clickable timecodes)',
};

/** Where the outline can go, since it is Markdown rather than a file format. */
const OUTLINE_TARGETS = {
	note: 'Insert into the active note',
	clipboard: 'Copy to the clipboard',
} as const;

/** Where the outline is being sent. */
type OutlineTarget = keyof typeof OUTLINE_TARGETS;

/** What the dialog needs to write the markers out. */
export interface ChapterExportOptions {
	/** The recording whose markers are being exported. */
	file: TFile;
	/** Its markers, already loaded. */
	markers: readonly PlayerMarker[];
	/** Path of the note the outline is inserted into, or '' when none is open. */
	notePath: string;
	/** Builds a link to an offset, so an outline timecode is clickable. */
	linkBuilder: (seconds: number, label: string) => string;
}

/**
 * Asks which representation to write, and where.
 */
export class ChapterExportModal extends PluginModal {
	/** The representation being written. */
	private view: ChapterExportView = 'list';

	/** Where the outline goes; ignored for the two file formats. */
	private target: OutlineTarget = 'note';

	/**
	 * @param app - Obsidian App instance
	 * @param options - The recording, its markers, and how to link into it
	 */
	constructor(
		app: App,
		private readonly options: ChapterExportOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Export chapters and markers');
		this.contentEl.createEl('p', {
			text: `${String(this.options.markers.length)} marker${
				this.options.markers.length === 1 ? '' : 's'
			} from ${this.options.file.name}.`,
		});
		// Built in reading order: what to write, then where it goes.
		const viewSetting = new Setting(this.contentEl)
			.setName('Representation')
			.setDesc('What the markers are written as.');
		const targetSetting = new Setting(this.contentEl)
			.setName('Send it to')
			.setDesc('Where the outline is written.');
		viewSetting.addDropdown((dropdown) => {
			dropdown
				.addOptions(VIEW_LABELS)
				.setValue(this.view)
				.onChange((value) => {
					this.view = value as ChapterExportView;
					// The two file formats have one destination, so the
					// question only applies to the outline.
					targetSetting.settingEl.toggle(this.view === 'outline');
				});
		});
		targetSetting.addDropdown((dropdown) => {
			dropdown
				.addOptions(OUTLINE_TARGETS)
				.setValue(this.target)
				.onChange((value) => {
					this.target = value as OutlineTarget;
				});
		});
		targetSetting.settingEl.toggle(false);
		this.renderActions(
			{
				text: 'Export',
				cta: true,
				onClick: () => {
					void this.runExclusive(() => this.exportMarkers());
				},
			},
			{
				text: 'Cancel',
				onClick: () => {
					this.close();
				},
			},
		);
	}

	/** Writes the chosen representation to the chosen place. */
	private async exportMarkers(): Promise<void> {
		try {
			const message =
				this.view === 'outline'
					? await this.writeOutline()
					: await this.writeFile();
			new Notice(message);
			this.close();
		} catch (error) {
			console.error(
				`${PLUGIN_LOG_PREFIX} Failed to export the markers of ${this.options.file.path}:`,
				error,
			);
			new Notice(
				`Could not export the markers: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * Writes the timecoded list or the cue sheet beside the recording.
	 * @returns What to tell the user
	 */
	private async writeFile(): Promise<string> {
		const base = this.options.file.path.replace(/\.[^.]+$/, '');
		const isCue = this.view === 'cue';
		const content = isCue
			? formatCueSheet(this.options.markers, {
					fileName: this.options.file.name,
					title: this.options.file.basename,
				})
			: formatChapterList(this.options.markers);
		const desired = `${base}.${isCue ? 'cue' : 'chapters.txt'}`;
		const directory = directoryOf(desired);
		const target = await resolveUniquePathInDirectory(
			directory,
			desired.slice(directory.length === 0 ? 0 : directory.length + 1),
			this.app,
		);
		await this.app.vault.create(target, content);
		return `Markers written to ${target}.`;
	}

	/**
	 * Puts the outline in the note or on the clipboard.
	 * @returns What to tell the user
	 */
	private async writeOutline(): Promise<string> {
		const outline = formatChapterOutline(
			this.options.markers,
			this.options.linkBuilder,
		);
		if (this.target === 'clipboard') {
			await navigator.clipboard.writeText(outline);
			return 'Outline copied to the clipboard.';
		}
		if (!this.options.notePath) {
			throw new Error(
				'No note is open to insert the outline into. Copy it to the clipboard instead.',
			);
		}
		if (
			!insertTranscriptIntoNote(
				this.app,
				this.options.notePath,
				outline,
				'',
			)
		) {
			throw new Error(
				'The note could not be written to. Open it in editing mode, or copy the outline to the clipboard.',
			);
		}
		return `Outline inserted into ${this.options.notePath}.`;
	}
}
