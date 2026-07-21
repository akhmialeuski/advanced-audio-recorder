/**
 * Modal that configures and runs transcription for a single audio file.
 * The per-run options (engine, language, diarization, destination, file
 * format, in-note toggles, and LLM post-processing) default from settings
 * and can be overridden here for this run only - the saved settings are
 * never mutated. Shows progress and allows cancellation; the detailed
 * in-note templates (heading, timestamp/speaker/line format) remain in the
 * settings tab and are applied as configured there.
 * @module ui/TranscriptionModal
 */

import { MarkdownView, Modal, Notice, Setting } from 'obsidian';
import type { App, ButtonComponent, TFile } from 'obsidian';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from '../settings/settingsSchema';
import {
	LLM_TASK_OPTIONS,
	TRANSCRIPT_DESTINATION_OPTIONS,
	TRANSCRIPT_FILE_FORMAT_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
} from '../settings/labels';
import {
	addDropdown,
	addText,
	addToggle,
	type SettingsSectionContext,
} from '../settings/settingControls';
import { formatTimecode } from '../utils/TimeUtils';
import { probeAudioMetadata } from '../utils/AudioFileAnalyzer';
import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import {
	buildCostEstimate,
	costEstimateNeedsDuration,
	effectiveDiarize,
	effectiveTranscriptDestination,
	estimateTranscriptionCost,
	formatUsd,
	isProviderAvailableOnPlatform,
	providerSupportsDiarization,
	providerSupportsDictionary,
	selectedEngineModel,
	transcribeFile,
	TranscriptionCancelledError,
	type CancellationToken,
	type CostEstimate,
	type CostEstimateLine,
	type LlmTask,
	type SessionCostTracker,
	type TranscribeRunCost,
	type TranscriptDestination,
	type TranscriptFileFormat,
} from '../transcription/api';
import type { Transcript } from '../transcription/TranscriptTypes';
import { findProfile } from '../settings/dictionaryProfiles';
import type { SaveProgress } from '../types';

/** Default status label shown before the engine reports a finer-grained stage. */
const DEFAULT_TRANSCRIBE_LABEL = 'Transcribing...';

/**
 * Callbacks used when the modal is minimized while transcription continues.
 */
export type TranscriptionBackgroundProgressCallbacks = {
	/** Shows or updates the status-bar progress entry. */
	show: (progress: SaveProgress, restore: () => void) => void;
	/** Removes the status-bar progress entry owned by this modal. */
	clear: () => void;
};

/**
 * Options for a transcription modal instance.
 */
export type TranscriptionModalOptions = {
	autoStart?: boolean;
	notePath?: string;
	backgroundProgress?: TranscriptionBackgroundProgressCallbacks;
	/** Persists the run's dictionary-profile choice so it defaults next time. */
	onProfileSelected?: (id: string) => Promise<void>;
	/**
	 * Session-wide per-engine cost accumulator owned by the plugin, so the
	 * dialog can add this run's cost and show the running session total.
	 */
	costTracker?: SessionCostTracker;
	/**
	 * Generates auto chapters from a finished run's transcript. Invoked
	 * fire-and-forget when the run's auto-chapters toggle is on; the
	 * implementation reports its own progress and errors via Notices.
	 */
	generateChapters?: (file: TFile, transcript: Transcript) => Promise<void>;
};

/**
 * Formats the cost value of one estimate line: the amount for a priced
 * line, "no API cost" for the free local engine, or a short reason when it
 * could not be priced (unknown model, or the duration could not be read).
 * @param line - One line of the combined cost estimate
 */
function formatCostLine(line: CostEstimateLine): string {
	if (line.free) {
		return 'no API cost';
	}
	if (line.usd !== null) {
		return `~${formatUsd(line.usd)}`;
	}
	return line.reason === 'no-duration'
		? 'estimate unavailable (duration unreadable)'
		: 'no built-in rate';
}

/**
 * Transcription dialog for a single audio file.
 */
