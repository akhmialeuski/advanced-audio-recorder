/**
 * Orchestrates transcription: read the audio, prepare provider-ready
 * payloads (either the original container untouched when the provider
 * accepts it and it fits the limit, or a decoded 16 kHz mono WAV split
 * into upload-sized chunks), transcribe each payload through the configured
 * provider, stitch the results back onto the original timeline, render
 * Markdown (with clickable timecode links), and optionally post-process
 * with an LLM. LLM post-processing is best-effort: a failure falls back to
 * the raw transcript rather than discarding the completed work.
 * @module transcription/TranscriptionService
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { NEVER_CANCELLED, type CancellationToken } from '../utils/cancellation';
import {
	BYTES_PER_MB,
	MS_PER_SECOND,
	PLUGIN_LOG_PREFIX,
	TRANSCRIBE_CHUNK_PROGRESS_CEILING,
	TRANSCRIBE_RETRY_BASE_DELAY_MS,
	TRANSCRIBE_RETRY_MAX_ATTEMPTS,
	TRANSCRIBE_RETRY_MAX_DELAY_MS,
} from '../constants';
import { HttpError } from './httpClient';
import { delay } from '../utils/TimeUtils';
import type { WhisperResult } from './providers/whisperResponse';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../settings/settingsSchema';
import { advancedTwoPassEnabled } from '../settings/settingsSchema';
import {
	audioMimeFromExtension,
	audioPrepOptions,
	prepareAudio,
	type PreparedPayload,
} from './audioPrep';
import type {
	AudioPayload,
	TranscribeOptions,
	TranscriptionProvider,
} from './providers/TranscriptionProvider';
import { TranscriptTruncatedError } from './transcriptionErrors';
import { formatTimecode } from '../utils/TimeUtils';
import {
	buildTranscript,
	collectFirstTurns,
	plainText,
	renameSpeakers,
	stitchChunks,
	stripSpeakers,
} from './transcriptModel';
import { emptyNameMap } from '../sidecar/recordingSidecarModel';
import type {
	ParticipantUpdate,
	SpeakerEntry,
	TranscriptSection,
} from '../sidecar/recordingSidecarModel';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	type TimecodeLinkBuilder,
	type TranscriptMarkdownOptions,
} from './transcriptFormat';
import { buildPostProcessPrompt } from './llmPostProcess';
import { describeDictionaryOmission } from './dictionaryBias';
import { planDictionaryBias } from './providers/engines';
import {
	advancedBiasChannel,
	advancedBiasUnsupportedReason,
	meetsLengthSafeguard,
	planAdvancedBias,
} from './advanced/advancedBias';
import { generateContext } from './advanced/contextPipeline';
import {
	resolveDictionaryTermList,
	resolveLlmPrompt,
	resolveRunParticipants,
} from '../settings/profileResolution';
import { selectedProfileId } from '../settings/profiles';
import { createLlmProvider, createTranscriptionProvider } from './factories';
import { vendorMaxTokens } from '../providers/providers';
import { jobVendorId } from './llm/vendors';
import {
	effectiveDiarize,
	effectiveWordTimestamps,
} from './providers/capabilities';
import type { LlmProvider } from './llm/LlmProvider';
import { runLlmStep, type LlmCostSink } from './llm/llmStep';
import type { Transcript, TranscriptionUsage } from './TranscriptTypes';
import {
	costFromUsage,
	resolveEnginePricing,
	selectedEngineModel,
	sumUsage,
} from './costs';

// Cancellation belongs to every long job, not to transcription alone, so it
// lives in utils and is re-exported here for the callers that already reach
// for it through the service.
export { NEVER_CANCELLED, type CancellationToken };

/** Options for a transcription run. */
export interface TranscribeRunOptions {
	/** Source note path used to generate relative timecode links. */
	notePathForLinks: string;
	/** Progress callback: fraction 0..1 and a short stage label. */
	onProgress?: ((fraction: number, label: string) => void) | undefined;
	/**
	 * Running-cost callback, invoked after each completed part with the
	 * cumulative cost so far, so a long multi-part run can show spending
	 * live rather than only at the end.
	 */
	onCost?: ((cost: TranscribeRunCost) => void) | undefined;
	/**
	 * Pre-read audio bytes to transcribe. When the caller already holds the
	 * file's bytes - the dialog reads them to probe the duration for the cost
	 * estimate - passing them here avoids reading the whole file a second
	 * time. Omitted, the service reads the file itself.
	 */
	audioBytes?: ArrayBuffer | undefined;
	/** Cancellation token. */
	token?: CancellationToken | undefined;
	/**
	 * Recording sidecar access for speaker-name continuity: stored names are
	 * re-applied to a fresh diarized transcript and the roster is refreshed.
	 * Absent, the run is stateless and its speakers keep the engine labels.
	 */
	sidecar?: TranscriptionSidecarAccess | undefined;
}

/**
 * Cost summary of a (partial or finished) transcription run, computed
 * from what the provider actually reported billing for.
 */
export interface TranscribeRunCost {
	/** Engine that ran. */
	engineId: string;
	/**
	 * Cost in USD, or null when it could not be priced (no built-in rate
	 * for the model, or the provider reported no billable usage).
	 */
	usd: number | null;
	/** Summed usage every completed part reported. */
	usage: TranscriptionUsage;
}

