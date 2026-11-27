/**
 * The dialog that structures a recording's existing transcript with a note
 * template: it finds the transcript, offers the templates with the one this
 * recording was last structured with picked, shows what the run will cost,
 * and inserts the note. Built the way the chapter dialog is, since it is the
 * same move for a different result: a paid LLM step over a transcript the
 * recording already has, with somewhere to cancel it from.
 * @module ui/StructureTranscriptModal
 */

import { Notice, Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import {
	loadTranscriptLines,
	type TranscriptLinesSource,
	type TranscriptSectionReader,
} from '../chapters/transcriptSources';
import {
	ProfileKindId,
	profilesOfKind,
	selectedProfileId,
	setSelectedProfileId,
} from '../settings/profiles';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { LlmTask } from '../transcription/llmPostProcess';
import { estimateStepCost, formatUsd, LlmJobId } from '../transcription/api';
import type { TranscriptStructurer } from '../transcription/TranscriptStructurer';
import { CancellationSource } from '../utils/cancellation';
import { formatTimecode } from '../utils/TimeUtils';
import { PluginModal } from './PluginModal';

/** Collaborators the dialog needs, injected by the action registry. */
export interface StructureTranscriptModalOptions {
	/** Returns the current settings. */
	readonly getSettings: () => AudioRecorderSettings;
	/** Applies the template and inserts the note. */
	readonly structurer: TranscriptStructurer;
	/** Where the recording's transcript and last template are read. */
	readonly sidecar: TranscriptSectionReader;
	/** The note the result goes into; '' when there is none to write to. */
	readonly notePath: string;
}

/**
 * The template the dialog opens on: the one this recording was structured
 * with when it still exists, else the selected one, else the first.
 * @param settings - The current settings
 * @param applied - Id of the template last applied to the recording
 * @returns The id, '' when there is no template at all
 */
export function initialTemplateId(
	settings: AudioRecorderSettings,
	applied: string | undefined,
): string {
	const ids = profilesOfKind(
		settings.profiles,
		ProfileKindId.LlmTemplate,
	).map((profile) => profile.id);
	const selected = selectedProfileId(settings, ProfileKindId.LlmTemplate);
	return (
		[applied, selected].find(
			(id): id is string => id !== undefined && ids.includes(id),
		) ??
		ids[0] ??
		''
	);
}

/** Structures one recording's transcript with a template. */
export class StructureTranscriptModal extends PluginModal {
	private source: TranscriptLinesSource | null = null;
	private templateId = '';
	private loaded = false;
	/** The cancellation of the run in flight, null when none is. */
	private cancellation: CancellationSource | null = null;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly options: StructureTranscriptModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setDialogTitle('Structure transcript with a template');
		void this.render();
	}

	/**
	 * Finds the transcript and the template last applied, once, and builds
	 * the dialog, or says what is missing.
	 */
	private async render(): Promise<void> {
		if (!this.loaded) {
			await this.load();
		}
		this.contentEl.empty();
		this.renderSource(this.file);
		const problem = this.missing();
		if (problem) {
			this.renderEmptyState(problem);
			return;
		}
		this.renderTemplatePicker();
		this.renderTarget();
		this.renderCostEstimate();
		this.renderActions(
			{
				text: 'Structure',
				cta: true,
				disabled: this.busy,
				onClick: () => {
					this.structure();
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

	/** Reads the transcript and which template the recording last had. */
	private async load(): Promise<void> {
		const { sidecar } = this.options;
		this.source = await loadTranscriptLines(this.app, this.file, sidecar);
		const section = await sidecar
			.getTranscript(this.file.path)
			.catch(() => null);
		this.templateId = initialTemplateId(
			this.options.getSettings(),
			section?.appliedTemplate?.profileId,
		);
		this.loaded = true;
	}

	/** What keeps the dialog from running, or null when nothing does. */
	private missing(): string | null {
		if (!this.source || this.source.lines.length === 0) {
			return 'No transcript found for this recording. Transcribe it first, then structure it with a template.';
		}
		if (this.templateId === '') {
			return 'There is no note template yet. Add one under Note template profiles in the plugin settings.';
		}
		return this.options.notePath === ''
			? 'Open the note the structured transcript should go into, then run this again.'
			: null;
	}

	/** The template to apply, among every note template profile. */
	private renderTemplatePicker(): void {
		const templates = profilesOfKind(
			this.options.getSettings().profiles,
			ProfileKindId.LlmTemplate,
		);
		new Setting(this.contentEl)
			.setName('Note template')
			.setDesc(
				'Builds the note from the transcript this recording already has, without transcribing it again.',
			)
			.addDropdown((dropdown) => {
				for (const template of templates) {
					dropdown.addOption(template.id, template.name);
				}
				dropdown.setValue(this.templateId).onChange((id) => {
					this.templateId = id;
					// Drawn again so the estimate follows the template's calls.
					void this.render();
				});
			});
	}

	/** Where the note goes. */
	private renderTarget(): void {
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Inserted into ${this.options.notePath}.`,
		});
	}

	/**
	 * What the template's calls cost for this transcript, priced as the
	 * post-processing step of a transcription run is, so the two agree.
	 */
	private renderCostEstimate(): void {
		const settings = this.runSettings();
		if (!settings.transcriptionShowCostEstimates) {
			return;
		}
		const seconds = this.source?.lines.at(-1)?.time ?? 0;
		const line = estimateStepCost(LlmJobId.PostProcess, settings, seconds);
		const length = formatTimecode(Math.round(seconds));
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text:
				line.usd === null
					? `Estimated cost: not available for the selected LLM model (${length} transcript).`
					: `Estimated cost: about ${formatUsd(line.usd)} for this ${length} transcript (approximate).`,
		});
	}

	/** The settings as this run reads them: the template task, this template. */
	private runSettings(): AudioRecorderSettings {
		const settings: AudioRecorderSettings = {
			...this.options.getSettings(),
			llmPostProcessTask: LlmTask.Template,
		};
		setSelectedProfileId(
			settings,
			ProfileKindId.LlmTemplate,
			this.templateId,
		);
		return settings;
	}

	/** Runs the template, staying open with a Cancel until it is done. */
	private structure(): void {
		const source = this.source;
		if (this.busy || !source) {
			return;
		}
		const cancellation = new CancellationSource();
		this.cancellation = cancellation;
		this.renderRunning(cancellation);
		void this.runExclusive(async () => {
			const outcome = await this.options.structurer.structure({
				file: this.file,
				notePath: this.options.notePath,
				templateId: this.templateId,
				source,
				signal: cancellation.token.signal,
			});
			new Notice(outcome.message);
			this.cancellation = null;
			this.close();
		});
	}

	/** Closing the dialog is the same intent as its Cancel. */
	override onClose(): void {
		this.cancellation?.cancel();
		this.cancellation = null;
		super.onClose();
	}

	/**
	 * Replaces the form with what is happening and the way out of it.
	 * @param cancellation - Pulled by the button
	 */
	private renderRunning(cancellation: CancellationSource): void {
		this.contentEl.empty();
		this.renderSource(this.file);
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Structuring the transcript of ${this.file.name}...`,
		});
		this.renderActions({
			text: 'Cancel',
			onClick: () => {
				cancellation.cancel();
			},
		});
	}
}
