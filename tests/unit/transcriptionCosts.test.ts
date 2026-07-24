/**
 * Tests for the pure transcription cost model: pricing resolution by
 * engine and model, duration-based estimates, usage-based actuals, usage
 * summing, and display formatting.
 */

import {
	buildCostEstimate,
	costEstimateNeedsDuration,
	costFromUsage,
	estimateLlmCost,
	estimateTranscriptionCost,
	formatUsd,
	GEMINI_AUDIO_TOKENS_PER_SECOND,
	resolveEnginePricing,
	resolveLlmPricing,
	selectedEngineModel,
	selectedLlmModel,
	sumUsage,
} from 'src/transcription/costs';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
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

	it('prices Gemini models per token with separate audio and text rates', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.GEMINI,
				'gemini-2.5-flash',
			),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 1.0,
			usdPerMillionTextInput: 0.3,
			usdPerMillionOutput: 2.5,
		});
	});

	it('prices distil-whisper as its own cheaper model, not the full v3 rate', () => {
		expect(
			resolveEnginePricing(
				TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				'distil-whisper-large-v3-en',
			),
		).toEqual({ kind: 'perMinute', usdPerMinute: 0.02 / 60 });
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

describe('resolveLlmPricing', () => {
	it('prices OpenAI post-processing models per token', () => {
		expect(
			resolveLlmPricing(
				LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				'gpt-4o-mini',
			),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 0.15,
			usdPerMillionTextInput: 0.15,
			usdPerMillionOutput: 0.6,
		});
	});

	it('prices Gemini post-processing at the text-input rate, not the audio rate', () => {
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.GEMINI, 'gemini-2.5-flash'),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 0.3,
			usdPerMillionTextInput: 0.3,
			usdPerMillionOutput: 2.5,
		});
	});

	it('returns null for an LLM model with no built-in rate', () => {
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.ANTHROPIC, 'mystery-model'),
		).toBeNull();
	});
});

describe('selectedLlmModel', () => {
	it('returns the model the settings select for the current LLM provider', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
			llmAnthropicModel: 'claude-opus-4-8',
			llmOpenAiModel: 'gpt-4o-mini',
		});
		expect(selectedLlmModel(settings)).toBe('claude-opus-4-8');
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

	const geminiPricing = {
		kind: 'perToken' as const,
		usdPerMillionAudioInput: 1.0,
		usdPerMillionTextInput: 0.3,
		usdPerMillionOutput: 2.5,
	};

	it('bills token engines by audio input, text input, and output', () => {
		// 1M audio input at $1/M plus 200k output at $2.50/M.
		const usd = costFromUsage(geminiPricing, {
			inputTokens: 1_000_000,
			audioInputTokens: 1_000_000,
			outputTokens: 200_000,
		});
		expect(usd).toBeCloseTo(1.5, 10);
	});

	it('prices the non-audio part of the prompt at the text rate', () => {
		// 900k audio at $1/M plus 100k text at $0.30/M plus no output.
		const usd = costFromUsage(geminiPricing, {
			inputTokens: 1_000_000,
			audioInputTokens: 900_000,
		});
		expect(usd).toBeCloseTo(0.9 + 0.03, 10);
	});

	it('treats a prompt with no modality split as all text', () => {
		// No audioInputTokens: the whole prompt is billed at the text rate.
		const usd = costFromUsage(geminiPricing, { inputTokens: 1_000_000 });
		expect(usd).toBeCloseTo(0.3, 10);
	});

	it('returns null when a token engine reported no tokens', () => {
		expect(costFromUsage(geminiPricing, { audioSeconds: 10 })).toBeNull();
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
				{ inputTokens: 100, audioInputTokens: 80, outputTokens: 20 },
				{ inputTokens: 40, audioInputTokens: 30 },
			]),
		).toEqual({
			audioSeconds: 90,
			inputTokens: 140,
			audioInputTokens: 110,
			outputTokens: 20,
		});
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