/** Result of a transcription run. */
export interface TranscribeRunResult {
	transcript: Transcript;
	/** Rendered Markdown for insertion into a note. */
	markdown: string;
	/** Cost of the run, from provider-reported usage. */
	cost: TranscribeRunCost;
}

/** Raised when a run is cancelled. */
export class TranscriptionCancelledError extends Error {
	constructor() {
		super('Transcription cancelled');
		this.name = 'TranscriptionCancelledError';
	}
}

/**
 * The narrow slice of the recording sidecar store the service needs: read the
 * stored transcript section (for previously assigned speaker names) and write
 * the refreshed roster back. Kept structural so tests can stub it without the
 * real store.
 */
export interface TranscriptionSidecarAccess {
	/** Returns the stored transcript section for a recording path. */
	getTranscript(path: string): Promise<TranscriptSection>;
	/**
	 * Replaces the speaker roster for a recording path and, in the same write,
	 * merges the run's participant roster into the recording's own.
	 */
	setSpeakers(
		path: string,
		entries: readonly SpeakerEntry[],
		participants?: ParticipantUpdate,
	): Promise<void>;
}

/**
 * Provider factories the service depends on. Injectable so tests can supply
 * deterministic providers; defaults build the real providers from settings.
 */
export interface TranscriptionServiceDeps {
	/**
	 * Where the run reports the estimated cost of each LLM call it makes (the
	 * post-processing pass and the advanced context agents). Absent, the run
	 * still works and simply accounts nothing.
	 */
	costSink?: LlmCostSink | undefined;
	/** Builds the transcription provider from settings. */
	createProvider?: (settings: AudioRecorderSettings) => TranscriptionProvider;
	/** Builds the LLM provider for the engine a job names. */
	createLlm?: (
		settings: AudioRecorderSettings,
		vendorId: LlmProviderId,
	) => LlmProvider;
}

/** One part of a run, and everywhere its outcome is recorded. */
interface PartRun {
	/** The active transcription provider. */
	readonly provider: TranscriptionProvider;
	/** The prepared part to transcribe. */
	readonly prepared: PreparedPayload;
	/** Per-request provider options (language, diarize, bias). */
	readonly providerOptions: TranscribeOptions;
	/** Cancellation for the run this part belongs to. */
	readonly token: CancellationToken;
	/** Human label for the part ('' for a single indivisible job). */
	readonly label: string;
	/** Accumulates successful per-part transcripts (mutated). */
	readonly results: {
		offsetSeconds: number;
		transcript: Transcript;
		usage?: TranscriptionUsage;
	}[];
	/** Accumulates recoverable per-part failures (mutated). */
	readonly failedParts: { label: string; message: string }[];
	/**
	 * Accumulates usage from billed-but-discarded truncated attempts, so their
	 * cost is counted even though their transcript is thrown away and retried
	 * (mutated).
	 */
	readonly discardedUsage: TranscriptionUsage[];
	/**
	 * Reports that the part is waiting before being sent again, so the dialog
	 * says the run is still working rather than sitting on a frozen line.
	 * @param waitMs - How long the run is about to wait
	 * @param label - The part that is waiting. Passed rather than captured,
	 *   because a subdivided piece carries its parent's callback and does not
	 *   share its label
	 */
	onRetryWait(waitMs: number, label: string): void;
}

/**
 * How long to wait before sending a part again, or null when it should not be
 * sent again at all.
 *
 * Retrying was designed around one situation - a model that truncated its own
 * answer, where the point is to send smaller input - and the far more common
 * class of failure had no place in it: the temporary refusals that come with
 * every paid endpoint. A rate limit is temporary by definition and clears in
 * seconds, and the plugin already told the user so while doing nothing about it
 * itself.
 *
 * What the provider asks for beats any guess, so `Retry-After` wins when it
 * arrives. A provider asking for longer than the run is willing to sit out is
 * telling the user to come back later rather than to wait, so the part is
 * reported missing instead of freezing the run on a dialog that says nothing is
 * happening.
 * @param error - What the attempt failed with
 * @param attempt - Which attempt just failed, counting from one
 * @returns The pause in milliseconds, or null to stop trying
 */
function retryWaitMs(error: unknown, attempt: number): number | null {
	if (attempt >= TRANSCRIBE_RETRY_MAX_ATTEMPTS) {
		return null;
	}
	if (!(error instanceof HttpError) || !error.retryable) {
		return null;
	}
	const advised = error.retryAfterMs;
	if (advised !== undefined) {
		return advised <= TRANSCRIBE_RETRY_MAX_DELAY_MS ? advised : null;
	}
	return Math.min(
		TRANSCRIBE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
		TRANSCRIBE_RETRY_MAX_DELAY_MS,
	);
}

/**
 * Runs the full transcription pipeline for an audio file.
 */
export class TranscriptionService {
	private readonly createProvider: (
		settings: AudioRecorderSettings,
	) => TranscriptionProvider;
	private readonly createLlm: (
		settings: AudioRecorderSettings,
		vendorId: LlmProviderId,
	) => LlmProvider;
	/** Where LLM spending is reported; undefined when nothing accounts it. */
	private readonly costSink: LlmCostSink | undefined;

