/**
 * The advanced two-pass run, as a scenario with an explicit answer.
 *
 * The mode is a sequence of its own: mine the first pass's draft for domain
 * context, turn that context into a bias the engine can carry, decode the same
 * audio again with the bias applied and the language pinned, then decide
 * whether the result is good enough to adopt. Every step can decline, and each
 * declining for its own reason.
 *
 * Those reasons used to be nested conditions inside a four-hundred-line method,
 * which made them impossible to check one at a time and made the safety rule -
 * a completed and paid first pass is never lost - something a reader had to
 * reconstruct. Here the rule is structural: this class returns a value, and the
 * caller is the only thing that can replace its transcript.
 * @module transcription/advanced/AdvancedTwoPassRunner
 */

import { Notice } from 'obsidian';
import { PLUGIN_LOG_PREFIX } from '../../constants';
import { resolveDictionaryTermList } from '../../settings/profileResolution';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from '../../settings/settingsSchema';
import type { LlmProvider } from '../llm/LlmProvider';
import type { LlmCostSink } from '../llm/llmStep';
import { jobVendorId } from '../llm/vendors';
import type { TranscribeOptions } from '../providers/TranscriptionProvider';
import { plainText, stitchChunks } from '../transcriptModel';
import type { Transcript, TranscriptionUsage } from '../TranscriptTypes';
import type { CancellationToken } from '../../utils/cancellation';
import type { PartFailure } from '../partFailure';
import {
	advancedBiasChannel,
	meetsLengthSafeguard,
	planAdvancedBias,
} from './advancedBias';
import { generateContext } from './contextPipeline';

/** Why a requested second pass did not replace the first one's transcript. */
export type AdvancedSkipReason =
	| 'engine-unsupported'
	| 'no-context'
	| 'incomplete-second-pass'
	| 'too-short'
	| 'failed';

/**
 * What the second pass answered: an improved transcript, or a reason it did
 * not run.
 *
 * An adopted pass carries no failed parts, and says so by not having the
 * field: it is only ever adopted when it succeeded on every part, so the list
 * could hold nothing but an empty array. Stating that in the type is what
 * lets the caller clear the first pass's own failures without testing
 * anything, which is the point of adopting a whole pass rather than merging
 * two.
 */
export type AdvancedPassOutcome =
	| { status: 'improved'; transcript: Transcript }
	| { status: 'skipped'; reason: AdvancedSkipReason; detail?: string };

/** One transcribed part, as the run accumulates them. */
export interface PassResult {
	offsetSeconds: number;
	transcript: Transcript;
	usage?: TranscriptionUsage;
}

/** Transcribes every prepared part once, the way the first pass was transcribed. */
export type TranscribePass = (
	passOptions: TranscribeOptions,
	passResults: PassResult[],
	passFailed: PartFailure[],
	progressBase: number,
	progressSpan: number,
	verb: string,
) => Promise<void>;

/** Everything the scenario needs, fixed for the length of one run. */
export interface AdvancedTwoPassInput {
	/** Live settings for this run. */
	readonly settings: AudioRecorderSettings;
	/** The transcript the first pass produced, and the floor the result must beat. */
	readonly baseline: Transcript;
	/** The options the first pass ran with, which the second pass extends. */
	readonly transcribeOptions: TranscribeOptions;
	/** Id of the engine that produced the baseline, for the stitched result. */
	readonly engineId: string;
	/** Path of the audio, for the stitched result. */
	readonly sourcePath: string;
	/** Where the second pass's parts accumulate, so the caller can bill them. */
	readonly secondPassResults: PassResult[];
	/** Progress the first pass reached, and where the second pass starts. */
	readonly progressBase: number;
	/** Progress the second pass may consume. */
	readonly progressSpan: number;
	/** Reports progress, in the caller's own scale. */
	readonly onProgress?:
		| ((fraction: number, label: string) => void)
		| undefined;
	/** Runs one pass over every part. */
	readonly transcribePass: TranscribePass;
	/** Builds the language model the context agents run on. */
	readonly createLlm: (
		settings: AudioRecorderSettings,
		vendorId: LlmProviderId,
	) => LlmProvider;
	/** Where the agents' spend is recorded. */
	readonly costSink?: LlmCostSink | undefined;
	/** Cancels the run. */
	readonly token: CancellationToken;
	/** Re-throws a cancellation instead of letting it read as a failure. */
	readonly rethrowIfCancelled: (
		error: unknown,
		token: CancellationToken,
	) => void;
	/** Refuses a cancelled run between steps. */
	readonly throwIfCancelled: (token: CancellationToken) => void;
	/** Why this engine cannot carry a bias, when it cannot. */
	readonly unsupportedReason: string | null;
}

/**
 * What the user is told when the second pass did not replace the first one's
 * transcript.
 *
 * One reason, one sentence, built in one place. Every one of them ends the same
 * way on purpose: the run still has the transcript it paid for, and saying so
 * is what keeps the notice from reading as a lost recording.
 * @param outcome - The reason the pass was skipped, and its detail where it has one
 * @returns The sentence to show
 */
