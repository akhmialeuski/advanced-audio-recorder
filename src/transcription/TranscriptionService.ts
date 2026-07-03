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
import {
	BYTES_PER_MB,
	PLUGIN_LOG_PREFIX,
	TRANSCRIBE_CHUNK_PROGRESS_CEILING,
} from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
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
	plainText,
	stitchChunks,
	stripSpeakers,
} from './transcriptModel';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	type TimecodeLinkBuilder,
	type TranscriptMarkdownOptions,
} from './transcriptFormat';
import { buildPostProcessPrompt } from './llmPostProcess';
import { createLlmProvider, createTranscriptionProvider } from './factories';
import { effectiveDiarize } from './providers/capabilities';
import type { LlmProvider } from './llm/LlmProvider';
import type { Transcript } from './TranscriptTypes';

/** Cooperative cancellation signal checked between chunks. */
export interface CancellationToken {
	isCancelled(): boolean;
	/**
	 * Optional abort signal that fires when the run is cancelled, so
	 * in-flight HTTP requests can be aborted immediately instead of only
	 * being checked between chunks.
	 */
	signal?: AbortSignal;
}

/** A token that is never cancelled. */
export const NEVER_CANCELLED: CancellationToken = {
	isCancelled: () => false,
};

/** Options for a transcription run. */
export interface TranscribeRunOptions {
	/** Source note path used to generate relative timecode links. */
	notePathForLinks: string;
	/** Progress callback: fraction 0..1 and a short stage label. */
	onProgress?: (fraction: number, label: string) => void;
	/** Cancellation token. */
	token?: CancellationToken;
}

/** Result of a transcription run. */
export interface TranscribeRunResult {
	transcript: Transcript;
	/** Rendered Markdown for insertion into a note. */
	markdown: string;
}

/** Raised when a run is cancelled. */
export class TranscriptionCancelledError extends Error {
	constructor() {
		super('Transcription cancelled');
		this.name = 'TranscriptionCancelledError';
	}
}

/**
 * Provider factories the service depends on. Injectable so tests can supply
 * deterministic providers; defaults build the real providers from settings.
 */