	constructor(
		private readonly app: App,
		private getSettings: () => AudioRecorderSettings,
		deps: TranscriptionServiceDeps = {},
	) {
		this.createProvider =
			deps.createProvider ?? createTranscriptionProvider;
		this.createLlm = deps.createLlm ?? createLlmProvider;
		this.costSink = deps.costSink;
	}

	/**
	 * Transcribes an audio file and returns the transcript and Markdown.
	 * @param file - Audio file to transcribe
	 * @param options - Run options
	 */
	async run(
		file: TFile,
		options: TranscribeRunOptions,
	): Promise<TranscribeRunResult> {
		const settings = this.getSettings();
		const token = options.token ?? NEVER_CANCELLED;
		const provider = this.createProvider(settings);
		// One gate for the whole run: a stale "on" left from a diarizing engine
		// is ignored and a non-diarizing engine never sends a field it would
		// silently drop. The same value decides both whether to request speaker
		// labels here and whether to strip any the provider returned (below), so
		// the request-time and output-time decisions can never diverge.
		const diarize = effectiveDiarize(
			settings.transcriptionProvider,
			settings.transcriptionDiarize,
		);
		// Plan the dictionary once: resolve the selected profile's terms (empty
		// for None or a stale id), then decide what the engine actually sends.
		// The terms depend on the engine and, for Deepgram, the model. Terms are
		// dropped for an engine that cannot bias, an over-limit list is trimmed
		// to the provider's cap, and a Whisper prompt is bounded to its token
		// window, so a request never carries terms the provider would reject or
		// silently ignore. Whatever is dropped is surfaced below.
		const dictionaryPlan = planDictionaryBias(
			settings.transcriptionProvider,
			settings.deepgramModel,
			resolveDictionaryTermList(settings),
		);
		const dictionaryNotice = describeDictionaryOmission(dictionaryPlan);
		if (dictionaryNotice) {
			// Tell the user which terms will not bias this run instead of
			// implying every configured term was applied.
			new Notice(dictionaryNotice);
		}
		const transcribeOptions = {
			language:
				settings.transcriptionLanguage &&
				settings.transcriptionLanguage !== 'auto'
					? settings.transcriptionLanguage
					: undefined,
			diarize,
			// Gated like diarize above: an engine that returns segment-level
			// timing only never sees a request it would drop, and a stored "on"
			// left from an engine that reads it stops travelling.
			wordTimestamps: effectiveWordTimestamps(
				settings.transcriptionProvider,
				settings.transcriptionWordTimestamps,
			),
			dictionary: dictionaryPlan.applied.length
				? dictionaryPlan.applied
				: undefined,
			// Providers on abortable transports stop the in-flight request
			// the moment the user cancels, not at the next chunk boundary.
			signal: token.signal,
		};

		options.onProgress?.(0, 'Preparing audio...');
		// Reuse the caller's already-read bytes when provided (the dialog reads
		// them to probe the duration), so a manual run never reads the whole
		// file twice.
		const raw =
			options.audioBytes ?? (await this.app.vault.readBinary(file));
		const prepared = await prepareAudio(
			raw,
			file.name,
			audioMimeFromExtension(file.extension),
			audioPrepOptions(
				provider.capabilities,
				provider.requiresNetwork,
				Math.max(1, settings.transcriptionChunkMb) * BYTES_PER_MB,
				transcribeOptions.diarize,
			),
		);
		this.throwIfCancelled(token);

		if (prepared.diarizationSplitWarning) {
			// The recording was too long (or too large) for one request and had
			// to be split. Every engine numbers speakers per request, so labels
			// can differ between parts; tell the user rather than emitting
			// silently inconsistent speaker labels.
			new Notice(
				'Recording was split into parts for this engine; speaker labels may ' +
					'differ between parts. Use Deepgram or split the recording for ' +
					'consistent speakers.',
			);
		}

		const payloads = prepared.payloads;
		const partCount = payloads.length;
		const results: {
			offsetSeconds: number;
			transcript: Transcript;
			usage?: TranscriptionUsage;
		}[] = [];
		const failedParts: { label: string; message: string }[] = [];
		// Billed results of the advanced second pass. Kept apart from the
		// first pass's `results` (which remain the fallback transcript) but
		// summed into the same run cost, since both passes are real - and on
		// a paid API, billed - requests.
		const secondPassResults: typeof results = [];
		// Usage from requests that were billed but whose transcript was
		// discarded (a truncated Gemini part that gets subdivided and
		// retried): kept apart from `results` so it counts toward the cost
		// without being mistaken for a successful part in the failure check.
		const discardedUsage: TranscriptionUsage[] = [];
		// Priced once per run so every per-part update and the final result
		// use the same rate for the same engine and model.
		const pricing = resolveEnginePricing(
			settings.transcriptionProvider,
			selectedEngineModel(settings, settings.transcriptionProvider),
		);
		const runCost = (): TranscribeRunCost => {
			const usage = sumUsage([
				...results.map((entry) => entry.usage),
				...secondPassResults.map((entry) => entry.usage),
				...discardedUsage,
			]);
			return {
				engineId: settings.transcriptionProvider,
				usd: pricing ? costFromUsage(pricing, usage) : null,
				usage,
			};
		};
		// The advanced mode transcribes everything twice, so it splits the
		// chunk progress band between the passes; the normal path keeps the
		// whole band for its single pass. Two-pass needs both the advanced
		// settings master switch and its own toggle (the toggle lives under the
		// master), AND an engine that can carry a bias - a non-biasing engine
		// degrades to one plain pass. Decide it once here, capability-gated, so
		// the progress band is only split when the second pass will actually run
		// (otherwise the band's upper half would stay unfilled).
		const advancedRequested = advancedTwoPassEnabled(settings);
		const advancedUnsupportedReason = advancedRequested
			? advancedBiasUnsupportedReason(
					settings.transcriptionProvider,
					settings.deepgramModel,
				)
			: null;
		const willTwoPass =
			advancedRequested && advancedUnsupportedReason === null;
		const firstPassCeiling = willTwoPass
			? TRANSCRIBE_CHUNK_PROGRESS_CEILING / 2
			: TRANSCRIBE_CHUNK_PROGRESS_CEILING;
		/**
		 * Transcribes every prepared part once with the given options,
		 * reporting progress inside [progressBase, progressBase + span).
		 * Shared by both passes so their behavior (labels, per-part salvage,
		 * billing) cannot diverge.
		 */
		const transcribePass = async (
			passOptions: TranscribeOptions,
			passResults: typeof results,
			passFailed: typeof failedParts,
			progressBase: number,
			progressSpan: number,
			verb: string,
		): Promise<void> => {
			for (let i = 0; i < partCount; i++) {
				this.throwIfCancelled(token);
				const payload = payloads[i];
				if (!payload) {
					continue;
				}
				const partLabel =
					partCount > 1
						? this.describePart(payload, i, partCount)
						: '';
				const partProgress =
					progressBase + (i / partCount) * progressSpan;
				options.onProgress?.(
					partProgress,
					partLabel ? `${verb} ${partLabel}...` : `${verb}...`,
				);
				await this.transcribePart({
					provider,
					prepared: payload,
					providerOptions: passOptions,
					token,
					label: partLabel,
					results: passResults,
					failedParts: passFailed,
					discardedUsage,
					onRetryWait: (waitMs, label) => {
						// A pause is the run still working, and a progress
						// line that stopped moving reads as a hang. It says
						// what is happening and not why: the same pause
						// covers a rate limit and a provider fault, this
						// line cannot tell them apart, and naming one of
						// them told a user waiting out a 502 that they had
						// been sending too many requests. Which refusal it
						// was reaches them in the error the run reports if
						// the attempts run out.
						options.onProgress?.(
							partProgress,
							`Retrying ${label || 'the audio'} in ${String(
								Math.ceil(waitMs / MS_PER_SECOND),
							)}s...`,
						);
					},
				});
				options.onCost?.(runCost());
			}
		};
		await transcribePass(
			transcribeOptions,
			results,
			failedParts,
			0,
			firstPassCeiling,
			'Transcribing',
		);

		// Every part failed: there is no transcript to keep, so surface the
		// first failure (named like the per-part error) rather than writing
		// nothing and reporting a hollow success.
		if (results.length === 0) {
			const first = failedParts[0];
			throw new Error(
				first
					? `${first.message} (while transcribing ${first.label})`
					: 'Transcription produced no output.',
			);
		}

		// Honor a cancel pressed during the final (or only) request: requestUrl
		// cannot abort it, but a cancelled run must not silently write output.
		// Without this, single-request jobs (whole-file Deepgram, a sub-limit
		// Whisper upload, local whisper.cpp) would ignore Cancel and report
		// success, since the per-chunk check only fires before the next chunk.
		this.throwIfCancelled(token);

		const stitched = stitchChunks(results, {
			model: provider.id,
			createdAt: new Date().toISOString(),
			sourcePath: file.path,
		});

		// Advanced two-pass mode: LLM agents mine the first pass's draft for
		// domain context (topic, names, jargon, English acronyms), and the
		// same audio is decoded again with that context as a bias and the
		// language pinned to the first pass's. Strictly best-effort: an
		// engine that cannot bias, a failed agent, a failed second pass, or a
		// suspiciously short result all keep the first pass's transcript, so
		// the mode can never lose a completed (and paid) transcription.
		let working = stitched;
		let missingParts = failedParts;
		if (advancedRequested) {
			if (advancedUnsupportedReason !== null) {
				// Degrade to the normal single pass up front - before any LLM
				// spend - and say so, instead of silently ignoring the toggle.
				new Notice(
					`Advanced two-pass transcription skipped: ${advancedUnsupportedReason}. ` +
						'Keeping the single-pass transcript.',
				);
			} else {
				try {
					options.onProgress?.(
						firstPassCeiling,
						'Analyzing transcript context...',
					);
					// The agents run on the engine the two-pass mode names,
					// which is a choice of its own rather than whatever
					// post-processing points at. This run's Dictionary terms
					// join as bias candidates, vetted against the draft so an
					// off-topic term is not injected. The advanced mode reuses
					// the same terms the single pass biases toward, not a second
					// glossary. A keyword-biased engine (Deepgram) reads only
					// the keyterm list, so the pipeline skips the prompt-sentence
					// agents.
					const llm = this.createLlm(
						settings,
						jobVendorId(settings, 'contextAgents'),
					);
					const context = await generateContext(stitched, llm, {
						language:
							transcribeOptions.language ?? stitched.language,
						glossary: resolveDictionaryTermList(settings),
						buildPromptSentence:
							advancedBiasChannel(
								settings.transcriptionProvider,
							) === 'prompt',
						token,
						settings,
						durationSeconds: stitched.segments.at(-1)?.end ?? null,
						costSink: this.costSink,
					});
					const bias = context
						? planAdvancedBias(
								settings.transcriptionProvider,
								context,
							)
						: {};
					if (!bias.biasPrompt && !bias.keyterms?.length) {
						new Notice(
							'Advanced two-pass transcription found no usable ' +
								'context; keeping the single-pass transcript.',
						);
					} else {
						// Pin the second pass's language to the first pass's:
						// the bias is dense with English tokens, and left to
						// auto-detect it can flip a Russian recording into
						// English - the documented failure mode this guards
						// against.
						const secondPassOptions: TranscribeOptions = {
							...transcribeOptions,
							language:
								transcribeOptions.language ?? stitched.language,
							...bias,
						};
						const secondFailed: typeof failedParts = [];
						await transcribePass(
							secondPassOptions,
							secondPassResults,
							secondFailed,
							firstPassCeiling,
							TRANSCRIBE_CHUNK_PROGRESS_CEILING -
								firstPassCeiling,
							'Second pass: transcribing',
						);
						this.throwIfCancelled(token);
						const secondPass = stitchChunks(secondPassResults, {
							model: provider.id,
							createdAt: new Date().toISOString(),
							sourcePath: file.path,
						});
						if (
							secondFailed.length > 0 ||
							secondPassResults.length === 0
						) {
							new Notice(
								'Advanced second pass failed; keeping the ' +
									'first-pass transcript.',
							);
						} else if (
							!meetsLengthSafeguard(
								plainText(stitched),
								plainText(secondPass),
								settings.advancedSecondPassMinRatio,
							)
						) {
							// The over-correction guard from the paper: a
							// biased decode that lost this much text is
							// discarded in favor of the baseline.
							new Notice(
								'Advanced second pass came back too short; ' +
									'keeping the first-pass transcript.',
							);
						} else {
							working = secondPass;
							// The adopted pass succeeded on every part,
							// including any the first pass lost, so the
							// incomplete-transcription warning follows it.
							missingParts = secondFailed;
						}
					}
				} catch (error) {
					// Cancellation inside context generation surfaces as an
					// ordinary error; map it back to the cancel the user asked
					// for instead of a best-effort fallback.
					this.rethrowIfCancelled(error, token);
					console.warn(
						`${PLUGIN_LOG_PREFIX} Advanced two-pass transcription failed; keeping the single-pass transcript.`,
						error,
					);
					new Notice(
						'Advanced two-pass transcription failed; keeping ' +
							'the single-pass transcript.',
					);
				}
			}
		}

		// Without effective diarization there are no speakers; drop any the
		// provider returned so no output path (note Markdown, sidecar file, or
		// JSON) shows a label the user did not ask for. Doing it once here, on
		// the canonical transcript, keeps every consumer consistent rather than
		// gating each renderer separately.
		const canonical = diarize ? working : stripSpeakers(working);
		// A diarized re-transcription re-applies the names the user assigned
		// earlier (stored in the recording's sidecar) and refreshes the stored
		// roster, so renamed speakers survive a re-run without user action.
		const transcript = diarize
			? await this.applyStoredSpeakerNames(
					options.sidecar ?? null,
					file.path,
					canonical,
					// The run's participant profile travels with the roster into
					// the recording's sidecar, so the rename dialog can suggest
					// this meeting's people without the user re-picking a profile.
					{
						names: resolveRunParticipants(settings),
						profileId: selectedProfileId(settings, 'participants'),
					},
				)
			: canonical;

		const markdownOptions = this.markdownOptions(settings);
		let markdown = formatTranscriptMarkdown(
			transcript,
			markdownOptions,
			this.linkBuilder(file, options.notePathForLinks),
		);

		// Some parts failed but others succeeded: keep the good parts and warn,
		// rather than failing the whole run and discarding a transcript the user
		// already paid for. The gap is flagged with a callout prepended only
		// after post-processing (below), because an LLM cleanup/custom pass
		// replaces the whole body and would otherwise strip the warning.
		let incompleteWarning = '';
		if (missingParts.length > 0) {
			const labels = missingParts.map((part) => part.label).join(', ');
			const verb = missingParts.length > 1 ? 'are' : 'is';
			incompleteWarning =
				`> [!warning] Transcription incomplete: ${labels} could not ` +
				`be transcribed and ${verb} missing below.\n\n`;
			new Notice(
				`Some audio could not be transcribed (${labels}) and is missing ` +
					'from the transcript; saving the parts that succeeded. ' +
					(missingParts[0]?.message ?? ''),
			);
		}

		if (settings.llmPostProcessEnabled) {
			this.throwIfCancelled(token);
			options.onProgress?.(
				TRANSCRIBE_CHUNK_PROGRESS_CEILING,
				'Post-processing with LLM...',
			);
			// Post-processing is best-effort: a failure (bad key, network,
			// timeout) must not discard the completed transcript, so fall back
			// to the raw Markdown and tell the user the cleanup was skipped.
			try {
				markdown = await this.postProcess(
					settings,
					transcript,
					markdown,
					token,
				);
			} catch (error) {
				// The abort of the call in flight arrives as a transport
				// failure, so a Cancel pressed here is not the pass breaking:
				// reporting it as one told the user their own doing had gone
				// wrong and then saved the transcript they had cancelled.
				this.rethrowIfCancelled(error, token);
				console.warn(
					`${PLUGIN_LOG_PREFIX} LLM post-processing failed; keeping the raw transcript.`,
					error,
				);
				new Notice(
					'LLM post-processing failed; saving the raw transcript.',
				);
			}
		}

		// Flag any gap last, so the callout survives an LLM cleanup/custom pass
		// that would otherwise replace the body and drop it.
		markdown = incompleteWarning + markdown;

		options.onProgress?.(1, 'Done');
		return { transcript, markdown, cost: runCost() };
	}

