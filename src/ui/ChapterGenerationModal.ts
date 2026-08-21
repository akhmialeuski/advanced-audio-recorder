/**
 * On-demand dialog for generating LLM chapters for one recording. It confirms
 * a transcript exists (reading the recording's existing outputs, the same
 * discovery the fire-and-forget action uses), lets the user pick the chapter
 * guidance profile and the LLM for this run, and shows an up-front cost
 * estimate before anything is sent. Generation itself is delegated to the
 * shared AutoChapterService so the response validation and marker merge are
 * identical to the automatic path.
 * @module ui/ChapterGenerationModal
 */

import { Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../settings/settingsSchema';
import type { AutoChapterService } from '../chapters/AutoChapterService';
import {
	loadTranscriptLines,
	type TranscriptSectionReader,
	type TranscriptLinesSource,
} from '../chapters/transcriptSources';
import {
	profilesOfKind,
	selectedProfileId,
	setSelectedProfileId,
} from '../settings/profiles';
import { ensureSelectedInList } from '../settings/modelList';
import { ConfirmModal } from './ConfirmModal';
import { PluginModal } from './PluginModal';
import { LLM_PROVIDER_OPTIONS } from '../settings/labels';
import {
	estimateStepCost,
	formatUsd,
	jobLlmVendor,
	jobVendorId,
	type LlmJobId,
} from '../transcription/api';
import { formatTimecode } from '../utils/TimeUtils';
import { vendorEngine } from '../providers/providers';
import { applyEngineSettings } from '../providers/engineSettings';

/**
 * The job this dialog configures. Named once so the engine picker, the model
 * picker, and the cost estimate below all speak about the same one.
 */
const CHAPTERS_JOB: LlmJobId = 'autoChapters';

/**
 * What the engine row says about the pickers under it.
 *
 * An engine serves one catalogue, and an engine that both transcribes and
 * answers prompts therefore serves one catalogue for both jobs: the model
 * picked here is then literally the field transcription runs on, and picking a
 * cheaper one for a chaptering run would change what the next recording is
 * transcribed with. That is a property of the engine rather than of this
 * dialog, so it is read from the registry and said out loud where the choice is
 * made, instead of being a surprise the next transcription delivers.
 * @param vendorId - Engine currently selected for chapters
 * @returns The row's description
 */
function sharedCatalogueDesc(vendorId: LlmProviderId): string {
	const base =
		'The engine and model that generate the chapters. Kept as the chapters engine in settings.';
	return vendorEngine(vendorId).transcriptionId === null
		? base
		: `${base} This engine serves one model catalogue, so the model picked here is the one transcription runs on too.`;
}

/** Collaborators the dialog needs, injected by the action registry. */
export interface ChapterGenerationModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Persists settings after the run's choices are committed. */
	saveSettings: () => Promise<void>;
	/** Shared service that validates and writes the chapters. */
	autoChapters: AutoChapterService;
	/** Recording sidecar access: the recorded transcript outputs to read. */
	sidecar: TranscriptSectionReader;
}

/**
 * Chapter generation dialog for a single recording.
 */