export function advancedSkipNotice(outcome: {
	reason: AdvancedSkipReason;
	detail?: string | undefined;
}): string {
	switch (outcome.reason) {
		case 'engine-unsupported':
			return (
				`Advanced two-pass transcription skipped: ${outcome.detail ?? ''}. ` +
				'Keeping the single-pass transcript.'
			);
		case 'no-context':
			return (
				'Advanced two-pass transcription found no usable context; ' +
				'keeping the single-pass transcript.'
			);
		case 'incomplete-second-pass':
			return 'Advanced second pass failed; keeping the first-pass transcript.';
		case 'too-short':
			return (
				'Advanced second pass came back too short; keeping the ' +
				'first-pass transcript.'
			);
		case 'failed':
			return (
				'Advanced two-pass transcription failed; keeping the ' +
				'single-pass transcript.'
			);
	}
}

/**
 * Runs the advanced two-pass scenario over a completed first pass.
 *
 * The class owns nothing the caller needs afterwards except its answer, so a
 * skipped run leaves no trace and an adopted one hands back both the transcript
 * and the parts that were still missing from it.
 */
export class AdvancedTwoPassRunner {
	constructor(private readonly input: AdvancedTwoPassInput) {}

	/**
	 * Mines context from the baseline, re-transcribes with it, and answers
	 * whether the result is worth adopting.
	 * @returns The improved transcript, or the reason there is none
	 * @throws The run's cancellation, which is never reported as a failure
	 */
	async run(): Promise<AdvancedPassOutcome> {
		const { unsupportedReason } = this.input;
		if (unsupportedReason !== null) {
			// Decided before any LLM spend, so a toggle that cannot be honoured
			// costs nothing.
			return {
				status: 'skipped',
				reason: 'engine-unsupported',
				detail: unsupportedReason,
			};
		}
		try {
			return await this.attempt();
		} catch (error) {
			this.input.rethrowIfCancelled(error, this.input.token);
			console.warn(
				`${PLUGIN_LOG_PREFIX} Advanced two-pass transcription failed; keeping the single-pass transcript.`,
				error,
			);
			return { status: 'skipped', reason: 'failed' };
		}
	}

	/** The scenario proper, from context generation to the adoption decision. */
	private async attempt(): Promise<AdvancedPassOutcome> {
		const { settings, baseline, transcribeOptions } = this.input;
		this.input.onProgress?.(
			this.input.progressBase,
			'Analyzing transcript context...',
		);
		// The agents run on the engine the two-pass mode names, which is a
		// choice of its own rather than whatever post-processing points at.
		// This run's Dictionary terms join as bias candidates, vetted against
		// the draft so an off-topic term is not injected. A keyword-biased
		// engine reads only the keyterm list, so the pipeline skips the
		// prompt-sentence agents.
		const llm = this.input.createLlm(
			settings,
			jobVendorId(settings, 'contextAgents'),
		);
		const context = await generateContext(baseline, llm, {
			language: transcribeOptions.language ?? baseline.language,
			glossary: resolveDictionaryTermList(settings),
			buildPromptSentence:
				advancedBiasChannel(settings.transcriptionProvider) ===
				'prompt',
			token: this.input.token,
			settings,
			durationSeconds: baseline.segments.at(-1)?.end ?? null,
			costSink: this.input.costSink,
		});
		const bias = context
			? planAdvancedBias(settings.transcriptionProvider, context)
			: {};
		if (!bias.biasPrompt && !bias.keyterms?.length) {
			return { status: 'skipped', reason: 'no-context' };
		}

		// Pin the second pass's language to the first pass's: the bias is dense
		// with English tokens, and left to auto-detect it can flip a Russian
		// recording into English - the documented failure mode this guards
		// against.
		const secondPassOptions: TranscribeOptions = {
			...transcribeOptions,
			language: transcribeOptions.language ?? baseline.language,
			...bias,
		};
		const secondFailed: PartFailure[] = [];
		await this.input.transcribePass(
			secondPassOptions,
			this.input.secondPassResults,
			secondFailed,
			this.input.progressBase,
			this.input.progressSpan,
			'Second pass: transcribing',
		);
		this.input.throwIfCancelled(this.input.token);

		const secondPass = stitchChunks(this.input.secondPassResults, {
			model: this.input.engineId,
			createdAt: new Date().toISOString(),
			sourcePath: this.input.sourcePath,
		});
		if (
			secondFailed.length > 0 ||
			this.input.secondPassResults.length === 0
		) {
			return { status: 'skipped', reason: 'incomplete-second-pass' };
		}
		if (
			!meetsLengthSafeguard(
				plainText(baseline),
				plainText(secondPass),
				settings.advancedSecondPassMinRatio,
			)
		) {
			// The over-correction guard from the paper: a biased decode that
			// lost this much text is discarded in favour of the baseline.
			return { status: 'skipped', reason: 'too-short' };
		}
		// Reached only with `secondFailed` empty, because the guard above turns
		// any part this pass lost into a skip. So the adopted pass succeeded on
		// every part, including any the first pass lost, and the
		// incomplete-transcription warning follows it away.
		return { status: 'improved', transcript: secondPass };
	}
}

/** Shows the sentence a skipped outcome carries. */
export function reportAdvancedSkip(outcome: {
	reason: AdvancedSkipReason;
	detail?: string | undefined;
}): void {
	new Notice(advancedSkipNotice(outcome));
}