	/**
	 * Applies the speaker names stored in the recording's sidecar to a fresh
	 * diarized transcript and writes the refreshed roster back: labels that
	 * reappeared keep their assigned names, new labels join unnamed, and
	 * labels that vanished keep their stored entries for a future run. When
	 * the label composition changed against the stored roster, the user is
	 * warned - engines number speakers per run, so "Speaker 2" may not be the
	 * same person as last time. A stored name that collides with another
	 * label of this run is dropped (applying it would render two speakers
	 * identically and merge them beyond repair) and the user is told to
	 * re-check the names. The refreshed roster also carries each speaker's
	 * first-turn offsets, which is what lets the rename dialog play a sample of
	 * a speaker instead of asking the user to remember who they were, and the
	 * run's participant names, so the recording carries its own roster.
	 * Best-effort: any sidecar failure leaves the transcript untouched rather
	 * than failing a paid run.
	 * @param path - Vault path of the transcribed recording
	 * @param transcript - Fresh diarized transcript with original labels
	 * @param participants - The run's participant profile, recorded with the
	 *   roster
	 * @returns The transcript with stored names applied (or unchanged)
	 */
	private async applyStoredSpeakerNames(
		sidecar: TranscriptionSidecarAccess | null,
		path: string,
		transcript: Transcript,
		participants: ParticipantUpdate,
	): Promise<Transcript> {
		if (!sidecar || transcript.speakers.length === 0) {
			return transcript;
		}
		try {
			const section = await sidecar.getTranscript(path);
			const runLabels = new Set(transcript.speakers);
			// A null-prototype map keeps hostile engine labels ("toString",
			// "__proto__") plain data keys instead of resolving to inherited
			// Object.prototype members.
			const storedNames = emptyNameMap();
			let droppedCollisions = false;
			for (const entry of section.speakers) {
				if (!entry.name) {
					continue;
				}
				// A stored name equal to a DIFFERENT label of this run would
				// render two speakers identically and merge them in every
				// output - the ambiguity no later rename can undo. Such a
				// name is neither applied nor carried into the refreshed
				// roster.
				if (runLabels.has(entry.name)) {
					droppedCollisions = true;
					continue;
				}
				storedNames[entry.label] = entry.name;
			}
			const renamed = renameSpeakers(transcript, storedNames);
			// Measured on the original-label transcript, so the offsets are
			// keyed by the same labels the roster stores.
			const firstTurns = collectFirstTurns(transcript.segments);
			await sidecar.setSpeakers(
				path,
				transcript.speakers.map((label) => {
					const name = storedNames[label];
					const turn = firstTurns.get(label);
					return {
						label,
						...(name ? { name } : {}),
						...(turn
							? { firstStart: turn.start, firstEnd: turn.end }
							: {}),
					};
				}),
				participants,
			);
			if (droppedCollisions) {
				new Notice(
					"A stored speaker name matched another speaker's label " +
						'in this run and was not applied; check the assigned ' +
						'names.',
				);
			}
			const previousLabels = section.speakers.map((entry) => entry.label);
			if (
				previousLabels.length > 0 &&
				!sameLabelComposition(previousLabels, transcript.speakers)
			) {
				new Notice(
					'Speaker labels changed since the last transcription; ' +
						'check the assigned names.',
				);
			}
			return renamed;
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Failed to apply stored speaker names for ${path}:`,
				error,
			);
			return transcript;
		}
	}

	/**
	 * Transcribes one prepared part, pushing its stitched result or, on failure,
	 * recording the failure so the surrounding parts are still kept. When a
	 * provider truncates the part because its output token budget was exhausted
	 * ({@link TranscriptTruncatedError}), the part is split into smaller pieces
	 * and each is transcribed in turn, recovering a dense stretch that overran
	 * the cap instead of losing it; only when the part is already at the minimum
	 * length (subdivision yields nothing) does it count as a failure. A part with
	 * an empty label is a single indivisible job and fails the whole run as
	 * before.
	 * @param part - The part to transcribe and everything it reports into
	 */
	private async transcribePart(part: PartRun): Promise<void> {
		const { prepared, token, label, results, failedParts, discardedUsage } =
			part;
		this.throwIfCancelled(token);
		// Materialize this payload's bytes only now, so a multi-chunk job never
		// holds more than one chunk's WAV in memory at a time.
		const payload: AudioPayload = {
			data: await prepared.createData(),
			contentType: prepared.contentType,
			filename: prepared.filename,
			offsetSeconds: prepared.offsetSeconds,
		};
		try {
			const chunkResult = await this.transcribeWithRetries(part, payload);
			results.push({
				offsetSeconds: payload.offsetSeconds,
				transcript: buildTranscript(chunkResult.segments, {
					language: chunkResult.language,
				}),
				// Carried per part so the run's cost sums what the provider
				// actually reported billing for, across chunks and retries.
				...(chunkResult.usage ? { usage: chunkResult.usage } : {}),
			});
		} catch (error) {
			// A cancel aborts the whole run; never salvage past it. An abort
			// of the in-flight request surfaces as a transport error, so map
			// it back to the cancellation the user asked for.
			this.rethrowIfCancelled(error, token);
			// The part overran the provider's output token budget. Retrying it as
			// smaller pieces keeps each piece's output under the cap, so a dense
			// stretch is recovered rather than discarded. Each retry is a real
			// (and, on a paid API, billed) request, so the subdivision is logged:
			// the recursion is bounded only by the MIN_SUBDIVIDE_SECONDS floor, so
			// a consistently dense part can fan out into several extra requests.
			if (error instanceof TranscriptTruncatedError) {
				// The truncated request was already billed, so account its
				// reported usage before discarding the transcript and retrying;
				// otherwise the run total omits every truncated ancestor.
				if (error.usage) {
					discardedUsage.push(error.usage);
				}
				const halves = prepared.subdivide?.() ?? [];
				if (halves.length > 0) {
					console.debug(
						`${PLUGIN_LOG_PREFIX} ${label || 'The audio'} overran ` +
							'the output token limit; retrying as ' +
							`${String(halves.length)} smaller pieces.`,
					);
					for (const half of halves) {
						await this.transcribePart({
							...part,
							prepared: half,
							label: this.partTimeLabel(half),
						});
					}
					return;
				}
				// At the minimum subdividable length a further split would cost
				// more requests than it saves, so stop here and let the part be
				// reported (or fail the run, for a single indivisible job).
				console.debug(
					`${PLUGIN_LOG_PREFIX} ${label || 'The audio'} still ` +
						'overran the output token limit at the minimum segment ' +
						'length; reporting it without subdividing further.',
				);
			}
			const detail =
				error instanceof Error ? error.message : String(error);
			// A single indivisible job has nothing to keep, so fail as before. A
			// labelled part (one of several, or a subdivision) records the failure
			// and carries on: discarding a completed - and, on a paid API, already
			// billed - part because another part hit a provider limit would throw
			// away good work.
			if (!label) {
				throw error;
			}
			failedParts.push({ label, message: detail });
		}
	}

	/**
	 * Sends one part, trying again while the refusal is a temporary one.
	 *
	 * The pause is interruptible, because a Cancel pressed while the run is
	 * waiting must end it there rather than after the wait it was already
	 * regretting.
	 * @param part - The part being transcribed
	 * @param payload - Its materialized bytes
	 * @returns What the provider answered
	 */
	private async transcribeWithRetries(
		part: PartRun,
		payload: AudioPayload,
	): Promise<WhisperResult> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await part.provider.transcribe(
					payload,
					part.providerOptions,
				);
			} catch (error) {
				const waitMs = retryWaitMs(error, attempt);
				if (waitMs === null) {
					throw error;
				}
				part.onRetryWait(waitMs, part.label);
				try {
					await delay(waitMs, part.token.signal);
				} catch {
					// The only thing that ends the pause early is the cancel.
					throw new TranscriptionCancelledError();
				}
				this.throwIfCancelled(part.token);
			}
		}
	}

	/**
	 * Labels a subdivided part by its span on the timeline, e.g. "the
	 * 7:30-15:00 segment", so a salvage warning names which stretch is missing
	 * rather than an opaque part number that no longer maps to the split.
	 * @param part - The prepared sub-part
	 * @returns A human label for the part's time range
	 */
	private partTimeLabel(part: PreparedPayload): string {
		const reference = part.endSeconds ?? part.offsetSeconds;
		const start = formatTimecode(part.offsetSeconds, reference);
		if (part.endSeconds === undefined) {
			return `the segment at ${start}`;
		}
		return `the ${start}-${formatTimecode(part.endSeconds, reference)} segment`;
	}

	/**
	 * Labels a top-level part for progress and salvage messages. A part whose
	 * span is known (the decode path stamps {@link PreparedPayload.endSeconds})
	 * is named by its timeline range, matching how a subdivided part is named so
	 * the incomplete-transcription warning never mixes a "part N of M" label with
	 * a timecode span. Only when the span was never measured (no endSeconds) does
	 * it fall back to the ordinal position.
	 * @param part - The prepared top-level part
	 * @param index - Zero-based position of the part
	 * @param count - Total number of top-level parts
	 * @returns A human label for the part
	 */
	private describePart(
		part: PreparedPayload,
		index: number,
		count: number,
	): string {
		if (part.endSeconds !== undefined) {
			return this.partTimeLabel(part);
		}
		return `part ${String(index + 1)} of ${String(count)}`;
	}

	/**
	 * Runs the configured LLM post-processing step and returns the new
	 * Markdown body (cleanup/custom replace the body; summary is prepended).
	 * @param settings - The run's settings
	 * @param transcript - The transcript the pass reads
	 * @param markdown - The rendered body a cleanup or custom pass replaces
	 * @param token - Cancellation for the run, so a Cancel pressed here ends
	 *   the request instead of leaving it to its own timeout and the bill
	 */
	private async postProcess(
		settings: AudioRecorderSettings,
		transcript: Transcript,
		markdown: string,
		token: CancellationToken,
	): Promise<string> {
		const vendorId = jobVendorId(settings, 'postProcess');
		const llm = this.createLlm(settings, vendorId);
		const prompt = buildPostProcessPrompt(
			settings.llmPostProcessTask === 'summary'
				? plainText(transcript)
				: markdown,
			{
				task: settings.llmPostProcessTask,
				language: transcript.language,
				cleanupPrompt: resolveLlmPrompt(settings, 'cleanup'),
				summaryPrompt: resolveLlmPrompt(settings, 'summary'),
				customInstruction: resolveLlmPrompt(settings, 'custom'),
				// The user's Dictionary terms give the cleanup pass the canonical
				// spellings, so even a single-pass run corrects garbled names and
				// acronyms.
				glossary: resolveDictionaryTermList(settings),
			},
		);
		const output = await runLlmStep({
			step: 'postProcess',
			llm,
			prompt,
			maxTokens: vendorMaxTokens(settings, vendorId),
			settings,
			// The transcript is what the pass reads, so its extent sizes the
			// estimate exactly as the pre-run breakdown does.
			durationSeconds: transcript.segments.at(-1)?.end ?? null,
			costSink: this.costSink,
			signal: token.signal,
		});
		if (!output) {
			return markdown;
		}
		if (settings.llmPostProcessTask === 'summary') {
			return `### Summary\n\n${output}\n\n### Transcript\n\n${markdown}`;
		}
		return output;
	}

