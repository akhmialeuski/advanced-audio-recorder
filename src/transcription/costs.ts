/**
 * Cost model for the cloud transcription engines: built-in approximate
 * rates per engine and model, a pre-run estimate from the audio duration,
 * and conversion of provider-reported usage (billed seconds or tokens)
 * into dollars. Rates are pay-as-you-go list prices at the time of
 * writing and are inherently approximate - providers change pricing, so
 * every figure is presented as an estimate, and an unknown model yields
 * "no estimate" rather than a wrong number. All functions are pure.
 * @module transcription/costs
 */

import { TRANSCRIPTION_PROVIDER_IDS } from '../constants';
import type {
	AudioRecorderSettings,
	TranscriptionProviderId,
} from '../settings/settingsSchema';
import { formatTimecode } from '../utils/TimeUtils';
import type { TranscriptionUsage } from './TranscriptTypes';

/** How an engine bills a transcription request. */
export type EnginePricing =
	| { kind: 'free' }
	| { kind: 'perMinute'; usdPerMinute: number }
	| {
			kind: 'perToken';
			usdPerMillionInput: number;
			usdPerMillionOutput: number;
	  };

/**
 * Audio tokens per second for Gemini models (Google's documented rate for
 * audio input tokenization).
 */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

/**
 * Rough transcript output tokens per second of speech, used only for the
 * pre-run estimate of a token-billed engine (roughly 2.5 words/s of
 * speech plus JSON structure overhead).
 */
export const ESTIMATED_OUTPUT_TOKENS_PER_SECOND = 8;

/**
 * Approximate per-minute rates by model-id fragment, matched longest
 * fragment first so `whisper-large-v3-turbo` never resolves through
 * `whisper-large-v3`. Values are USD per audio minute.
 */
const WHISPER_API_RATES: readonly [string, number][] = [
	// Groq-hosted Whisper models (priced per hour: $0.04 / $0.111).
	['whisper-large-v3-turbo', 0.04 / 60],
	['whisper-large-v3', 0.111 / 60],
	// OpenAI whisper-1.
	['whisper-1', 0.006],
];

/** Approximate Deepgram pre-recorded pay-as-you-go rates, USD per minute. */
const DEEPGRAM_RATES: readonly [string, number][] = [
	['enhanced', 0.0145],
	['whisper', 0.0048],
	['nova-3', 0.0043],
	['nova-2', 0.0043],
	['nova', 0.0043],
	['base', 0.0125],
];

/** Approximate Gemini rates, USD per million tokens (audio input, output). */
const GEMINI_RATES: readonly [string, { input: number; output: number }][] = [
	['gemini-2.5-flash-lite', { input: 0.3, output: 0.4 }],
	['gemini-2.5-flash', { input: 1.0, output: 2.5 }],
	['gemini-2.5-pro', { input: 1.25, output: 10 }],
	['gemini-2.0-flash', { input: 0.7, output: 0.4 }],
];

/**
 * Finds the rate whose model-id fragment appears in the (normalized)
 * model id, preferring the longest fragment so more specific entries win.
 */
function matchRate<T>(
	rates: readonly [string, T][],
	model: string,
): T | undefined {
	const normalized = model.trim().toLowerCase();
	let best: { length: number; value: T } | undefined;
	for (const [fragment, value] of rates) {
		if (
			normalized.includes(fragment) &&
			(!best || fragment.length > best.length)
		) {
			best = { length: fragment.length, value };
		}
	}
	return best?.value;
}

/**
 * Resolves the pricing for an engine and model. Model ids are free-form
 * user-editable strings, so an id no built-in rate matches yields null
 * ("no estimate") instead of a wrong number. The local engine is always
 * free.
 * @param engineId - Transcription engine id
 * @param model - Selected model id for that engine
 */
export function resolveEnginePricing(
	engineId: TranscriptionProviderId,
	model: string,
): EnginePricing | null {
	switch (engineId) {
		case TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER:
			return { kind: 'free' };
		case TRANSCRIPTION_PROVIDER_IDS.WHISPER_API: {
			const rate = matchRate(WHISPER_API_RATES, model);
			return rate === undefined
				? null
				: { kind: 'perMinute', usdPerMinute: rate };
		}
		case TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM: {
			const rate = matchRate(DEEPGRAM_RATES, model);
			return rate === undefined
				? null
				: { kind: 'perMinute', usdPerMinute: rate };
		}
		case TRANSCRIPTION_PROVIDER_IDS.GEMINI: {
			const rate = matchRate(GEMINI_RATES, model);
			return rate === undefined
				? null
				: {
						kind: 'perToken',
						usdPerMillionInput: rate.input,
						usdPerMillionOutput: rate.output,
					};
		}
		default:
			return null;
	}
}

/**
 * Returns the model id the settings select for the given engine ('' for
 * the local engine, which has no billed model).
 * @param settings - Plugin settings
 * @param engineId - Transcription engine id
 */
export function selectedEngineModel(
	settings: AudioRecorderSettings,
	engineId: TranscriptionProviderId,
): string {
	switch (engineId) {
		case TRANSCRIPTION_PROVIDER_IDS.WHISPER_API:
			return settings.whisperApiModel;
		case TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM:
			return settings.deepgramModel;
		case TRANSCRIPTION_PROVIDER_IDS.GEMINI:
			return settings.geminiModel;
		default:
			return '';
	}
}