export class TranscriptionModal extends Modal {
	private cancelled = false;
	/** Aborts the in-flight run's HTTP requests when cancelled. */
	private abortController: AbortController | null = null;
	private running = false;
	private statusEl: HTMLElement | null = null;
	private elapsedEl: HTMLElement | null = null;
	/** Interval handle for the live elapsed-time counter (null when stopped). */
	private elapsedTimer: number | null = null;
	/** Wall-clock start of the current run, in ms, for the elapsed counter. */
	private runStartedAt = 0;
	private progressFillEl: HTMLElement | null = null;
	private configEl: HTMLElement | null = null;
	/** Container for the pre-run estimate and the session total lines. */
	private costEstimateEl: HTMLElement | null = null;
	/** Live "cost so far" line while a multi-part run is in flight. */
	private runningCostEl: HTMLElement | null = null;
	/** Probed audio duration in seconds; null when unknown/unreadable. */
	private durationSeconds: number | null = null;
	/**
	 * Bytes read to probe the duration, kept so the run itself can reuse them
	 * instead of reading the whole file a second time. Released once the run
	 * consumes them or the dialog closes.
	 */
	private probedBytes: ArrayBuffer | null = null;
	/** True once the duration probe was kicked off (guards a single probe). */
	private probeStarted = false;
	/** True once the duration probe finished (successfully or not). */
	private probeFinished = false;
	private runButton: ButtonComponent | null = null;
	private minimizeButton: ButtonComponent | null = null;
	private secondaryButton: ButtonComponent | null = null;
	private rendered = false;
	private minimized = false;
	private lastProgress: SaveProgress = {
		percent: 0,
		description: DEFAULT_TRANSCRIBE_LABEL,
	};
	/** Per-run settings copy: edited here, never persisted to plugin data. */
	private readonly runSettings: AudioRecorderSettings;
	/**
	 * Note the transcript is inserted into and timecode links are built
	 * against - resolved once at construction so the run targets the right
	 * note even if the active pane changes before it starts.
	 */
	private readonly notePath: string;

	constructor(
		app: App,
		private readonly file: TFile,
		getSettings: () => AudioRecorderSettings,
		private readonly options: TranscriptionModalOptions = {},
	) {
		super(app);
		// Shallow copy is enough: every option edited here is a primitive.
		this.runSettings = { ...getSettings() };
		// Prefer an explicit note (transcribe-on-save passes the note the
		// recording embed was inserted into); otherwise the active Markdown
		// note. When neither exists (e.g. the audio file itself is the active
		// pane, as with the command), in-note insertion cannot work, so an
		// in-note-only destination is downgraded to a file up front instead of
		// always falling back with a misleading "could not insert" notice.
		this.notePath =
			this.options.notePath ??
			app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ??
			'';
		this.runSettings.transcriptDestination = effectiveTranscriptDestination(
			this.runSettings.transcriptDestination,
			this.notePath !== '',
		);
	}

	override onOpen(): void {
		if (this.rendered) {
			this.minimized = false;
			this.clearBackgroundProgress();
			return;
		}

		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl).setName('Transcribe audio').setHeading();
		contentEl.createEl('p', {
			cls: 'aar-modal-config',
			text: `Source: ${this.file.name}`,
		});

		this.configEl = contentEl.createDiv({ cls: 'aar-transcribe-options' });
		this.renderConfig();

		// Pre-run cost estimate and session total; refreshed on every config
		// re-render (the engine dropdown triggers one) and when the duration
		// probe finishes. The probe is kicked off lazily from
		// updateCostEstimate only when a priced line actually needs the
		// duration, so a disabled estimate, a free local run, or an auto-run
		// never reads the whole file for nothing.
		this.costEstimateEl = contentEl.createDiv({
			cls: 'aar-transcribe-cost',
		});
		this.updateCostEstimate();

