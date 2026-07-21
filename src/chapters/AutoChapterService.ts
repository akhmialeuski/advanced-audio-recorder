/**
 * Orchestrates auto-chapter generation for one recording: verify a
 * transcript exists (in memory from a just-finished transcription run, or
 * discovered among the recording's existing outputs), ask the configured
 * LLM for chapter boundaries, validate its response, and write the result
 * into the recording's marker sidecar - replacing only previously
 * generated chapters so bookmarks and manual chapters survive a re-run.
 * All outcomes surface as Notices and the entry point never throws, so
 * both the context-menu action and the after-transcription hook can call
 * it fire-and-forget.
 * @module chapters/AutoChapterService
 */

import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import type { AudioRecorderSettings } from '../settings/settingsSchema';
import { createLlmProvider } from '../transcription/factories';
import type { LlmProvider } from '../transcription/llm/LlmProvider';
import type { Transcript } from '../transcription/TranscriptTypes';
import type { MarkerStore } from '../markers/MarkerStore';
import { generateMarkerId } from '../markers/markerFactory';
import {
	applyGeneratedChapters,
	buildChapterPrompt,
	parseChapterResponse,
	type TimedLine,
} from './chapterGeneration';
import {
	loadTranscriptLines,
	timedLinesFromTranscript,
} from './transcriptSources';

/** Dependencies injectable for tests; defaults build the real LLM provider. */
export interface AutoChapterServiceDeps {
	/** Builds the LLM provider from settings. */
	createLlm?: (settings: AudioRecorderSettings) => LlmProvider;
}

/**
 * Generates and stores LLM-derived chapters for recordings.
 */
export class AutoChapterService {
	private readonly createLlm: (
		settings: AudioRecorderSettings,
	) => LlmProvider;

	/**
	 * @param app - Obsidian App
	 * @param getSettings - Returns current plugin settings
	 * @param markerStore - Marker sidecar store shared with the player
	 * @param onChaptersWritten - Called with the recording path after a
	 *   successful write, so open players can re-read their markers
	 * @param deps - Optional provider factory (injected in tests)
	 */
	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly markerStore: MarkerStore,
		private readonly onChaptersWritten?: (path: string) => void,
		deps: AutoChapterServiceDeps = {},
	) {
		this.createLlm = deps.createLlm ?? createLlmProvider;
	}

	/**
	 * Generates chapters for a recording and writes them to its marker
	 * sidecar. Every outcome (no transcript, unusable LLM output, provider
	 * error, success) is reported with a Notice; the method never throws.
	 * @param file - The audio file to chapter
	 * @param transcript - In-memory transcript from a just-finished run;
	 *   omitted, the recording's existing outputs are searched
	 * @returns True when chapters were written
	 */
	async generate(file: TFile, transcript?: Transcript): Promise<boolean> {
		try {
			// The transcription check: without a transcript (given or found)
			// there is nothing to derive chapters from, so stop with guidance
			// instead of sending an empty prompt to a paid API.
			const lines = await this.resolveLines(file, transcript);
			if (!lines || lines.length === 0) {
				new Notice(
					`No transcript found for ${file.name}. Transcribe the ` +
						'audio first, then generate chapters.',
				);
				return false;
			}
			new Notice(`Generating chapters for ${file.name}...`);
			const settings = this.getSettings();
			const llm = this.createLlm(settings);
			const lastSegment = transcript?.segments.at(-1);
			// Bound the model's proposals by the transcript's known extent:
			// the last segment's end when the transcript is in memory, else
			// the last timed line.
			const maxTime =
				lastSegment?.end ?? lines[lines.length - 1]?.time ?? null;
			const prompt = buildChapterPrompt(lines, {
				...(transcript?.language
					? { language: transcript.language }
					: {}),
			});
			const output = await llm.complete(prompt, settings.llmMaxTokens);
			const chapters = parseChapterResponse(output, maxTime);
			if (chapters.length === 0) {
				new Notice(
					'The LLM returned no usable chapters; markers were not changed.',
				);
				return false;
			}
			const existing = await this.markerStore.get(file.path);
			const merged = applyGeneratedChapters(
				existing,
				chapters,
				generateMarkerId,
			);
			await this.markerStore.set(file.path, merged);
			this.onChaptersWritten?.(file.path);
			new Notice(
				`Added ${String(chapters.length)} chapter` +
					`${chapters.length > 1 ? 's' : ''} to ${file.name}. ` +
					'They appear in the enhanced player.',
			);
			return true;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.warn(
				`${PLUGIN_LOG_PREFIX} Chapter generation failed for ${file.path}:`,
				error,
			);
			new Notice(`Chapter generation failed: ${message}`);
			return false;
		}
	}

	/**
	 * Resolves the timed transcript lines: from the in-memory transcript
	 * when one was handed over, otherwise from the recording's existing
	 * transcript outputs.
	 */
	private async resolveLines(
		file: TFile,
		transcript?: Transcript,
	): Promise<TimedLine[] | null> {
		if (transcript) {
			return timedLinesFromTranscript(transcript);
		}
		const found = await loadTranscriptLines(this.app, file);
		return found?.lines ?? null;
	}
}