	/**
	 * Builds the Markdown options from settings.
	 */
	private markdownOptions(
		settings: AudioRecorderSettings,
	): TranscriptMarkdownOptions {
		// Speaker labels are already stripped from the transcript when
		// diarization is not in effect (see run()), so these options can honor
		// the user's settings directly: includeSpeakers/mergeConsecutiveSpeaker
		// simply have nothing to act on when there are no speakers.
		return {
			...DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
			includeTimestamps: settings.transcriptIncludeTimestamps,
			timestampLinks: settings.transcriptTimestampLinks,
			includeSpeakers: settings.transcriptIncludeSpeakers,
			mergeConsecutiveSpeaker: settings.transcriptMergeConsecutiveSpeaker,
			timestampFormat: settings.transcriptTimestampFormat,
			speakerFormat: settings.transcriptSpeakerFormat,
			lineFormat: settings.transcriptLineFormat,
		};
	}

	/**
	 * Builds a timecode link generator that produces vault links with a
	 * `#t=` subpath (handled by the enhanced player), respecting the
	 * vault's link-format preference.
	 */
	private linkBuilder(file: TFile, notePath: string): TimecodeLinkBuilder {
		return (seconds: number, label: string) =>
			this.app.fileManager.generateMarkdownLink(
				file,
				notePath,
				`#t=${String(Math.floor(seconds))}`,
				label,
			);
	}

