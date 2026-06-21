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
	PLUGIN_LOG_PREFIX,
	TRANSCRIBE_CHUNK_PROGRESS_CEILING,
} from '../constants';
import type { AudioRecorderSettings } from '../settings/Settings';
import {
	audioMimeFromExtension,
	audioPrepOptions,
	prepareAudio,
} from './audioPrep';
import type {
	AudioPayload,
	TranscriptionProvider,
} from './providers/TranscriptionProvider';
import { buildTranscript, plainText, stitchChunks } from './transcriptModel';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	type TimecodeLinkBuilder,
	type TranscriptMarkdownOptions,
} from './transcriptFormat';
import { buildPostProcessPrompt } from './llmPostProcess';
import { createLlmProvider, createTranscriptionProvider } from './factories';
import type { LlmProvider } from './llm/LlmProvider';
import type { Transcript } from './TranscriptTypes';

/** Cooperative cancellation signal checked between chunks. */
export interface CancellationToken {
	isCancelled(): boolean;
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
		const transcribeOptions = {
			language:
				settings.transcriptionLanguage &&
				settings.transcriptionLanguage !== 'auto'
					? settings.transcriptionLanguage
					: undefined,
			diarize: settings.transcriptionDiarize,
			wordTimestamps: settings.transcriptionWordTimestamps,
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
				Math.max(1, settings.transcriptionChunkMb) * 1024 * 1024,
				transcribeOptions.diarize,
			),
		);
		this.throwIfCancelled(token);

		if (prepared.diarizationSplitWarning) {
			// The recording was too large to send whole and this engine numbers
			// speakers per request, so labels can differ between parts. Tell the
			// user rather than emitting silently inconsistent speaker labels.
			new Notice(
				'Recording was split into parts for this engine; speaker labels may ' +
					'differ between parts. Use Deepgram or split the recording for ' +
					'consistent speakers.',
			);
		}

		const payloads = prepared.payloads;
		const partCount = payloads.length;
		const results: { offsetSeconds: number; transcript: Transcript }[] = [];
		for (let i = 0; i < partCount; i++) {
			this.throwIfCancelled(token);
			const prepPayload = payloads[i];
			const partLabel =
				partCount > 1
					? `part ${String(i + 1)} of ${String(partCount)}`
					: '';
			options.onProgress?.(
				(i / partCount) * TRANSCRIBE_CHUNK_PROGRESS_CEILING,
				partLabel ? `Transcribing ${partLabel}...` : 'Transcribing...',
			);
			// Materialize this payload's bytes only now, so a multi-chunk job
			// never holds more than one chunk's WAV in memory at a time.
			const payload: AudioPayload = {
				data: prepPayload.createData(),
				contentType: prepPayload.contentType,
				filename: prepPayload.filename,
				offsetSeconds: prepPayload.offsetSeconds,
			};
			let chunkResult;
			try {
				chunkResult = await provider.transcribe(
					payload,
					transcribeOptions,
				);
			} catch (error) {
				// Single-part jobs need no extra context; for multi-part,
				// name which part failed so the error is actionable.
				if (!partLabel) {
					throw error;
				}
				const detail =
					error instanceof Error ? error.message : String(error);
				throw new Error(`${detail} (while transcribing ${partLabel})`);
			}
			results.push({
				offsetSeconds: payload.offsetSeconds,
				transcript: buildTranscript(chunkResult.segments, {
					language: chunkResult.language,
				}),
			});
		}

		// Honor a cancel pressed during the final (or only) request: requestUrl
		// cannot abort it, but a cancelled run must not silently write output.
		// Without this, single-request jobs (whole-file Deepgram, a sub-limit
		// Whisper upload, local whisper.cpp) would ignore Cancel and report
		// success, since the per-chunk check only fires before the next chunk.
		this.throwIfCancelled(token);

		const transcript = stitchChunks(results, {
			model: provider.id,
			createdAt: new Date().toISOString(),
			sourcePath: file.path,
		});

		const markdownOptions = this.markdownOptions(settings);
		let markdown = formatTranscriptMarkdown(
			transcript,
			markdownOptions,
			this.linkBuilder(file, options.notePathForLinks),
		);

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

		options.onProgress?.(1, 'Done');
		return { transcript, markdown };
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