export interface TranscriptionServiceDeps {
	/** Builds the transcription provider from settings. */
	createProvider?: (settings: AudioRecorderSettings) => TranscriptionProvider;
	/** Builds the LLM post-processing provider from settings. */
	createLlm?: (settings: AudioRecorderSettings) => LlmProvider;
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
	) => LlmProvider;

	constructor(
		private readonly app: App,
		private getSettings: () => AudioRecorderSettings,
		deps: TranscriptionServiceDeps = {},
	) {
		this.createProvider =
			deps.createProvider ?? createTranscriptionProvider;
		this.createLlm = deps.createLlm ?? createLlmProvider;
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
		const transcribeOptions = {
			language:
				settings.transcriptionLanguage &&
				settings.transcriptionLanguage !== 'auto'
					? settings.transcriptionLanguage
					: undefined,
			diarize,
			wordTimestamps: settings.transcriptionWordTimestamps,
			// Providers on abortable transports stop the in-flight request
			// the moment the user cancels, not at the next chunk boundary.
			signal: token.signal,
		};

		options.onProgress?.(0, 'Preparing audio...');
		const raw = await this.app.vault.readBinary(file);
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
		const results: { offsetSeconds: number; transcript: Transcript }[] = [];
		const failedParts: { label: string; message: string }[] = [];
		for (let i = 0; i < partCount; i++) {
			this.throwIfCancelled(token);
			const partLabel =
				partCount > 1
					? this.describePart(payloads[i], i, partCount)
					: '';
			options.onProgress?.(
				(i / partCount) * TRANSCRIBE_CHUNK_PROGRESS_CEILING,
				partLabel ? `Transcribing ${partLabel}...` : 'Transcribing...',
			);
			await this.transcribePart(
				provider,
				payloads[i],
				transcribeOptions,
				token,
				partLabel,
				results,
				failedParts,
			);
		}

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
		// Without effective diarization there are no speakers; drop any the
		// provider returned so no output path (note Markdown, sidecar file, or
		// JSON) shows a label the user did not ask for. Doing it once here, on
		// the canonical transcript, keeps every consumer consistent rather than
		// gating each renderer separately.
		const transcript = diarize ? stitched : stripSpeakers(stitched);

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
		if (failedParts.length > 0) {
			const labels = failedParts.map((part) => part.label).join(', ');
			const verb = failedParts.length > 1 ? 'are' : 'is';
			incompleteWarning =
				`> [!warning] Transcription incomplete: ${labels} could not ` +
				`be transcribed and ${verb} missing below.\n\n`;
			new Notice(
				`Some audio could not be transcribed (${labels}) and is missing ` +
					'from the transcript; saving the parts that succeeded. ' +
					failedParts[0].message,
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
				);
			} catch (error) {
				if (error instanceof TranscriptionCancelledError) {
					throw error;
				}
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
		return { transcript, markdown };
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
	 * @param provider - The active transcription provider
	 * @param prepared - The prepared part to transcribe
	 * @param providerOptions - Per-request provider options (language, diarize)
	 * @param token - Cancellation token
	 * @param label - Human label for the part ('' for a single indivisible job)
	 * @param results - Accumulates successful per-part transcripts (mutated)
	 * @param failedParts - Accumulates recoverable per-part failures (mutated)
	 */
	private async transcribePart(
		provider: TranscriptionProvider,
		prepared: PreparedPayload,
		providerOptions: TranscribeOptions,
		token: CancellationToken,
		label: string,
		results: { offsetSeconds: number; transcript: Transcript }[],
		failedParts: { label: string; message: string }[],
	): Promise<void> {
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
			const chunkResult = await provider.transcribe(
				payload,
				providerOptions,
			);
			results.push({
				offsetSeconds: payload.offsetSeconds,
				transcript: buildTranscript(chunkResult.segments, {
					language: chunkResult.language,
				}),
			});
		} catch (error) {
			// A cancel aborts the whole run; never salvage past it. An abort
			// of the in-flight request surfaces as a transport error, so map
			// it back to the cancellation the user asked for.
			if (error instanceof TranscriptionCancelledError) {
				throw error;
			}
			if (token.isCancelled()) {
				throw new TranscriptionCancelledError();
			}
			// The part overran the provider's output token budget. Retrying it as
			// smaller pieces keeps each piece's output under the cap, so a dense
			// stretch is recovered rather than discarded. Each retry is a real
			// (and, on a paid API, billed) request, so the subdivision is logged:
			// the recursion is bounded only by the MIN_SUBDIVIDE_SECONDS floor, so
			// a consistently dense part can fan out into several extra requests.
			if (error instanceof TranscriptTruncatedError) {
				const halves = prepared.subdivide?.() ?? [];
				if (halves.length > 0) {
					console.debug(
						`${PLUGIN_LOG_PREFIX} ${label || 'The audio'} overran ` +
							'the output token limit; retrying as ' +
							`${String(halves.length)} smaller pieces.`,
					);
					for (const half of halves) {
						await this.transcribePart(
							provider,
							half,
							providerOptions,
							token,
							this.partTimeLabel(half),
							results,
							failedParts,
						);
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
	 */
	private async postProcess(
		settings: AudioRecorderSettings,
		transcript: Transcript,
		markdown: string,
	): Promise<string> {
		const llm = this.createLlm(settings);
		const prompt = buildPostProcessPrompt(
			settings.llmPostProcessTask === 'summary'
				? plainText(transcript)
				: markdown,
			{
				task: settings.llmPostProcessTask,
				language: transcript.language,
				cleanupPrompt: settings.llmCleanupPrompt,
				summaryPrompt: settings.llmSummaryPrompt,
				customInstruction: settings.llmCustomInstruction,
			},
		);
		const output = await llm.complete(prompt, settings.llmMaxTokens);
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
}
