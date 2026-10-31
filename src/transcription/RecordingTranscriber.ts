/**
 * One recording's transcription run, whichever surface started it: the
 * dialog, the queue or the command line. The pipeline in runTranscription
 * turns audio into written transcripts; this is the policy around it that
 * every surface owes the user alike. An engine this device cannot run is
 * refused before anything is read, what the engine billed reaches the session
 * total even when the run fails after it, the chapters the settings ask for
 * follow a finished run, and the run ends in one typed outcome instead of an
 * exception each surface has to interpret on its own.
 * @module transcription/RecordingTranscriber
 */

import type { App, TFile } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../constants';
import { errorMessage } from '../errors';
import {
	autoChaptersAfterTranscribe,
	type AudioRecorderSettings,
} from '../settings/settingsSchema';
import type { LlmCostSink } from './llm/llmStep';
import { unavailableEngineRefusal } from './providers/capabilities';
import {
	transcribeFile,
	type TranscriptOutputSidecar,
} from './runTranscription';
import { formatUsd } from './costs';
import type { RunCostSink, SessionCostTracker } from './SessionCostTracker';
import {
	TranscriptionCancelledError,
	type CancellationToken,
	type TranscribeRunCost,
	type TranscribeRunResult,
} from './TranscriptionService';
import type { Transcript, TranscriptDestination } from './TranscriptTypes';

/**
 * The plugin's services a run writes into. Assembled once, so no surface can
 * start a run that forgets one of them: a run without the sidecar store
 * leaves outputs that survive no rename and parts that are never offered
 * again, and a run without the cost sink spends money the session total
 * never shows.
 */
export interface RecordingTranscriberServices {
	readonly app: App;
	/** Re-applies stored speaker names and registers what a run wrote. */
	readonly sidecar: TranscriptOutputSidecar;
	/**
	 * The session total: the engine's run and the run's LLM steps alike are
	 * recorded into it, and a finished run reports what it has come to.
	 */
	readonly costs: RunCostSink &
		LlmCostSink &
		Pick<SessionCostTracker, 'totalUsd'>;
	/** Generates chapters from a finished run's transcript. */
	readonly generateChapters: (
		file: TFile,
		transcript: Transcript,
	) => Promise<void>;
}

/** One run, as the surface that starts it describes it. */
export interface RecordingTranscriptionRequest {
	readonly file: TFile;
	/**
	 * The run's settings, taken once by the caller, so a control changed while
	 * the run is in flight cannot change it.
	 */
	readonly settings: AudioRecorderSettings;
	/** The note the transcript goes into and its links resolve in, '' for none. */
	readonly notePath: string;
	/**
	 * How long the recording is, for the estimate a run falls back to when the
	 * engine reported no usage to price. Read when the run is recorded rather
	 * than when it starts, because the dialog may still be measuring the
	 * recording when the run begins.
	 */
	readonly durationSeconds: () => number | null;
	/** Whether the chapters the settings ask for after a run are generated. */
	readonly chapters: boolean;
	/** The recording's bytes, when the caller has already read them. */
	readonly audioBytes?: ArrayBuffer | undefined;
	readonly token?: CancellationToken | undefined;
	readonly onProgress?:
		((fraction: number, label: string) => void) | undefined;
	/** The run's cost so far, after each part the engine finished. */
	readonly onCost?: ((cost: TranscribeRunCost) => void) | undefined;
}

/** How one run ended. */
export type TranscriptionRunOutcome =
	| {
			/** The transcript was written. */
			readonly status: 'done';
			/**
			 * The destination the run was given. With no note to write into,
			 * a run writes every destination as a file beside the recording.
			 */
			readonly destination: TranscriptDestination;
			/** The note it went into or links resolve in, '' for none. */
			readonly notePath: string;
			/** How many parts the engine failed on and left out. */
			readonly missingParts: number;
			/** What the session total recorded for the run, null for nothing. */
			readonly usd: number | null;
			/** What the session has spent, this run included. */
			readonly sessionTotalUsd: number;
	  }
	| {
			/** The run was cancelled. */
			readonly status: 'cancelled';
	  }
	| {
			/** The run could not start or failed. */
			readonly status: 'failed';
			/** What went wrong, in a sentence for the user. */
			readonly message: string;
	  };

