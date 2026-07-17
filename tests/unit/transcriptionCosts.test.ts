/**
 * Tests for the pure transcription cost model: pricing resolution by
 * engine and model, duration-based estimates, usage-based actuals, usage
 * summing, and display formatting.
 */

import {
	costFromUsage,
	describeCostEstimate,
	estimateTranscriptionCost,
	formatUsd,
	GEMINI_AUDIO_TOKENS_PER_SECOND,
	resolveEnginePricing,
	selectedEngineModel,
	sumUsage,
} from 'src/transcription/costs';
import { TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import { mergeSettings } from 'src/settings/settingsSerialization';

describe('resolveEnginePricing', () => {
	it('is free for the local engine regardless of model', () => {
		expect(
			resolveEnginePricing(TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER, ''),
		).toEqual({ kind: 'free' });
	});

	it('prices whisper-1 per minute', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				'whisper-1',
			),
		).toEqual({ kind: 'perMinute', usdPerMinute: 0.006 });
	});

	it('prefers the longest matching fragment (v3-turbo over v3)', () => {
		const turbo = resolveEnginePricing(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			'whisper-large-v3-turbo',
		);
		const v3 = resolveEnginePricing(
			TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			'whisper-large-v3',
		);
		expect(turbo).toEqual({
			kind: 'perMinute',
			usdPerMinute: 0.04 / 60,
		});
		expect(v3).toEqual({
			kind: 'perMinute',
			usdPerMinute: 0.111 / 60,
		});
	});

	it('matches Deepgram model variants by fragment', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				'nova-2-meeting',
			),
		).toEqual({ kind: 'perMinute', usdPerMinute: 0.0043 });
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				'enhanced-phonecall',
			),
		).toEqual({ kind: 'perMinute', usdPerMinute: 0.0145 });
	});

	it('prices Gemini models per token', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				'gemini-2.5-flash',
			),
		).toEqual({
			kind: 'perToken',
			usdPerMillionInput: 1.0,
			usdPerMillionOutput: 2.5,
		});
	});

	it('returns null for a model with no built-in rate', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				'my-custom-model',
			),
		).toBeNull();
	});
});

describe('selectedEngineModel', () => {
	it('returns the model the settings select for each engine', () => {
		const settings = mergeSettings({
			whisperApiModel: 'whisper-1',
			deepgramModel: 'nova-3',
			geminiModel: 'gemini-2.5-flash',
		});
		expect(
			selectedEngineModel(
				settings,
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			),
		).toBe('whisper-1');
		expect(
			selectedEngineModel(settings, TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM),
		).toBe('nova-3');
		expect(
			selectedEngineModel(settings, TRANSCRIPTION_PROVIDER_IDS.GEMINI),
		).toBe('gemini-2.5-flash');
		expect(
			selectedEngineModel(
				settings,
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			),
		).toBe('');
	});
});

describe('costFromUsage', () => {
	it('bills per-minute engines by reported audio seconds', () => {
		const usd = costFromUsage(
			{ kind: 'perMinute', usdPerMinute: 0.006 },
			{ audioSeconds: 600 },
		);
		expect(usd).toBeCloseTo(0.06, 10);
	});

	it('returns null when a per-minute engine reported no seconds', () => {
		expect(
			costFromUsage({ kind: 'perMinute', usdPerMinute: 0.006 }, {}),
		).toBeNull();
	});

	it('bills token engines by input and output tokens', () => {
		const usd = costFromUsage(
			{
				kind: 'perToken',
				usdPerMillionInput: 1.0,
				usdPerMillionOutput: 2.5,
			},
			{ inputTokens: 1_000_000, outputTokens: 200_000 },
		);
		expect(usd).toBeCloseTo(1.5, 10);
	});

	it('returns null when a token engine reported no tokens', () => {
		expect(
			costFromUsage(
				{
					kind: 'perToken',
					usdPerMillionInput: 1.0,
					usdPerMillionOutput: 2.5,
				},
				{ audioSeconds: 10 },
			),
		).toBeNull();
	});

	it('is zero for the free engine', () => {
		expect(costFromUsage({ kind: 'free' }, {})).toBe(0);
	});
});

describe('estimateTranscriptionCost', () => {
	it('estimates a per-minute engine from the duration', () => {
		const usd = estimateTranscriptionCost(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			600,
		);
		expect(usd).toBeCloseTo(0.043, 10);
	});

	it('estimates a token engine from synthesized token counts', () => {
		const usd = estimateTranscriptionCost(
			TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			'gemini-2.5-flash',
			60,
		);
		// 60s -> 1920 audio tokens at $1/1M plus 480 output tokens at $2.5/1M.
		expect(usd).toBeCloseTo(
			(60 * GEMINI_AUDIO_TOKENS_PER_SECOND) / 1_000_000 +
				(60 * 8 * 2.5) / 1_000_000,
			10,
		);
	});

	it('is zero for the local engine and null for unknown models', () => {
		expect(
			estimateTranscriptionCost(
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				'',
				600,
			),
		).toBe(0);
		expect(
			estimateTranscriptionCost(
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				'mystery',
				600,
			),
		).toBeNull();
	});
});

describe('sumUsage', () => {
	it('sums only the fields parts actually reported', () => {
		expect(
			sumUsage([
				{ audioSeconds: 60 },
				undefined,
				{ audioSeconds: 30 },
				{ inputTokens: 100, outputTokens: 20 },
			]),
		).toEqual({ audioSeconds: 90, inputTokens: 100, outputTokens: 20 });
	});

	it('returns an empty total when nothing was reported', () => {
		expect(sumUsage([undefined, {}])).toEqual({});
	});
});

describe('formatUsd', () => {
	it('formats zero, sub-cent, and regular amounts', () => {
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(0.001)).toBe('<$0.01');
		expect(formatUsd(0.043)).toBe('$0.04');
		expect(formatUsd(1.5)).toBe('$1.50');
	});
});

describe('describeCostEstimate', () => {
	it('describes the local engine as free', () => {
		expect(
			describeCostEstimate(
				TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
				'',
				600,
			),
		).toBe('Local engine - no API cost.');
	});

	it('names the model when no built-in rate matches', () => {
		expect(
			describeCostEstimate(
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				'mystery',
				600,
			),
		).toContain('No built-in rate for model "mystery"');
	});

	it('degrades cleanly when the duration is unknown', () => {
		expect(
			describeCostEstimate(
				TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				'nova-3',
				null,
			),
		).toContain('duration could not be read');
	});

	it('prices a per-minute engine with duration and rate', () => {
		const text = describeCostEstimate(
			TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			'nova-3',
			600,
		);
		expect(text).toContain('Estimated cost: ~$0.04');
		expect(text).toContain('10:00');
		expect(text).toContain('nova-3');
	});

	it('prices a token engine with audio-token counts', () => {
		const text = describeCostEstimate(
			TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			'gemini-2.5-flash',
			3600,
		);
		expect(text).toContain('Estimated cost:');
		expect(text).toContain('audio tokens');
		expect(text).toContain('gemini-2.5-flash');
	});
});