describe('estimateLlmCost', () => {
	it('estimates a cleanup pass from the transcript token size', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
			llmPostProcessTask: 'cleanup',
			llmMaxTokens: 4096,
		});
		// 600s -> 4800 transcript tokens in, cleanup output capped at the 4096
		// token budget. Input at $0.15/M, output at $0.60/M.
		const usd = estimateLlmCost(settings, 600);
		expect(usd).toBeCloseTo(
			(4800 * 0.15) / 1_000_000 + (4096 * 0.6) / 1_000_000,
			10,
		);
	});

	it('is null for an LLM model with no built-in rate', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'mystery-model',
		});
		expect(estimateLlmCost(settings, 600)).toBeNull();
	});
});

describe('buildCostEstimate', () => {
	it('prices transcription alone when post-processing is off', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		const estimate = buildCostEstimate(settings, 600);
		expect(estimate.lines).toHaveLength(1);
		expect(estimate.lines[0]).toMatchObject({
			label: 'Transcription',
			providerName: 'Deepgram',
			model: 'nova-3',
			pricingUrl: 'https://deepgram.com/pricing',
		});
		expect(estimate.lines[0]?.usd).toBeCloseTo(0.043, 10);
		expect(estimate.totalUsd).toBeCloseTo(0.043, 10);
		expect(estimate.hasUnpriced).toBe(false);
	});

	it('adds a post-processing line and sums both into the total', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: true,
			llmPostProcessTask: 'cleanup',
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
			llmMaxTokens: 4096,
		});
		const estimate = buildCostEstimate(settings, 600);
		expect(estimate.lines).toHaveLength(2);
		expect(estimate.lines[1]?.label).toBe('Post-processing (Clean up)');
		expect(estimate.lines[1]?.providerName).toBe('OpenAI');
		const transcription = estimate.lines[0]?.usd ?? 0;
		const postProcess = estimate.lines[1]?.usd ?? 0;
		expect(estimate.totalUsd).toBeCloseTo(transcription + postProcess, 10);
	});

	it('marks the free local engine as free and needs no link', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			llmPostProcessEnabled: false,
		});
		const estimate = buildCostEstimate(settings, 600);
		expect(estimate.lines[0]).toMatchObject({ free: true, usd: 0 });
		expect(estimate.lines[0]?.pricingUrl).toBeUndefined();
		expect(estimate.totalUsd).toBe(0);
	});

	it('flags an unknown model as unpriced without a wrong number', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'mystery',
			llmPostProcessEnabled: false,
		});
		const estimate = buildCostEstimate(settings, 600);
		expect(estimate.lines[0]?.usd).toBeNull();
		expect(estimate.lines[0]?.reason).toBe('no-rate');
		expect(estimate.totalUsd).toBeNull();
		expect(estimate.hasUnpriced).toBe(true);
	});

	it('reports a duration-unreadable reason when the duration is null', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmPostProcessEnabled: false,
		});
		const estimate = buildCostEstimate(settings, null);
		expect(estimate.lines[0]?.usd).toBeNull();
		expect(estimate.lines[0]?.reason).toBe('no-duration');
	});

	it('doubles the transcription and adds a context-agents line for the two-pass mode', () => {
		const single = buildCostEstimate(
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			}),
			600,
		);
		const estimate = buildCostEstimate(
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionAdvancedEnabled: true,
				llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				llmOpenAiModel: 'gpt-4o-mini',
			}),
			600,
		);
		// The transcription line names the two passes and costs twice a single.
		expect(estimate.lines[0]?.label).toBe('Transcription (2 passes)');
		expect(estimate.lines[0]?.usd).toBeCloseTo(
			(single.lines[0]?.usd ?? 0) * 2,
			10,
		);
		// A distinct LLM line prices the context agents that run between passes.
		const agents = estimate.lines.find(
			(line) => line.label === 'Advanced context agents',
		);
		expect(agents?.providerName).toBe('OpenAI');
		expect(agents?.usd).not.toBeNull();
	});

	it('prices fewer context agents for a keyword-biased engine than a prompt-biased one', () => {
		const base = {
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
		};
		const promptEngine = buildCostEstimate(
			mergeSettings({
				...base,
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			}),
			600,
		);
		const keytermEngine = buildCostEstimate(
			mergeSettings({
				...base,
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			}),
			600,
		);
		const agentsUsd = (estimate: typeof promptEngine): number =>
			estimate.lines.find(
				(line) => line.label === 'Advanced context agents',
			)?.usd ?? 0;
		// Deepgram reads only the keyterm list, so the pipeline runs four agents
		// where a prompt-biased engine runs six (it skips the topic and sentence
		// agents); the estimate follows suit at two-thirds the cost.
		expect(agentsUsd(promptEngine)).toBeGreaterThan(0);
		expect(agentsUsd(keytermEngine)).toBeCloseTo(
			agentsUsd(promptEngine) * (4 / 6),
			10,
		);
	});

	it('does not double the transcription when the master is on but two-pass is off', () => {
		const estimate = buildCostEstimate(
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionAdvancedEnabled: false,
			}),
			600,
		);
		expect(estimate.lines).toHaveLength(1);
		expect(estimate.lines[0]?.label).toBe('Transcription');
	});

	it('prices a single pass with no context agents for a non-biasing two-pass model', () => {
		// A Deepgram hosted Whisper model cannot bias, so the service degrades to
		// one plain pass with no context agents before any LLM spend. The
		// estimate must follow suit and not show a phantom second pass or an
		// agents line the user would never be charged for.
		const estimate = buildCostEstimate(
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'whisper',
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionAdvancedEnabled: true,
				llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				llmOpenAiModel: 'gpt-4o-mini',
			}),
			600,
		);
		expect(estimate.lines).toHaveLength(1);
		expect(estimate.lines[0]?.label).toBe('Transcription');
		expect(
			estimate.lines.some(
				(line) => line.label === 'Advanced context agents',
			),
		).toBe(false);
	});

	it('adds an auto-chapters line when chapters run after transcription', () => {
		const estimate = buildCostEstimate(
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
				transcriptionAutoChaptersEnabled: true,
				transcriptionAutoChaptersOnTranscribe: true,
				llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				llmOpenAiModel: 'gpt-4o-mini',
			}),
			600,
		);
		const chapters = estimate.lines.find(
			(line) => line.label === 'Auto chapters',
		);
		expect(chapters?.providerName).toBe('OpenAI');
		expect(chapters?.usd).not.toBeNull();
	});
});