/**
 * Runs a recording's transcription with the plugin's services.
 */
export class RecordingTranscriber {
	/**
	 * @param services - What every run writes into
	 */
	constructor(private readonly services: RecordingTranscriberServices) {}

	/**
	 * Transcribes one recording and writes what the settings ask for. Never
	 * throws: every way a run can end is an outcome.
	 * @param request - The run
	 * @returns How it ended
	 */
	async transcribe(
		request: RecordingTranscriptionRequest,
	): Promise<TranscriptionRunOutcome> {
		const { file, settings } = request;
		const refusal = unavailableEngineRefusal(
			settings.transcriptionProvider,
		);
		if (refusal) {
			return { status: 'failed', message: refusal };
		}
		// The last cumulative cost the run reported, kept so a run the engine
		// already billed is still counted when it fails afterwards: a
		// transcript write refused by a read-only vault, or a cancel after
		// some parts had come back.
		let lastCost: TranscribeRunCost | null = null;
		let result: TranscribeRunResult;
		try {
			result = await transcribeFile(
				this.services.app,
				() => settings,
				file,
				{
					notePathForLinks: request.notePath,
					token: request.token,
					sidecar: this.services.sidecar,
					audioBytes: request.audioBytes,
					onProgress: request.onProgress,
					onCost: (cost) => {
						lastCost = cost;
						request.onCost?.(cost);
					},
				},
				// The run's LLM steps (context agents, post-processing) bill the
				// LLM provider, which reports no usage, so they report their
				// estimated cost to the same session total as they happen.
				{ costSink: this.services.costs },
			);
		} catch (error) {
			if (lastCost) {
				this.record(lastCost, request);
			}
			if (error instanceof TranscriptionCancelledError) {
				return { status: 'cancelled' };
			}
			console.warn(
				`${PLUGIN_LOG_PREFIX} Transcription of ${file.path} failed:`,
				error,
			);
			return { status: 'failed', message: errorMessage(error) };
		}
		const usd = this.record(result.cost, request);
		if (request.chapters && autoChaptersAfterTranscribe(settings)) {
			// Fire-and-forget on the fresh in-memory transcript: the chapters
			// report their own progress and errors through notices, and the
			// surface that started the run is done with it.
			void this.services.generateChapters(file, result.transcript);
		}
		return {
			status: 'done',
			destination: settings.transcriptDestination,
			notePath: request.notePath,
			missingParts: result.missingParts.length,
			usd,
			sessionTotalUsd: this.services.costs.totalUsd(),
		};
	}

	/**
	 * Adds what the engine reported to the session total. The run's LLM steps
	 * have reported themselves already, so adding them here would count them
	 * twice. Which runs are counted and at what figure is the cost sink's
	 * rule, the same one the top-up of failed parts follows.
	 * @param cost - What the engine reported
	 * @param request - The run, for its settings and length
	 * @returns The USD recorded, or null when the run is not counted
	 */
	private record(
		cost: TranscribeRunCost,
		request: RecordingTranscriptionRequest,
	): number | null {
		return this.services.costs.recordRun(
			cost,
			request.settings,
			request.durationSeconds(),
		);
	}
}

/**
 * What the user is told in the app about how a run ended, the same from every
 * surface that runs one where the user waits on it: what a finished run cost,
 * or that it was cancelled or failed. A finished run the session total did not
 * count says nothing here, because the transcript notice already said where it
 * went.
 * @param outcome - How the run ended
 * @returns The notice, or null for none
 */
export function runOutcomeNotice(
	outcome: TranscriptionRunOutcome,
): string | null {
	switch (outcome.status) {
		case 'done':
			return outcome.usd === null
				? null
				: `Transcription cost ~${formatUsd(outcome.usd)} (session total ~${formatUsd(outcome.sessionTotalUsd)}).`;
		case 'cancelled':
			return 'Transcription cancelled.';
		default:
			return `Transcription failed: ${outcome.message}`;
	}
}