/**
 * Converts provider-reported usage into dollars under the given pricing.
 * Returns null when the usage carries nothing the pricing can bill (e.g.
 * a per-minute engine that reported no billed seconds), so a caller can
 * fall back to an estimate instead of showing a false zero.
 * @param pricing - Engine pricing
 * @param usage - Provider-reported usage
 */
export function costFromUsage(
	pricing: EnginePricing,
	usage: TranscriptionUsage,
): number | null {
	switch (pricing.kind) {
		case 'free':
			return 0;
		case 'perMinute':
			return usage.audioSeconds === undefined
				? null
				: (usage.audioSeconds / 60) * pricing.usdPerMinute;
		case 'perToken': {
			if (
				usage.inputTokens === undefined &&
				usage.outputTokens === undefined
			) {
				return null;
			}
			return (
				((usage.inputTokens ?? 0) / 1_000_000) *
					pricing.usdPerMillionInput +
				((usage.outputTokens ?? 0) / 1_000_000) *
					pricing.usdPerMillionOutput
			);
		}
	}
}

/**
 * Synthesizes the usage a run of the given duration is expected to bill,
 * so the pre-run estimate can go through the same {@link costFromUsage}
 * math as the post-run actuals.
 * @param pricing - Engine pricing
 * @param durationSeconds - Audio duration in seconds
 */
function estimatedUsage(
	pricing: EnginePricing,
	durationSeconds: number,
): TranscriptionUsage {
	if (pricing.kind === 'perToken') {
		return {
			inputTokens: Math.ceil(
				durationSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND,
			),
			outputTokens: Math.ceil(
				durationSeconds * ESTIMATED_OUTPUT_TOKENS_PER_SECOND,
			),
		};
	}
	return { audioSeconds: durationSeconds };
}

/**
 * Estimates the cost of transcribing the given duration on an engine and
 * model. Returns null when no built-in rate matches the model.
 * @param engineId - Transcription engine id
 * @param model - Selected model id
 * @param durationSeconds - Audio duration in seconds
 */
export function estimateTranscriptionCost(
	engineId: TranscriptionProviderId,
	model: string,
	durationSeconds: number,
): number | null {
	const pricing = resolveEnginePricing(engineId, model);
	if (!pricing) {
		return null;
	}
	return costFromUsage(pricing, estimatedUsage(pricing, durationSeconds));
}

/**
 * Sums the usage several parts reported into one total. A field appears
 * in the total only when at least one part reported it, preserving the
 * "missing means not reported" convention.
 * @param usages - Per-part usage reports (undefined entries are skipped)
 */
export function sumUsage(
	usages: readonly (TranscriptionUsage | undefined)[],
): TranscriptionUsage {
	const total: TranscriptionUsage = {};
	for (const usage of usages) {
		if (!usage) {
			continue;
		}
		if (usage.audioSeconds !== undefined) {
			total.audioSeconds = (total.audioSeconds ?? 0) + usage.audioSeconds;
		}
		if (usage.inputTokens !== undefined) {
			total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
		}
		if (usage.outputTokens !== undefined) {
			total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
		}
	}
	return total;
}

/**
 * Formats a dollar amount for display: two decimals for readable sums, a
 * "less than a cent" form for tiny ones so a short clip never shows a
 * misleading `$0.00`.
 * @param usd - Amount in dollars
 */
export function formatUsd(usd: number): string {
	if (usd === 0) {
		return '$0.00';
	}
	if (usd < 0.005) {
		return '<$0.01';
	}
	return `$${usd.toFixed(2)}`;
}

/**
 * Builds the pre-run estimate line for the transcribe dialog. Pure so the
 * wording is unit tested; the dialog only decides when to show it.
 * @param engineId - Engine selected for the run
 * @param model - Model selected for the run
 * @param durationSeconds - Probed audio duration, or null when unknown
 */
export function describeCostEstimate(
	engineId: TranscriptionProviderId,
	model: string,
	durationSeconds: number | null,
): string {
	const pricing = resolveEnginePricing(engineId, model);
	if (pricing?.kind === 'free') {
		return 'Local engine - no API cost.';
	}
	if (!pricing) {
		return `No built-in rate for model "${model}" - cost estimate unavailable.`;
	}
	if (durationSeconds === null) {
		return 'Cost estimate unavailable - the audio duration could not be read.';
	}
	const usd = costFromUsage(
		pricing,
		estimatedUsage(pricing, durationSeconds),
	);
	if (usd === null) {
		return 'Cost estimate unavailable.';
	}
	const duration = formatTimecode(durationSeconds);
	if (pricing.kind === 'perMinute') {
		return (
			`Estimated cost: ~${formatUsd(usd)} ` +
			`(${duration} at $${String(pricing.usdPerMinute)}/min, ${model}). ` +
			'Built-in approximate rate - verify against your provider.'
		);
	}
	const inputTokens = Math.ceil(
		durationSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND,
	);
	return (
		`Estimated cost: ~${formatUsd(usd)} ` +
		`(${duration}, ~${String(Math.round(inputTokens / 1000))}k audio tokens, ${model}). ` +
		'Built-in approximate rate - verify against your provider.'
	);
}