		this.statusEl = contentEl.createDiv({ cls: 'aar-modal-status' });
		this.statusEl.setText('Ready.');
		const progress = contentEl.createDiv({
			cls: 'aar-transcribe-progress',
		});
		this.progressFillEl = progress.createDiv({
			cls: 'aar-transcribe-progress-bar',
		});
		// Live elapsed-time counter; hidden until a run starts so an idle dialog
		// shows no stray "0:00".
		this.elapsedEl = contentEl.createDiv({ cls: 'aar-transcribe-elapsed' });
		// Live cumulative cost while a multi-part run is in flight.
		this.runningCostEl = contentEl.createDiv({
			cls: 'aar-transcribe-cost-running',
		});

		new Setting(contentEl)
			.addButton((button) => {
				this.runButton = button;
				button
					.setButtonText('Transcribe')
					.setCta()
					.onClick(() => {
						void this.startRun();
					});
			})
			.addButton((button) => {
				this.minimizeButton = button;
				button
					.setButtonText('Minimize')
					.setDisabled(true)
					.onClick(() => {
						this.minimize();
					});
			})
			.addButton((button) => {
				this.secondaryButton = button;
				button.setButtonText('Close').onClick(() => {
					if (this.running) {
						this.cancelRun();
					} else {
						this.close();
					}
				});
			});

		this.rendered = true;
		// The first renderConfig() ran before the button existed; set its
		// initial state now so a stored unavailable engine reads as blocked.
		this.refreshRunButtonState();

