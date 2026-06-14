/**
 * Orchestrates transcription: read the audio, decode/resample to 16 kHz
 * mono, split into upload-sized chunks, transcribe each chunk through the
 * configured provider, stitch the results back onto the original
 * timeline, render Markdown (with clickable timecode links), and
 * optionally post-process with an LLM.
 * @module transcription/TranscriptionService
 */

import type { App, TFile } from 'obsidian';
import { TRANSCRIBE_SAMPLE_RATE } from '../constants';
import type { AudioRecorderSettings } from '../settings/Settings';
import { decodeToMono16k, extractChunkWav, planChunks } from './audioChunks';
import { buildTranscript, plainText, stitchChunks } from './transcriptModel';
import {
	DEFAULT_TRANSCRIPT_MARKDOWN_OPTIONS,
	formatTranscriptMarkdown,
	type TimecodeLinkBuilder,
	type TranscriptMarkdownOptions,
} from './transcriptFormat';
import { buildPostProcessPrompt } from './llmPostProcess';
import { createLlmProvider, createTranscriptionProvider } from './factories';
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
 * Runs the full transcription pipeline for an audio file.
 */
export class TranscriptionService {
	constructor(
		private readonly app: App,
		private getSettings: () => AudioRecorderSettings,
	) {}

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
		const provider = createTranscriptionProvider(settings);
		const transcribeOptions = {
			language:
				settings.transcriptionLanguage &&
				settings.transcriptionLanguage !== 'auto'
					? settings.transcriptionLanguage
					: undefined,
			diarize: settings.transcriptionDiarize,
			wordTimestamps: settings.transcriptionWordTimestamps,
		};

		options.onProgress?.(0, 'Decoding audio...');
		const raw = await this.app.vault.readBinary(file);
		const samples = await decodeToMono16k(raw);
		const totalSeconds = samples.length / TRANSCRIBE_SAMPLE_RATE;
		const maxBytes =
			Math.max(1, settings.transcriptionChunkMb) * 1024 * 1024;
		const chunks = planChunks(totalSeconds, maxBytes);
		this.throwIfCancelled(token);

		const results: { offsetSeconds: number; transcript: Transcript }[] = [];
		for (const chunk of chunks) {
			this.throwIfCancelled(token);
			options.onProgress?.(
				chunk.index / Math.max(1, chunks.length),
				`Transcribing part ${String(chunk.index + 1)} of ${String(chunks.length)}...`,
			);
			const wav = extractChunkWav(samples, chunk);
			const chunkResult = await provider.transcribe(
				wav,
				transcribeOptions,
			);
			results.push({
				offsetSeconds: chunk.startSeconds,
				transcript: buildTranscript(chunkResult.segments, {
					language: chunkResult.language,
				}),
			});
		}

		let transcript = stitchChunks(results, {
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
			options.onProgress?.(0.95, 'Post-processing with LLM...');
			markdown = await this.postProcess(settings, transcript, markdown);
		}

		// Reflect the LLM language passthrough into the transcript metadata
		transcript = { ...transcript };
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
		const llm = createLlmProvider(settings);
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