export class ChapterGenerationModal extends PluginModal {
	/** Located transcript, loaded on open; null until the async load runs. */
	private source: TranscriptLinesSource | null = null;
	/** Whether the recording already has generated chapters (warn before replacing). */
	private hasExistingChapters = false;
	private loaded = false;
	/**
	 * Per-run settings copy, edited by the pickers below. The dialog never
	 * touches the live settings until the user actually generates, at which
	 * point {@link commitRunSettings} writes the choices back and persists them.
	 *
	 * Mutating the live object and restoring it in onClose (the previous
	 * approach) left the shared LLM configuration silently repointed whenever
	 * that restore did not run - a throw between the edit and the close, or a
	 * save triggered from elsewhere while the dialog was open. A copy cannot
	 * have that failure mode, and it matches how the Transcribe dialog already
	 * handled per-run overrides.
	 */
	private readonly runSettings: AudioRecorderSettings;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly options: ChapterGenerationModalOptions,
	) {
		super(app);
		// Shallow copy is enough: every field the pickers edit is a primitive.
		this.runSettings = { ...options.getSettings() };
	}

	override onOpen(): void {
		this.setDialogTitle('Generate chapters');
		void this.render();
	}

	/**
	 * Loads the recording's transcript and builds the dialog: the profile and
	 * LLM pickers with a cost estimate and a Generate action, or an explanation
	 * when the recording has no transcript to chapter yet.
	 */
	private async render(): Promise<void> {
		if (!this.loaded) {
			this.source = await loadTranscriptLines(
				this.app,
				this.file,
				this.options.sidecar,
			);
			this.hasExistingChapters =
				await this.options.autoChapters.hasExistingChapters(this.file);
			this.loaded = true;
		}
		this.contentEl.empty();
		this.renderSource(this.file);

		if (!this.source || this.source.lines.length === 0) {
			this.renderEmptyState(
				'No transcript found for this recording. Transcribe it ' +
					'first, then generate chapters.',
			);
			return;
		}

		const durationSeconds =
			this.source.lines[this.source.lines.length - 1]?.time ?? 0;
		this.renderProfilePicker();
		this.renderLlmPicker();
		this.renderCostEstimate(durationSeconds);

		this.renderActions(
			{
				text: this.hasExistingChapters ? 'Regenerate' : 'Generate',
				cta: true,
				disabled: this.busy,
				onClick: () => {
					this.generate();
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

	/**
	 * Renders the run's chapter-guidance profile picker. Edits the run copy;
	 * committed to settings only when the user generates, because the shared
	 * service reads the profile from there.
	 */
	private renderProfilePicker(): void {
		const s = this.runSettings;
		const profiles = profilesOfKind(s.profiles, 'chapterPrompt');
		const current = selectedProfileId(s, 'chapterPrompt');
		new Setting(this.contentEl)
			.setName('Chapter guidance profile')
			.setDesc(
				'Steers how this recording is divided. Add or edit profiles in ' +
					'the plugin settings.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'None (base prompt only)');
				for (const profile of profiles) {
					dropdown.addOption(profile.id, profile.name);
				}
				dropdown.setValue(current).onChange((id) => {
					setSelectedProfileId(s, 'chapterPrompt', id);
				});
			});
	}

	/**
	 * Renders the LLM engine and model pickers for this run. Chapters name
	 * their own engine, so a change here moves that choice rather than the
	 * post-processing one; the dialog re-renders on a change so the model list
	 * and the cost estimate follow the engine.
	 */
	private renderLlmPicker(): void {
		const s = this.runSettings;
		new Setting(this.contentEl)
			.setName('LLM')
			.setDesc(sharedCatalogueDesc(jobLlmVendor(s, CHAPTERS_JOB).id))
			.addDropdown((dropdown) => {
				for (const option of LLM_PROVIDER_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(jobVendorId(s, CHAPTERS_JOB))
					.onChange((id) => {
						s.chaptersLlmProvider =
							id as AudioRecorderSettings['chaptersLlmProvider'];
						void this.render();
					});
			});

		// Which fields hold the vendor's model and model list comes from the
		// registry, so this picker cannot drift from the settings tab's.
		const vendor = jobLlmVendor(s, CHAPTERS_JOB);
		const engine = vendorEngine(vendor.id);
		const selected = vendor.settings.model(s);
		const models = ensureSelectedInList(
			vendor.settings.models(s),
			selected,
		);
		new Setting(this.contentEl).setName('Model').addDropdown((dropdown) => {
			for (const model of models) {
				dropdown.addOption(model, model);
			}
			dropdown.setValue(selected).onChange((id) => {
				// Through the engine that owns the catalogue, so this dialog
				// moves a model by the same rules the engine's own page does.
				applyEngineSettings(s, engine.id, { model: id });
				void this.render();
			});
		});
	}

	/**
	 * Renders the up-front LLM cost estimate line, when cost estimates are
	 * enabled. Priced through the shared 'autoChapters' step, so this dialog
	 * shows exactly the number the Transcribe dialog shows for the same work;
	 * pricing it here with the post-processing formula instead made the two
	 * disagree by up to 4x and made this estimate move with the unrelated LLM
	 * task setting.
	 * @param durationSeconds - Transcript extent used to size the estimate
	 */
	private renderCostEstimate(durationSeconds: number): void {
		if (!this.runSettings.transcriptionShowCostEstimates) {
			return;
		}
		const line = estimateStepCost(
			'autoChapters',
			this.runSettings,
			durationSeconds,
		);
		const length = formatTimecode(Math.round(durationSeconds));
		const text =
			line.usd === null
				? `Estimated cost: not available for the selected LLM model (${length} transcript).`
				: `Estimated cost: about ${formatUsd(line.usd)} for this ${length} transcript (approximate).`;
		this.contentEl.createEl('p', { cls: 'aar-modal-config', text });
	}

	/**
	 * Starts generation, but first opens a confirmation dialog when the
	 * recording already has generated chapters, since regenerating replaces
	 * them. Confirming proceeds; cancelling leaves this dialog open.
	 */
	private generate(): void {
		if (this.busy) {
			return;
		}
		if (this.hasExistingChapters) {
			new ConfirmModal(this.app, {
				title: 'Replace existing chapters?',
				message:
					'This recording already has generated chapters. ' +
					'Generating again replaces them; bookmarks and manually ' +
					'added chapters are kept.',
				confirmText: 'Continue',
				onConfirm: () => {
					this.runGeneration();
				},
			}).open();
			return;
		}
		this.runGeneration();
	}

	/**
	 * Writes the run's choices into the live settings: the engine chapters are
	 * generated with, and the model that engine is generating with.
	 *
	 * Only that engine's model is committed, so an engine the dialog was merely
	 * switched through keeps the id it had. The engine that actually ran is a
	 * different matter: where it serves one catalogue for both jobs, the model
	 * committed here is the one transcription reads, which is what the engine
	 * row says before the choice is made rather than after.
	 */
	private commitRunSettings(): void {
		const live = this.options.getSettings();
		live.chaptersLlmProvider = this.runSettings.chaptersLlmProvider;
		const vendor = jobLlmVendor(this.runSettings, CHAPTERS_JOB);
		applyEngineSettings(live, vendorEngine(vendor.id).id, {
			model: vendor.settings.model(this.runSettings),
		});
		setSelectedProfileId(
			live,
			'chapterPrompt',
			selectedProfileId(this.runSettings, 'chapterPrompt'),
		);
	}

	/**
	 * Commits the run's choices, delegates generation to the shared service,
	 * and closes. The service reports every outcome with a Notice and never
	 * throws, so the dialog closes immediately and lets it run in the
	 * background.
	 */
	private runGeneration(): void {
		if (this.busy) {
			return;
		}
		this.busy = true;
		// The shared service reads the LLM and profile from the plugin settings,
		// so the run's choices become the stored defaults at this point - and
		// only at this point, because the user committed to a run.
		this.commitRunSettings();
		void this.options.saveSettings();
		this.close();
		// Reuse the transcript already located for the dialog, so the service
		// does not read the sidecar (or scan the notes) a second time.
		void this.options.autoChapters.generate(
			this.file,
			undefined,
			this.source ?? undefined,
		);
	}
}