		if (this.options.autoStart) {
			// Auto-run for the transcribe-on-save hook: the modal still shows
			// progress and offers cancel, so an automatic run stays visible and
			// interruptible instead of being a silent background job.
			void this.startRun();
		}
	}

	/**
	 * Renders the editable per-run option controls into the config container.
	 * Re-invoked when an option that reveals or hides others changes.
	 */
	private renderConfig(): void {
		const container = this.configEl;
		if (!container) {
			return;
		}
		container.empty();
		const s = this.runSettings;
		const ctx: SettingsSectionContext = {
			containerEl: container,
			settings: s,
			// Per-run dialog: options are not persisted to plugin data.
			save: () => Promise.resolve(),
			rerender: () => {
				this.renderConfig();
			},
			saveDebounced: () => {
				/* no debounced persistence in the dialog */
			},
		};

		addDropdown(ctx, {
			name: 'Engine',
			// Explain the blocked run when the stored engine cannot execute
			// here (a local whisper.cpp selection synced to mobile), so the
			// disabled Transcribe button below is self-evident.
			desc: this.isSelectedEngineAvailable()
				? undefined
				: 'The selected engine is not available on this device. Pick a cloud engine to transcribe here.',
			// Engines the platform cannot run stay listed but blocked,
			// matching the settings tab.
			options: TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => ({
				...option,
				disabled: !isProviderAvailableOnPlatform(
					option.value as TranscriptionProviderId,
				),
			})),
			get: () => s.transcriptionProvider,
			set: (v) =>
				(s.transcriptionProvider = v as TranscriptionProviderId),
			// Re-render so the diarization toggle reflects the new engine's
			// capabilities (enabled only when the engine can diarize).
			rerender: true,
		});
		addText(ctx, {
			name: 'Language',
			desc: 'ISO code (e.g. en, ru, es) or "auto" to detect.',
			get: () => s.transcriptionLanguage,
			set: (v) => (s.transcriptionLanguage = v.trim() || 'auto'),
		});
		const canDiarize = providerSupportsDiarization(s.transcriptionProvider);
		// Whether speaker labels will actually be produced for this run; gates the
		// Include speakers toggle below the same way it gates the toggle itself.
		const diarizes = effectiveDiarize(
			s.transcriptionProvider,
			s.transcriptionDiarize,
		);
		addToggle(ctx, {
			name: 'Speaker diarization',
			desc: canDiarize
				? 'Request speaker labels (providers detect the speaker count automatically).'
				: 'Not supported by the selected engine. Use Deepgram for speaker labels.',
			// Reflect the effective state: a stored "on" from a diarizing engine
			// must read as off here when the chosen engine cannot diarize.
			get: () =>
				effectiveDiarize(
					s.transcriptionProvider,
					s.transcriptionDiarize,
				),
			set: (v) => (s.transcriptionDiarize = v),
			disabled: !canDiarize,
			// Re-render so the Include speakers toggle below tracks this one:
			// without diarization there are no speaker labels to include.
			rerender: true,
		});
		addToggle(ctx, {
			name: 'Word-level timestamps',
			desc: 'Request per-word timing (recorded in JSON file output only).',
			get: () => s.transcriptionWordTimestamps,
			set: (v) => (s.transcriptionWordTimestamps = v),
		});

		const profiles = s.transcriptionDictionaryProfiles;
		// A stored id whose profile was removed reads as None here.
		const selectedProfileId = findProfile(
			profiles,
			s.transcriptionDictionaryProfileId,
		)
			? s.transcriptionDictionaryProfileId
			: '';
		addDropdown(ctx, {
			name: 'Dictionary',
			desc: providerSupportsDictionary(s.transcriptionProvider)
				? 'Bias recognition toward a named glossary, or None.'
				: 'The selected engine cannot bias recognition; the dictionary is ignored.',
			options: [
				{ value: '', label: 'None' },
				...profiles.map((profile) => ({
					value: profile.id,
					label: profile.name,
				})),
			],
			get: () => selectedProfileId,
			set: (v) => {
				// Affects this run (runSettings clone); persist as the remembered
				// choice for the next dialog and for transcribe-on-save.
				s.transcriptionDictionaryProfileId = v;
				void this.options.onProfileSelected?.(v);
			},
		});

		addDropdown(ctx, {
			name: 'Destination',
			options: TRANSCRIPT_DESTINATION_OPTIONS,
			get: () => s.transcriptDestination,
			set: (v) => (s.transcriptDestination = v as TranscriptDestination),
			rerender: true,
		});
		if (s.transcriptDestination !== 'note') {
			addDropdown(ctx, {
				name: 'File format',
				options: TRANSCRIPT_FILE_FORMAT_OPTIONS,
				get: () => s.transcriptFileFormat,
				set: (v) =>
					(s.transcriptFileFormat = v as TranscriptFileFormat),
			});
		}
		// In-note formatting applies only when the transcript Markdown is
		// rendered into the note (note/both). For file/link only the sidecar
		// file is produced, so these toggles would have no effect.
		if (
			s.transcriptDestination === 'note' ||
			s.transcriptDestination === 'both'
		) {
			addToggle(ctx, {
				name: 'Include timestamps',
				get: () => s.transcriptIncludeTimestamps,
				set: (v) => (s.transcriptIncludeTimestamps = v),
			});
			addToggle(ctx, {
				name: 'Include speakers',
				desc: diarizes
					? undefined
					: 'Available only with speaker diarization.',
				get: () => s.transcriptIncludeSpeakers,
				set: (v) => (s.transcriptIncludeSpeakers = v),
				disabled: !diarizes,
			});
		}

		addToggle(ctx, {
			name: 'LLM post-processing',
			desc: 'Clean up, summarize, or apply a custom instruction with an LLM.',
			get: () => s.llmPostProcessEnabled,
			set: (v) => (s.llmPostProcessEnabled = v),
			rerender: true,
		});
		if (s.llmPostProcessEnabled) {
			// Only the task is per-run here; the LLM provider, endpoint, key,
			// and model stay in settings (a key cannot be entered safely in a
			// transient dialog), so switching providers belongs in the tab.
			addDropdown(ctx, {
				name: 'LLM task',
				options: LLM_TASK_OPTIONS,
				get: () => s.llmPostProcessTask,
				set: (v) => (s.llmPostProcessTask = v as LlmTask),
			});
		}
		if (s.transcriptionAutoChaptersEnabled) {
			addToggle(ctx, {
				name: 'Generate chapters',
				desc: 'After transcribing, ask the LLM to add titled chapters to the enhanced player.',
				get: () => s.transcriptionAutoChaptersOnTranscribe,
				set: (v) => (s.transcriptionAutoChaptersOnTranscribe = v),
			});
		}
		// Re-evaluated on every rerender (the Engine dropdown triggers one),
		// so the Transcribe button tracks the freshly selected engine.
		this.refreshRunButtonState();
		// The estimate depends on the engine/model picked for this run, so it
		// tracks the config re-render too.
		this.updateCostEstimate();
	}

	/**
	 * Kicks off the duration probe at most once. Only called when a priced
	 * estimate line actually needs the duration, so a disabled estimate or a
	 * free local run never triggers a read.
	 */
	private maybeProbeDuration(): void {
		if (this.probeStarted) {
			return;
		}
		this.probeStarted = true;
		void this.probeDuration();
	}

	/**
	 * Probes the audio duration from the container headers (no PCM decode)
	 * and refreshes the estimate once it resolves. Failure leaves the
	 * duration unknown; the estimate degrades instead of blocking the dialog.
	 */
	private async probeDuration(): Promise<void> {
		try {
			const bytes = await this.app.vault.readBinary(this.file);
			// Keep the bytes so the imminent run reuses them rather than reading
			// the whole file again.
			this.probedBytes = bytes;
			const metadata = await probeAudioMetadata(bytes, this.file.path);
			this.durationSeconds = metadata?.durationSeconds ?? null;
		} catch {
			this.durationSeconds = null;
			this.probedBytes = null;
		}
		this.probeFinished = true;
		this.updateCostEstimate();
	}

	/**
	 * Renders the combined pre-run estimate (transcription plus any
	 * post-processing pass) and the running session total. Hidden entirely
	 * when cost estimates are off. The audio probe is deferred to here and
	 * started only when a priced line needs the duration, so a disabled
	 * estimate, a free local run, or an auto-run never reads the whole file
	 * just to price it - and an auto-run, which immediately reads the file to
	 * transcribe, never holds two copies at once.
	 */
	private updateCostEstimate(): void {
		const el = this.costEstimateEl;
		if (!el) {
			return;
		}
		el.empty();
		const s = this.runSettings;
		if (!s.transcriptionShowCostEstimates) {
			return;
		}
		if (
			costEstimateNeedsDuration(s) &&
			!this.probeFinished &&
			!this.options.autoStart
		) {
			this.maybeProbeDuration();
			el.createDiv({
				cls: 'aar-transcribe-cost-title',
				text: 'Estimating cost...',
			});
		} else if (!this.options.autoStart || this.probeFinished) {
			this.renderCostEstimate(
				el,
				buildCostEstimate(s, this.durationSeconds),
			);
		}
		this.renderSessionTotal(el);
	}

	/** Renders the estimate breakdown: a line per part, the total, and pricing links. */
	private renderCostEstimate(el: HTMLElement, estimate: CostEstimate): void {
		el.createDiv({
			cls: 'aar-transcribe-cost-title',
			text: 'Estimated cost',
		});
		const list = el.createEl('ul', { cls: 'aar-transcribe-cost-list' });
		for (const line of estimate.lines) {
			const model = line.model ? ` (${line.model})` : '';
			list.createEl('li', {
				text: `${line.label} - ${line.providerName}${model}: ${formatCostLine(line)}`,
			});
		}
		if (estimate.totalUsd !== null) {
			const suffix = estimate.hasUnpriced
				? ' (excludes unpriced parts)'
				: '';
			el.createDiv({
				cls: 'aar-transcribe-cost-total',
				text: `Estimated total: ~${formatUsd(estimate.totalUsd)}${suffix}`,
			});
		}
		// buildCostEstimate adds a second line only for the post-processing pass.
		// That pass is billed by its own provider, which reports no usage, so it
		// is priced in this pre-run estimate but never added to the session
		// counter or the post-run "Transcription cost" notice. Say so here so the
		// smaller amount reported after the run does not read as a discrepancy.
		if (estimate.lines.length > 1) {
			el.createDiv({
				cls: 'aar-transcribe-cost-note',
				text: 'Post-processing is billed separately by its provider and is not added to the session total.',
			});
		}
		this.renderPricingLinks(el, estimate);
	}

	/**
	 * Renders one "check current pricing" link per distinct provider the
	 * estimate involves, replacing a static "verify against your provider"
	 * caveat so the link points at whichever providers this run uses.
	 */
	private renderPricingLinks(el: HTMLElement, estimate: CostEstimate): void {
		// Collect distinct providers as a definite-URL shape so the anchor below
		// needs no fallback for a possibly-missing href.
		const seen = new Set<string>();
		const linked: { providerName: string; pricingUrl: string }[] = [];
		for (const line of estimate.lines) {
			if (!line.pricingUrl || seen.has(line.pricingUrl)) {
				continue;
			}
			seen.add(line.pricingUrl);
			linked.push({
				providerName: line.providerName,
				pricingUrl: line.pricingUrl,
			});
		}
		if (linked.length === 0) {
			return;
		}
		const note = el.createDiv({ cls: 'aar-transcribe-cost-note' });
		note.createSpan({
			text: 'Built-in approximate rates. Check current pricing: ',
		});
		linked.forEach((provider, index) => {
			if (index > 0) {
				note.createSpan({ text: ', ' });
			}
			// Open the pricing page in the browser rather than navigating the
			// Obsidian window, matching the convention used for every other
			// external anchor in the plugin.
			note.createEl('a', {
				text: provider.providerName,
				attr: {
					href: provider.pricingUrl,
					target: '_blank',
					rel: 'noopener',
				},
			});
		});
		note.createSpan({ text: '.' });
	}

	/** Renders the running per-session spending line under the estimate. */
	private renderSessionTotal(el: HTMLElement): void {
		const tracker = this.options.costTracker;
		if (!tracker?.hasEntries()) {
			return;
		}
		const unpriced = tracker.unpricedRuns();
		const suffix =
			unpriced > 0
				? ` (${String(unpriced)} run${unpriced > 1 ? 's' : ''} not priced)`
				: '';
		el.createDiv({
			cls: 'aar-transcribe-cost-session',
			text: `Spent this session: ~${formatUsd(tracker.totalUsd())}${suffix}`,
		});
	}

	/**
	 * Adds a finished run's cost to the session tracker and returns the
	 * amount recorded. Prefers the provider-reported actuals; when the run
	 * could not be priced from usage, falls back to the duration-based
	 * transcription estimate so the session counter does not silently
	 * under-count. The free local engine is never recorded. This only
	 * accounts the transcription cost; any LLM post-processing is billed by
	 * its own provider, which returns no usage, so it is left out of the
	 * session total (the pre-run estimate still shows it). The caller decides
	 * whether to surface a notice and calls this exactly once per run.
	 * @param settings - The run's settings snapshot
	 * @param cost - Cost summary reported for the run
	 * @returns The USD recorded, or null when the run could not be priced
	 */
	private accountRunCost(
		settings: AudioRecorderSettings,
		cost: TranscribeRunCost,
	): number | null {
		if (
			!settings.transcriptionShowCostEstimates ||
			cost.engineId === TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER
		) {
			return null;
		}
		const usd =
			cost.usd ??
			(this.durationSeconds !== null
				? estimateTranscriptionCost(
						settings.transcriptionProvider,
						selectedEngineModel(
							settings,
							settings.transcriptionProvider,
						),
						this.durationSeconds,
					)
				: null);
		this.options.costTracker?.add(cost.engineId, usd);
		// Refresh the session line so a follow-up run sees the new total.
		this.updateCostEstimate();
		return usd;
	}

	/**
	 * Whether the engine selected for this run can execute on this
	 * platform. A stored engine synced from another platform (local
	 * whisper.cpp on mobile) stays visible but cannot transcribe here.
	 * @returns True when the selected engine is usable on this platform
	 */
	private isSelectedEngineAvailable(): boolean {
		return isProviderAvailableOnPlatform(
			this.runSettings.transcriptionProvider,
		);
	}

	/**
	 * Disables the Transcribe button while a run is in flight or when the
	 * selected engine cannot run on this platform, so a stored engine
	 * synced from another device cannot be launched into a doomed run.
	 */
	private refreshRunButtonState(): void {
		this.runButton?.setDisabled(
			this.running || !this.isSelectedEngineAvailable(),
		);
	}

	/**
	 * Runs the transcription, updating progress and handling errors.
	 */
	private async startRun(): Promise<void> {
		if (this.running) {
			return;
		}
		// Guard the run itself, not just the option's disabled state: a
		// stored engine that cannot execute here (local whisper.cpp on
		// mobile) stays the selected value, so without this a click would
		// launch a doomed run that only fails with a generic error.
		if (!this.isSelectedEngineAvailable()) {
			new Notice(
				'The selected engine is not available on this device. Pick a cloud engine to transcribe here.',
			);
			return;
		}
		this.setRunning(true);
		this.updateProgress(0, DEFAULT_TRANSCRIBE_LABEL);
		// Snapshot the options so a control toggled mid-run cannot change an
		// in-flight job; edits only affect the next attempt after a failure.
		const settings = { ...this.runSettings };
		this.abortController = new AbortController();
		const token: CancellationToken = {
			isCancelled: () => this.cancelled,
			// Lets abort-capable providers stop an in-flight upload at once;
			// requestUrl-only endpoints still finish or time out on their own.
			signal: this.abortController.signal,
		};
		this.runningCostEl?.setText('');
		// The last cumulative cost the run reported, kept so an already-billed
		// run is still counted when the transcript write fails after the
		// provider call succeeded (a read-only or full vault).
		let lastCost: TranscribeRunCost | null = null;
		let accounted = false;
		try {
			const result = await transcribeFile(
				this.app,
				() => settings,
				this.file,
				{
					notePathForLinks: this.notePath,
					token,
					// Reuse the bytes read for the estimate probe so a manual run
					// does not read the whole file twice (undefined on an auto-run,
					// which never probes).
					audioBytes: this.probedBytes ?? undefined,
					onProgress: (fraction, label) => {
						this.updateProgress(fraction, label);
					},
					onCost: (cost) => {
						lastCost = cost;
						// Live spending line: only when the parts completed so
						// far actually priced to something.
						if (
							settings.transcriptionShowCostEstimates &&
							cost.usd !== null &&
							cost.usd > 0
						) {
							this.runningCostEl?.setText(
								`Cost so far: ~${formatUsd(cost.usd)}`,
							);
						}
					},
				},
			);
			const usd = this.accountRunCost(settings, result.cost);
			accounted = true;
			if (
				settings.transcriptionAutoChaptersEnabled &&
				settings.transcriptionAutoChaptersOnTranscribe
			) {
				// Fire-and-forget on the fresh in-memory transcript: the
				// dialog closes normally while chapters generate in the
				// background, reporting through their own Notices.
				void this.options.generateChapters?.(
					this.file,
					result.transcript,
				);
			}
			if (usd !== null) {
				const total = this.options.costTracker?.totalUsd();
				new Notice(
					`Transcription cost ~${formatUsd(usd)}` +
						(total !== undefined
							? ` (session total ~${formatUsd(total)})`
							: '') +
						'.',
				);
			}
			this.setRunning(false);
			this.clearBackgroundProgress();
			if (this.minimized) {
				this.minimized = false;
				this.contentEl.empty();
				this.rendered = false;
			} else {
				this.close();
			}
		} catch (error) {
			// The provider was billed even if writing the transcript failed
			// afterwards (or the user cancelled after some parts completed),
			// so count what the run reported before surfacing the error, and
			// only once.
			if (!accounted && lastCost) {
				this.accountRunCost(settings, lastCost);
				accounted = true;
			}
			if (error instanceof TranscriptionCancelledError) {
				new Notice('Transcription cancelled.');
				this.statusEl?.setText('Cancelled.');
			} else {
				const message =
					error instanceof Error ? error.message : String(error);
				new Notice(`Transcription failed: ${message}`);
				this.statusEl?.setText(`Failed: ${message}`);
			}
			if (this.minimized) {
				this.restore();
			}
		} finally {
			if (this.running) {
				this.setRunning(false);
			}
			this.clearBackgroundProgress();
			// The run consumed the probe bytes (or failed); drop the reference so
			// a large recording is not held after the run. A retry re-reads.
			this.probedBytes = null;
		}
	}

	/**
	 * Cancels the in-flight run: flags the cooperative token and aborts the
	 * current HTTP request where the transport supports it.
	 */
	private cancelRun(): void {
		this.cancelled = true;
		this.abortController?.abort();
	}

	/**
	 * Toggles the running state: disables the config and run button while a
	 * job is in flight and switches the secondary button between cancel and
	 * close.
	 * @param running - Whether a transcription is in progress
	 */
	private setRunning(running: boolean): void {
		this.running = running;
		if (running) {
			this.cancelled = false;
			this.startElapsedTimer();
		} else {
			this.stopElapsedTimer();
		}
		// Also stays disabled when the selected engine cannot run here, so
		// finishing a run does not re-enable a doomed one.
		this.runButton?.setDisabled(
			running || !this.isSelectedEngineAvailable(),
		);
		this.minimizeButton?.setDisabled(!running);
		this.secondaryButton?.setButtonText(running ? 'Cancel' : 'Close');
		this.configEl?.toggleClass('aar-transcribe-options-disabled', running);
	}

	/**
	 * Starts the live elapsed-time counter, ticking once a second. The same
	 * element is reused across minimize/restore, so the counter keeps running
	 * visually while the job continues.
	 */
	private startElapsedTimer(): void {
		this.runStartedAt = Date.now();
		this.renderElapsed();
		if (this.elapsedTimer !== null) {
			window.clearInterval(this.elapsedTimer);
		}
		this.elapsedTimer = window.setInterval(() => {
			this.renderElapsed();
		}, 1000);
	}

	/** Stops the elapsed-time counter, leaving the final value on screen. */
	private stopElapsedTimer(): void {
		if (this.elapsedTimer !== null) {
			window.clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}
	}

	/** Writes the elapsed time since the run started as mm:ss (or h:mm:ss). */
	private renderElapsed(): void {
		if (!this.elapsedEl) {
			return;
		}
		const seconds = Math.floor((Date.now() - this.runStartedAt) / 1000);
		this.elapsedEl.setText(`Elapsed ${formatTimecode(seconds)}`);
	}

	/**
	 * Updates the progress bar and status label.
	 */
	private updateProgress(fraction: number, label: string): void {
		this.statusEl?.setText(label);
		if (this.progressFillEl) {
			const percent = Math.round(
				Math.max(0, Math.min(1, fraction)) * 100,
			);
			this.lastProgress = { percent, description: label };
			this.progressFillEl.setCssProps({
				'--aar-transcribe-progress': `${String(percent)}%`,
			});
			this.reportBackgroundProgress();
		}
	}

	/**
	 * Minimizes the modal while keeping the current transcription running.
	 */
	private minimize(): void {
		if (!this.running || this.minimized) {
			return;
		}
		this.minimized = true;
		this.reportBackgroundProgress();
		this.close();
	}

	/**
	 * Restores a minimized modal.
	 */
	private restore(): void {
		if (!this.minimized) {
			return;
		}
		this.minimized = false;
		this.clearBackgroundProgress();
		this.open();
	}

	/**
	 * Publishes the latest progress to the status bar while minimized.
	 */
	private reportBackgroundProgress(): void {
		if (!this.minimized) {
			return;
		}
		this.options.backgroundProgress?.show(this.lastProgress, () => {
			this.restore();
		});
	}

	/**
	 * Clears this modal's background progress entry.
	 */
	private clearBackgroundProgress(): void {
		this.options.backgroundProgress?.clear();
	}

	override onClose(): void {
		if (this.minimized && this.running) {
			return;
		}
		if (this.running) {
			this.cancelRun();
		}
		this.stopElapsedTimer();
		this.clearBackgroundProgress();
		// Release any bytes cached for the estimate probe on close.
		this.probedBytes = null;
		this.contentEl.empty();
		this.rendered = false;
	}
}
