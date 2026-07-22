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
import { resolveChapterGuidance } from '../settings/chapterPromptProfiles';
import { createLlmProvider } from '../transcription/factories';
import type { LlmProvider } from '../transcription/llm/LlmProvider';
import type { Transcript } from '../transcription/TranscriptTypes';
import type { MarkerStore } from '../markers/MarkerStore';
import { generateMarkerId } from '../markers/markerFactory';
import {
	applyGeneratedChapters,
	buildChapterPrompt,
	isAutoChapterId,
	minChapterSecondsFor,
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
	/** Probes a recording's real duration in seconds (null when unknown). */
	probeDuration?: (file: TFile) => Promise<number | null>;
}

/**
 * Reads a recording's duration from its media metadata without decoding the
 * whole file, by loading only metadata into an audio element. Resolves null
 * on error or timeout so the caller falls back to the transcript extent.
 * @param app - Obsidian App
 * @param file - Recording to measure
 */
function probeAudioDurationSeconds(
	app: App,
	file: TFile,
): Promise<number | null> {
	return new Promise((resolve) => {
		const audio = new Audio();
		audio.preload = 'metadata';
		const finish = (value: number | null): void => {
			window.clearTimeout(timer);
			audio.removeAttribute('src');
			audio.load();
			resolve(value);
		};
		const timer = window.setTimeout(() => finish(null), 15000);
		audio.addEventListener('loadedmetadata', () => {
			finish(
				Number.isFinite(audio.duration) && audio.duration > 0
					? audio.duration
					: null,
			);
		});
		audio.addEventListener('error', () => finish(null));
		audio.src = app.vault.getResourcePath(file);
	});
}

/** Timed lines plus the transcript language, when a source carried one. */
interface ResolvedLines {
	lines: TimedLine[];
	language?: string;
}

/**
 * The configured transcription language as an explicit prompt hint, or
 * undefined when set to auto-detect. Used as a last resort so on-demand
 * chapter generation still names the language for the model when neither the
 * transcript object nor the sidecar carried a detected one.
 * @param settings - Current plugin settings
 */
function languageHintFromSettings(
	settings: AudioRecorderSettings,
): string | undefined {
	const hint = settings.transcriptionLanguage.trim();
	return hint && hint.toLowerCase() !== 'auto' ? hint : undefined;
}

/**
 * Generates and stores LLM-derived chapters for recordings.
 */
export class AutoChapterService {
	private readonly createLlm: (
		settings: AudioRecorderSettings,
	) => LlmProvider;
	private readonly probeDuration: (file: TFile) => Promise<number | null>;

	/**
	 * @param app - Obsidian App
	 * @param getSettings - Returns current plugin settings
	 * @param markerStore - Marker sidecar store shared with the player
	 * @param onChaptersWritten - Called with the recording path after a
	 *   successful write, so open players can re-read their markers
	 * @param deps - Optional provider factory and duration probe (for tests)
	 */
	constructor(
		private readonly app: App,
		private readonly getSettings: () => AudioRecorderSettings,
		private readonly markerStore: MarkerStore,
		private readonly onChaptersWritten?: (path: string) => void,
		deps: AutoChapterServiceDeps = {},
	) {
		this.createLlm = deps.createLlm ?? createLlmProvider;
		this.probeDuration =
			deps.probeDuration ??
			((file) => probeAudioDurationSeconds(this.app, file));
	}

	/**
	 * Whether the recording already has generated (auto) chapters, so a
	 * caller can warn that regenerating will replace them. Returns false on a
	 * read error rather than blocking the flow.
	 * @param file - The recording to check
	 */
	async hasExistingChapters(file: TFile): Promise<boolean> {
		try {
			const existing = await this.markerStore.get(file.path);
			return existing.some((marker) => isAutoChapterId(marker.id));
		} catch {
			return false;
		}
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
			const resolved = await this.resolveLines(file, transcript);
			if (!resolved || resolved.lines.length === 0) {
				new Notice(
					`No transcript found for ${file.name}. Transcribe the ` +
						'audio first, then generate chapters.',
				);
				return false;
			}
			const { lines } = resolved;
			new Notice(`Generating chapters for ${file.name}...`);
			const settings = this.getSettings();
			const llm = this.createLlm(settings);
			const lastSegment = transcript?.segments.at(-1);
			// Bound everything by the recording's REAL length. Prefer the
			// in-memory transcript's own end; otherwise probe the audio's
			// duration; only as a last resort use the last transcript line,
			// which can run past a trimmed recording and place a chapter
			// beyond its end (the "last chapter shows 0:00" symptom).
			const durationSeconds =
				lastSegment?.end ??
				(await this.probeDuration(file)) ??
				lines[lines.length - 1]?.time ??
				null;
			// Keep chapters spread out and long enough: the prompt states this
			// minimum and parseChapterResponse drops anything bunched closer.
			const minGap = minChapterSecondsFor(durationSeconds);
			// Snap starts onto real transcript lines that fall inside the
			// recording, so a boundary lands on a spoken line and never past
			// the audio's end.
			const snapTimes =
				durationSeconds === null
					? lines.map((line) => line.time)
					: lines
							.map((line) => line.time)
							.filter((time) => time <= durationSeconds);
			// The prompt's language is the transcript's own when known (the
			// in-memory run's detected language, else the JSON sidecar's).
			// When neither carries one (note-derived lines, or a subtitle/text
			// sidecar), fall back to the configured transcription language so
			// generation still names the language instead of letting the model
			// guess it, which otherwise produced wrong-language titles.
			const language =
				resolved.language ?? languageHintFromSettings(settings);
			// The selected chapter profile steers how the recording is split;
			// an empty selection appends no guidance and keeps the base prompt.
			const guidance = resolveChapterGuidance(settings);
			const prompt = buildChapterPrompt(lines, {
				...(language ? { language } : {}),
				...(guidance ? { guidance } : {}),
				...(durationSeconds !== null ? { durationSeconds } : {}),
			});
			const output = await llm.complete(prompt, settings.llmMaxTokens);
			const chapters = parseChapterResponse(
				output,
				durationSeconds,
				minGap,
				snapTimes,
			);
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
	 * Resolves the timed transcript lines and their language: from the
	 * in-memory transcript when one was handed over, otherwise from the
	 * recording's existing transcript outputs. The language rides along so
	 * the prompt can request titles in the transcript's language even on the
	 * on-demand path, where only the JSON sidecar carries one.
	 */
	private async resolveLines(
		file: TFile,
		transcript?: Transcript,
	): Promise<ResolvedLines | null> {
		if (transcript) {
			return {
				lines: timedLinesFromTranscript(transcript),
				...(transcript.language
					? { language: transcript.language }
					: {}),
			};
		}
		const found = await loadTranscriptLines(this.app, file);
		if (!found) {
			return null;
		}
		return {
			lines: found.lines,
			...(found.language ? { language: found.language } : {}),
		};
	}
}
