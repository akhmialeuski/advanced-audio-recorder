/**
 * On-demand dialog for generating LLM chapters for one recording. It confirms
 * a transcript exists (reading the recording's existing outputs, the same
 * discovery the fire-and-forget action uses), lets the user pick the chapter
 * guidance profile for this run, and shows an up-front cost estimate for the
 * LLM pass before anything is sent. Generation itself is delegated to the
 * shared AutoChapterService so the response validation and marker merge are
 * identical to the automatic path.
 * @module ui/ChapterGenerationModal
 */

import { Modal, Setting } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { LLM_PROVIDER_IDS } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import type { AutoChapterService } from '../chapters/AutoChapterService';
import {
	loadTranscriptLines,
	type TranscriptLinesSource,
} from '../chapters/transcriptSources';
import { findChapterPromptProfile } from '../settings/chapterPromptProfiles';
import { ensureSelectedInList } from '../settings/modelList';
import { ConfirmModal } from './ConfirmModal';
import { LLM_PROVIDER_OPTIONS } from '../settings/labels';
import { estimateLlmCost, formatUsd } from '../transcription/costs';
import { formatTimecode } from '../utils/TimeUtils';

/** Read/write access to the model list of the currently selected LLM provider. */
interface LlmModelAccess {
	models: string[];
	selected: string;
	setSelected: (id: string) => void;
}

/** The shared LLM and chapter-profile fields the run pickers edit in place. */
type RunSettingsSnapshot = Pick<
	AudioRecorderSettings,
	| 'llmProvider'
	| 'llmAnthropicModel'
	| 'llmGeminiModel'
	| 'llmOpenAiModel'
	| 'transcriptionChapterPromptProfileId'
>;

/** Collaborators the dialog needs, injected by the action registry. */
export interface ChapterGenerationModalOptions {
	/** Returns current plugin settings. */
	getSettings: () => AudioRecorderSettings;
	/** Persists settings after the run profile is changed. */
	saveSettings: () => Promise<void>;
	/** Shared service that validates and writes the chapters. */
	autoChapters: AutoChapterService;
}

/**
 * Chapter generation dialog for a single recording.
 */