	/**
	 * Throws if the run was cancelled.
	 */
	private throwIfCancelled(token: CancellationToken): void {
		if (token.isCancelled()) {
			throw new TranscriptionCancelledError();
		}
	}

	/**
	 * Re-raises the run's own cancellation when this failure is it.
	 *
	 * A cancel does not reach a catch in one shape. A step that checked the
	 * token between calls throws {@link TranscriptionCancelledError}; a
	 * request the abort reached first throws the transport's own failure; a
	 * spend refused before it started throws the platform's AbortError. Every
	 * step that has to tell a cancel from a genuine failure needs the same
	 * two questions asked in the same order, and each of them used to ask
	 * them for itself: the one that asked only the first read the user's own
	 * Cancel as a broken post-processing pass, told them the pass had failed,
	 * and saved the transcript they had just cancelled.
	 * @param error - What the step failed with
	 * @param token - Cancellation for the run the step belongs to
	 * @throws TranscriptionCancelledError when this failure is the cancel
	 */
	private rethrowIfCancelled(error: unknown, token: CancellationToken): void {
		if (error instanceof TranscriptionCancelledError) {
			throw error;
		}
		this.throwIfCancelled(token);
	}
}

/** Whether two label lists contain the same labels, order-insensitive. */
function sameLabelComposition(
	previous: readonly string[],
	current: readonly string[],
): boolean {
	if (previous.length !== current.length) {
		return false;
	}
	const set = new Set(previous);
	return current.every((label) => set.has(label));
}