describe('costEstimateNeedsDuration', () => {
	it('is true for a cloud engine', () => {
		expect(
			costEstimateNeedsDuration(
				mergeSettings({
					transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
					deepgramModel: 'nova-3',
					llmPostProcessEnabled: false,
				}),
			),
		).toBe(true);
	});

	it('is false for a free local run with no post-processing', () => {
		expect(
			costEstimateNeedsDuration(
				mergeSettings({
					transcriptionProvider:
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					llmPostProcessEnabled: false,
				}),
			),
		).toBe(false);
	});

	it('is true for a free local run once post-processing is enabled', () => {
		expect(
			costEstimateNeedsDuration(
				mergeSettings({
					transcriptionProvider:
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					llmPostProcessEnabled: true,
					llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
					llmOpenAiModel: 'gpt-4o-mini',
				}),
			),
		).toBe(true);
	});

	it('is true for a free local run whose advanced context agents are priced', () => {
		// The two-pass agents are an LLM step, so even a free engine needs the
		// duration to price them.
		expect(
			costEstimateNeedsDuration(
				mergeSettings({
					transcriptionProvider:
						TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					transcriptionAdvancedSettingsEnabled: true,
					transcriptionAdvancedEnabled: true,
					llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
					llmOpenAiModel: 'gpt-4o-mini',
				}),
			),
		).toBe(true);
	});
});
