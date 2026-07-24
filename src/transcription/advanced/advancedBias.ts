/**
 * Routes the generated context of the advanced two-pass mode into the biasing
 * channel each transcription engine actually supports: a Whisper-style prompt
 * sentence for the Whisper API, local whisper.cpp, and Gemini (which folds it
 * into its instruction text), or a flat keyterm list for Deepgram. The support
 * check is separate from the routing so the service can skip the LLM context
 * generation entirely - and tell the user - when the selected engine or model
 * cannot carry any bias, instead of paying for agents whose output would be
 * dropped.
 * @module transcription/advanced/advancedBias
 */

import {
	DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO,
	MIN_ADVANCED_SECOND_PASS_MIN_RATIO,
	MAX_ADVANCED_SECOND_PASS_MIN_RATIO,
	TRANSCRIPTION_PROVIDER_IDS,
} from '../../constants';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from '../../settings/settingsSchema';
import { advancedTwoPassEnabled } from '../../settings/settingsSchema';
import { deepgramBiasMechanism } from '../dictionaryBias';
import { providerSupportsDictionary } from '../providers/capabilities';
import type { GeneratedContext } from './contextPipeline';

/** The bias fields to add to the second pass's transcription options. */
export interface AdvancedBiasPlan {
	/** Prompt sentence for prompt-biased engines (Whisper, Gemini). */
	biasPrompt?: string;
	/** Keyterm list for keyword-biased engines (Deepgram). */
	keyterms?: string[];
}

/**
 * How an engine carries the generated bias: a Whisper-style prompt sentence, or
 * a flat keyterm list.
 */
export type AdvancedBiasChannel = 'prompt' | 'keyterm';

/**
 * The biasing channel an engine reads. The single source of truth shared by the
 * context pipeline - which only builds the representation the channel needs, so
 * a keyword-biased engine does not pay for a prompt sentence it would discard -
 * and the routing in {@link planAdvancedBias}. Deepgram biases by keyword list;
 * every other biasing engine reads a prompt sentence.
 * @param engineId - Selected transcription engine id
 * @returns The channel the engine biases through
 */
export function advancedBiasChannel(
	engineId: TranscriptionProviderId,
): AdvancedBiasChannel {
	return engineId === TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM
		? 'keyterm'
		: 'prompt';
}

/**
 * Why the selected engine cannot run a biased second pass, or null when it
 * can. Checked before context generation so an unsupported engine degrades to
 * the normal single pass without spending any LLM calls.
 * @param engineId - Selected transcription engine id
 * @param deepgramModel - Configured Deepgram model id (consulted only for Deepgram)
 * @returns A user-facing reason, or null when the engine can bias
 */
export function advancedBiasUnsupportedReason(
	engineId: TranscriptionProviderId,
	deepgramModel: string,
): string | null {
	if (!providerSupportsDictionary(engineId)) {
		return 'the selected engine cannot bias recognition';
	}
	if (
		engineId === TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM &&
		deepgramBiasMechanism(deepgramModel) === null
	) {
		return `the Deepgram model "${deepgramModel}" cannot bias recognition (choose a Nova model)`;
	}
	return null;
}

/**
 * Whether a run will actually perform the biased second pass: the two-pass mode
 * is enabled AND the selected engine/model can carry a bias. The service
 * degrades an unsupported engine (e.g. a Deepgram hosted Whisper model) to a
 * single plain pass before any LLM spend, so the cost estimate and the session
 * accounting read this predicate - not the bare toggle - and never price a
 * second pass or context agents that will not run.
 * @param settings - The run's settings snapshot
 * @returns True when the biased second pass and its context agents will run
 */
export function advancedTwoPassWillRun(
	settings: Pick<
		AudioRecorderSettings,
		| 'transcriptionAdvancedSettingsEnabled'
		| 'transcriptionAdvancedEnabled'
		| 'transcriptionProvider'
		| 'deepgramModel'
	>,
): boolean {
	return (
		advancedTwoPassEnabled(settings) &&
		advancedBiasUnsupportedReason(
			settings.transcriptionProvider,
			settings.deepgramModel,
		) === null
	);
}

/**
 * Maps the generated context onto the engine's biasing channel. Deepgram
 * biases by keyword list, so it gets the flat keyterms; every other biasing
 * engine gets the prompt sentence. A plan with neither field set (e.g. the
 * pipeline produced only a topic and the engine needs keyterms) means there
 * is nothing to bias and the second pass should be skipped.
 * @param engineId - Selected transcription engine id
 * @param context - The generated context from the first pass
 * @returns The bias fields for the second pass
 */
export function planAdvancedBias(
	engineId: TranscriptionProviderId,
	context: GeneratedContext,
): AdvancedBiasPlan {
	if (advancedBiasChannel(engineId) === 'keyterm') {
		return context.keyterms.length ? { keyterms: context.keyterms } : {};
	}
	return context.promptSentence ? { biasPrompt: context.promptSentence } : {};
}

/**
 * The paper's length safeguard against over-correction: whether the biased
 * second pass kept enough text to be trusted over the baseline. A biased
 * decode that came back much shorter almost certainly dropped content, so
 * the run reverts to the first pass below the ratio. A synced or hand-edited
 * ratio outside the settings range falls back to the shipped default rather
 * than weakening the guard: a value below the configured minimum (0 would let
 * an empty second pass through) or above 1 (which would disable the mode) is
 * rejected, matching what the settings-tab input allows.
 * @param baselineText - Plain text of the first pass's transcript
 * @param secondPassText - Plain text of the biased second pass
 * @param minRatio - Configured minimum second-to-first length ratio
 * @returns True when the second pass is long enough to adopt
 */
export function meetsLengthSafeguard(
	baselineText: string,
	secondPassText: string,
	minRatio: number,
): boolean {
	const ratio =
		Number.isFinite(minRatio) &&
		minRatio >= MIN_ADVANCED_SECOND_PASS_MIN_RATIO &&
		minRatio <= MAX_ADVANCED_SECOND_PASS_MIN_RATIO
			? minRatio
			: DEFAULT_ADVANCED_SECOND_PASS_MIN_RATIO;
	return secondPassText.length >= baselineText.length * ratio;
}