export class ChapterGenerationModal extends Modal {
	/** Located transcript, loaded on open; null until the async load runs. */
	private source: TranscriptLinesSource | null = null;
	/** Whether the recording already has generated chapters (warn before replacing). */
	private hasExistingChapters = false;
	private loaded = false;
	private generating = false;
	/** Set once the user generates, so onClose keeps the committed choice. */
	private committed = false;
	/**
	 * The shared LLM and chapter-profile settings as they were when the dialog
	 * opened. The pickers below edit the live settings so the model list and
	 * cost estimate can follow the choice, but the change is persisted only when
	 * the user generates; closing without generating restores this, so Cancel
	 * does not silently repoint the shared LLM configuration used elsewhere.
	 */
	private readonly initialRunSettings: RunSettingsSnapshot;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly options: ChapterGenerationModalOptions,
	) {
		super(app);
		const s = options.getSettings();
		this.initialRunSettings = {
			llmProvider: s.llmProvider,
			llmAnthropicModel: s.llmAnthropicModel,
			llmGeminiModel: s.llmGeminiModel,
			llmOpenAiModel: s.llmOpenAiModel,
			transcriptionChapterPromptProfileId:
				s.transcriptionChapterPromptProfileId,
		};
	}

	override onOpen(): void {
		this.setTitle('Generate chapters');
		void this.render();
	}

	/**
	 * Loads the recording's transcript and builds the dialog: a profile
	 * picker and a cost estimate with a Generate action, or an explanation
	 * when the recording has no transcript to chapter yet.
	 */
	private async render(): Promise<void> {
		if (!this.loaded) {
			this.source = await loadTranscriptLines(this.app, this.file);
			this.hasExistingChapters =
				await this.options.autoChapters.hasExistingChapters(this.file);
			this.loaded = true;
		}
		const settings = this.options.getSettings();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${this.file.name}`,
		});

		if (!this.source || this.source.lines.length === 0) {
			contentEl.createEl('p', {
				text:
					'No transcript found for this recording. Transcribe it ' +
					'first, then generate chapters.',
			});
			const actions = contentEl.createDiv({
				cls: 'modal-button-container',
			});
			const closeButton = actions.createEl('button', { text: 'Close' });
			closeButton.addEventListener('click', () => {
				this.close();
			});
			return;
		}

		const durationSeconds =
			this.source.lines[this.source.lines.length - 1]?.time ?? 0;
		this.renderProfilePicker(settings);
		this.renderLlmPicker(settings);
		this.renderCostEstimate(settings, durationSeconds);

		const actions = contentEl.createDiv({ cls: 'modal-button-container' });
		const generateButton = actions.createEl('button', {
			cls: 'mod-cta',
			text: this.hasExistingChapters ? 'Regenerate' : 'Generate',
		});
		generateButton.disabled = this.generating;
		generateButton.addEventListener('click', () => {
			this.generate();
		});
		const cancelButton = actions.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});
	}

	/**
	 * Renders the run profile picker. Changing it persists the selection so
	 * the shared service, which reads the profile from settings, uses it.
	 * @param settings - Current plugin settings
	 */
	private renderProfilePicker(settings: AudioRecorderSettings): void {
		const profiles = settings.transcriptionChapterPromptProfiles;
		const current = findChapterPromptProfile(
			profiles,
			settings.transcriptionChapterPromptProfileId,
		)
			? settings.transcriptionChapterPromptProfileId
			: '';
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
					// Applied in place; persisted only when the user generates
					// (see runGeneration), reverted on cancel (see onClose).
					settings.transcriptionChapterPromptProfileId = id;
				});
			});
	}

	/**
	 * Read/write access to the model list of the selected LLM provider, so the
	 * model picker edits the right provider's list and selection.
	 * @param settings - Current plugin settings
	 */
	private llmModelAccess(settings: AudioRecorderSettings): LlmModelAccess {
		if (settings.llmProvider === LLM_PROVIDER_IDS.ANTHROPIC) {
			return {
				models: settings.llmAnthropicModels,
				selected: settings.llmAnthropicModel,
				setSelected: (id) => (settings.llmAnthropicModel = id),
			};
		}
		if (settings.llmProvider === LLM_PROVIDER_IDS.GEMINI) {
			return {
				models: settings.llmGeminiModels,
				selected: settings.llmGeminiModel,
				setSelected: (id) => (settings.llmGeminiModel = id),
			};
		}
		return {
			models: settings.llmOpenAiModels,
			selected: settings.llmOpenAiModel,
			setSelected: (id) => (settings.llmOpenAiModel = id),
		};
	}

	/**
	 * Renders the LLM provider and model pickers for this run. Chapters use
	 * the same provider, key, and model as LLM post-processing, so changing
	 * them here changes that shared configuration; the dialog re-renders on a
	 * change so the model list and the cost estimate follow the provider.
	 * @param settings - Current plugin settings
	 */
	private renderLlmPicker(settings: AudioRecorderSettings): void {
		new Setting(this.contentEl)
			.setName('LLM')
			.setDesc(
				'The provider and model that generate the chapters (shared ' +
					'with LLM post-processing).',
			)
			.addDropdown((dropdown) => {
				for (const option of LLM_PROVIDER_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown.setValue(settings.llmProvider).onChange((id) => {
					// Applied in place so the model list and cost estimate
					// follow; persisted only on generate, reverted on cancel.
					settings.llmProvider =
						id as AudioRecorderSettings['llmProvider'];
					void this.render();
				});
			});

		const access = this.llmModelAccess(settings);
		const models = ensureSelectedInList(access.models, access.selected);
		new Setting(this.contentEl).setName('Model').addDropdown((dropdown) => {
			for (const model of models) {
				dropdown.addOption(model, model);
			}
			dropdown.setValue(access.selected).onChange((id) => {
				// Applied in place; persisted only on generate, reverted on
				// cancel, matching the provider picker above.
				access.setSelected(id);
				void this.render();
			});
		});
	}

	/**
	 * Renders the up-front LLM cost estimate line, when cost estimates are
	 * enabled. The estimate is approximate: it prices the transcript as the
	 * LLM input the same way the post-processing estimate does.
	 * @param settings - Current plugin settings
	 * @param durationSeconds - Transcript extent used to size the estimate
	 */
	private renderCostEstimate(
		settings: AudioRecorderSettings,
		durationSeconds: number,
	): void {
		if (!settings.transcriptionShowCostEstimates) {
			return;
		}
		const cost = estimateLlmCost(settings, durationSeconds);
		const length = formatTimecode(Math.round(durationSeconds));
		const text =
			cost === null
				? `Estimated cost: not available for the selected LLM model (${length} transcript).`
				: `Estimated cost: about ${formatUsd(cost)} for this ${length} transcript (approximate).`;
		this.contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text,
		});
	}

	/**
	 * Starts generation, but first opens a confirmation dialog when the
	 * recording already has generated chapters, since regenerating replaces
	 * them. Confirming proceeds; cancelling leaves this dialog open.
	 */
	private generate(): void {
		if (this.generating) {
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
	 * Delegates generation to the shared service and closes. The service
	 * reports every outcome with a Notice and never throws, so the dialog
	 * closes immediately and lets it run in the background.
	 */
	private runGeneration(): void {
		if (this.generating) {
			return;
		}
		this.generating = true;
		// Commit the run's LLM/profile choice now that the user is generating,
		// so it persists as the shared default; onClose keeps it (committed).
		this.committed = true;
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

	override onClose(): void {
		// The pickers edit the shared LLM/profile settings in place so the model
		// list and cost estimate can follow the choice. Unless the user
		// generated, restore them, so cancelling (or closing) never leaves the
		// shared LLM configuration silently repointed.
		if (!this.committed) {
			const s = this.options.getSettings();
			s.llmProvider = this.initialRunSettings.llmProvider;
			s.llmAnthropicModel = this.initialRunSettings.llmAnthropicModel;
			s.llmGeminiModel = this.initialRunSettings.llmGeminiModel;
			s.llmOpenAiModel = this.initialRunSettings.llmOpenAiModel;
			s.transcriptionChapterPromptProfileId =
				this.initialRunSettings.transcriptionChapterPromptProfileId;
		}
		this.contentEl.empty();
	}
}
