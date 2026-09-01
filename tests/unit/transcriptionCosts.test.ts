/**
 * Tests for the pure transcription cost model: pricing resolution by
 * engine and model, duration-based estimates, usage-based actuals, usage
 * summing, and display formatting.
 */

import {
	buildCostEstimate,
	costEstimateNeedsDuration,
	costFromUsage,
	estimateStepCost,
	formatUsd,
	GEMINI_AUDIO_TOKENS_PER_SECOND,
	llmCallCostFromUsage,
	resolveEnginePricing,
	resolveLlmPricing,
	runCostToRecord,
	selectedEngineModel,
	sumUsage,
	type RunCostStepId,
} from 'src/transcription/costs';
import { LLM_PROVIDER_IDS, TRANSCRIPTION_PROVIDER_IDS } from 'src/constants';
import {
	extractGeminiUsage,
	extractOpenAiUsage,
} from 'src/transcription/llm/llmResponse';
import { mergeSettings } from 'src/settings/settingsSerialization';

describe('resolveEnginePricing', () => {
	it.each([
		{
			name: 'the local engine, free whatever the model',
			engine: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			model: '',
			expected: { kind: 'free' },
		},
		{
			name: 'the local engine with a model named',
			engine: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			model: 'ggml-large-v3',
			expected: { kind: 'free' },
		},
		{
			name: 'whisper-1, priced per minute',
			engine: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			model: 'whisper-1',
			expected: { kind: 'perMinute', usdPerMinute: 0.006 },
		},
		{
			// The longest matching fragment wins, or v3-turbo would be priced
			// at the dearer v3 rate its name contains.
			name: 'whisper-large-v3-turbo, not the v3 rate its name contains',
			engine: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			model: 'whisper-large-v3-turbo',
			expected: { kind: 'perMinute', usdPerMinute: 0.04 / 60 },
		},
		{
			name: 'whisper-large-v3',
			engine: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			model: 'whisper-large-v3',
			expected: { kind: 'perMinute', usdPerMinute: 0.111 / 60 },
		},
		{
			name: 'distil-whisper, its own cheaper model rather than full v3',
			engine: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			model: 'distil-whisper-large-v3-en',
			expected: { kind: 'perMinute', usdPerMinute: 0.02 / 60 },
		},
		{
			name: 'a Deepgram nova tier',
			engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			model: 'nova-2-meeting',
			expected: { kind: 'perMinute', usdPerMinute: 0.0043 },
		},
		{
			name: 'a Deepgram enhanced tier',
			engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			model: 'enhanced-phonecall',
			expected: { kind: 'perMinute', usdPerMinute: 0.0145 },
		},
		{
			name: 'a Gemini 2.x model, audio and text priced apart',
			engine: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			model: 'gemini-2.5-flash',
			expected: {
				kind: 'perToken',
				usdPerMillionAudioInput: 1.0,
				usdPerMillionTextInput: 0.3,
				usdPerMillionOutput: 2.5,
			},
		},
		{
			name: 'a Gemini 3.x model, one rate for every input modality',
			engine: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			model: 'gemini-3.5-flash',
			expected: {
				kind: 'perToken',
				usdPerMillionAudioInput: 1.5,
				usdPerMillionTextInput: 1.5,
				usdPerMillionOutput: 9,
			},
		},
		{
			name: 'gemini-3.5-flash-lite, its own model rather than full Flash',
			engine: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			model: 'gemini-3.5-flash-lite',
			expected: {
				kind: 'perToken',
				usdPerMillionAudioInput: 0.3,
				usdPerMillionTextInput: 0.3,
				usdPerMillionOutput: 2.5,
			},
		},
	])('prices $name', ({ engine, model, expected }) => {
		expect(resolveEnginePricing(engine, model)).toEqual(expected);
	});

	it.each([
		{
			name: 'a model with no built-in rate',
			engine: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			model: 'my-custom-model',
		},
		{
			name: 'an empty model on a paid engine',
			engine: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			model: '',
		},
	])('has no price for $name', ({ engine, model }) => {
		expect(resolveEnginePricing(engine, model)).toBeNull();
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

	it('prices the seeded GPT-5.6 family', () => {
		expect(
			resolveLlmPricing(
				LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				'gpt-5.6-sol',
			),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 5,
			usdPerMillionTextInput: 5,
			usdPerMillionOutput: 30,
		});
		expect(
			resolveLlmPricing(
				LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				'gpt-5.6-luna',
			),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 1,
			usdPerMillionTextInput: 1,
			usdPerMillionOutput: 6,
		});
	});

	it('prices current Anthropic models, keeping the legacy Opus 4.0/4.1 rate apart', () => {
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.ANTHROPIC, 'claude-sonnet-5'),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 3,
			usdPerMillionTextInput: 3,
			usdPerMillionOutput: 15,
		});
		// Opus 4.5-4.8 bill $5/$25 via the bare claude-opus-4 fragment...
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.ANTHROPIC, 'claude-opus-4-8'),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 5,
			usdPerMillionTextInput: 5,
			usdPerMillionOutput: 25,
		});
		// ...while the longer claude-opus-4-1 fragment wins the longest-match
		// rule and keeps the legacy $15/$75 rate.
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.ANTHROPIC, 'claude-opus-4-1'),
		).toEqual({
			kind: 'perToken',
			usdPerMillionAudioInput: 15,
			usdPerMillionTextInput: 15,
			usdPerMillionOutput: 75,
		});
	});

	it('returns null for an LLM model with no built-in rate', () => {
		expect(
			resolveLlmPricing(LLM_PROVIDER_IDS.ANTHROPIC, 'mystery-model'),
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

describe('estimateStepCost: transcription', () => {
	it('estimates a per-minute engine from the duration', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		});
		expect(
			estimateStepCost('transcription', settings, 600).usd,
		).toBeCloseTo(0.043, 10);
	});

	it('estimates a token engine from synthesized token counts', () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.GEMINI,
			geminiModel: 'gemini-2.5-flash',
		});
		// 60s -> 1920 audio tokens at $1/1M plus 480 output tokens at $2.5/1M.
		expect(estimateStepCost('transcription', settings, 60).usd).toBeCloseTo(
			(60 * GEMINI_AUDIO_TOKENS_PER_SECOND) / 1_000_000 +
				(60 * 8 * 2.5) / 1_000_000,
			10,
		);
	});

	it('is free for the local engine and unpriced for unknown models', () => {
		const local = estimateStepCost(
			'transcription',
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
			}),
			600,
		);
		expect(local.usd).toBe(0);
		expect(local.free).toBe(true);

		const unknown = estimateStepCost(
			'transcription',
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
				whisperApiModel: 'mystery',
			}),
			600,
		);
		expect(unknown.usd).toBeNull();
		expect(unknown.reason).toBe('no-rate');
	});

	it('doubles the engine cost when the advanced two-pass mode will run', () => {
		const base = {
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
		};
		const single = estimateStepCost(
			'transcription',
			mergeSettings(base),
			600,
		);
		const twoPass = estimateStepCost(
			'transcription',
			mergeSettings({
				...base,
				transcriptionAdvancedSettingsEnabled: true,
				transcriptionAdvancedEnabled: true,
			}),
			600,
		);
		expect(twoPass.usd).toBeCloseTo((single.usd ?? 0) * 2, 10);
		expect(twoPass.label).toBe('Transcription (2 passes)');
	});

	it('reports the missing duration rather than a wrong number', () => {
		const line = estimateStepCost(
			'transcription',
			mergeSettings({
				transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
				deepgramModel: 'nova-3',
			}),
			null,
		);
		expect(line.usd).toBeNull();
		expect(line.reason).toBe('no-duration');
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

	it.each([
		{ name: 'nothing at all', usages: [] },
		{ name: 'only absent parts', usages: [undefined, undefined] },
		{ name: 'only parts that reported nothing', usages: [{}, {}] },
		{ name: 'a mix of absent and empty', usages: [undefined, {}] },
	])('returns an empty total for $name', ({ usages }) => {
		// The estimate multiplies these; an accidental zero key would show a
		// priced run as free rather than as unknown.
		expect(sumUsage(usages)).toEqual({});
	});

	it('keeps a reported zero, which is not the same as nothing reported', () => {
		// A part that ran and used nothing is a fact worth carrying: the
		// total is then "zero seconds", not "we never asked".
		expect(sumUsage([{ audioSeconds: 0 }])).toEqual({ audioSeconds: 0 });
	});
});

describe('formatUsd', () => {
	it.each([
		{ amount: 0, expected: '$0.00' },
		// Either side of the sub-cent threshold, and the threshold itself:
		// half a cent rounds up to a printable amount, anything under it
		// cannot be printed as cents without reading as free.
		{ amount: 0.001, expected: '<$0.01' },
		{ amount: 0.004999, expected: '<$0.01' },
		{ amount: 0.005, expected: '$0.01' },
		{ amount: 0.043, expected: '$0.04' },
		{ amount: 1.5, expected: '$1.50' },
		{ amount: 1234.567, expected: '$1234.57' },
	])('formats $amount as "$expected"', ({ amount, expected }) => {
		expect(formatUsd(amount)).toBe(expected);
	});

	it('does not render a negative amount as sub-cent', () => {
		// The sub-cent form is about small positive amounts; a bare `< 0.005`
		// test also caught negatives and would have shown -$5.00 as "<$0.01".
		expect(formatUsd(-5)).toBe('$-5.00');
		expect(formatUsd(-0.001)).toBe('$-0.00');
	});
});

describe('estimateStepCost: postProcess', () => {
	it('estimates a cleanup pass from the transcript token size', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
			llmPostProcessTask: 'cleanup',
			llmMaxTokens: 4096,
		});
		// 600s -> 4800 transcript tokens in, cleanup output capped at the 4096
		// token budget. Input at $0.15/M, output at $0.60/M.
		expect(estimateStepCost('postProcess', settings, 600).usd).toBeCloseTo(
			(4800 * 0.15) / 1_000_000 + (4096 * 0.6) / 1_000_000,
			10,
		);
	});

	it('is unpriced for an LLM model with no built-in rate', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'mystery-model',
		});
		const line = estimateStepCost('postProcess', settings, 600);
		expect(line.usd).toBeNull();
		expect(line.reason).toBe('no-rate');
	});
});

describe('estimateStepCost: autoChapters', () => {
	it('sizes the output as a small fraction of the transcript', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			llmOpenAiModel: 'gpt-4o-mini',
			llmMaxTokens: 32000,
		});
		// 600s -> 4800 transcript tokens in, chapters emit a 10% titled list.
		expect(estimateStepCost('autoChapters', settings, 600).usd).toBeCloseTo(
			(4800 * 0.15) / 1_000_000 + (480 * 0.6) / 1_000_000,
			10,
		);
	});

	it('does not move with the unrelated post-processing task', () => {
		const of = (task: 'cleanup' | 'summary' | 'custom'): number | null =>
			estimateStepCost(
				'autoChapters',
				mergeSettings({
					llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
					llmOpenAiModel: 'gpt-4o-mini',
					llmMaxTokens: 32000,
					llmPostProcessTask: task,
				}),
				600,
			).usd;
		expect(of('summary')).toBe(of('cleanup'));
		expect(of('custom')).toBe(of('cleanup'));
	});
});

describe('one step is priced identically wherever it is read', () => {
	// The chapter dialog prices the auto-chapters step on its own while the
	// transcribe dialog prices it as part of the run. Both go through
	// estimateStepCost, so the two numbers can never drift apart again.
	const settings = mergeSettings({
		transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
		llmProvider: LLM_PROVIDER_IDS.GEMINI,
		llmGeminiModel: 'gemini-2.5-flash',
		llmMaxTokens: 32000,
		llmPostProcessTask: 'cleanup',
		transcriptionAutoChaptersEnabled: true,
		transcriptionAutoChaptersOnTranscribe: true,
	});

	it('matches between the standalone step and the run breakdown', () => {
		const standalone = estimateStepCost('autoChapters', settings, 3600);
		const inRun = buildCostEstimate(settings, 3600).lines.find(
			(line) => line.label === 'Auto chapters',
		);
		expect(inRun).toBeDefined();
		expect(inRun?.usd).toBe(standalone.usd);
		expect(inRun?.model).toBe(standalone.model);
		expect(inRun?.providerName).toBe(standalone.providerName);
	});

	it('matches for every step the run performs', () => {
		const full = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			deepgramModel: 'nova-3',
			llmProvider: LLM_PROVIDER_IDS.GEMINI,
			llmGeminiModel: 'gemini-2.5-flash',
			llmPostProcessEnabled: true,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
			transcriptionAutoChaptersEnabled: true,
			transcriptionAutoChaptersOnTranscribe: true,
		});
		const steps: RunCostStepId[] = [
			'transcription',
			'contextAgents',
			'postProcess',
			'autoChapters',
		];
		const lines = buildCostEstimate(full, 1800).lines;
		expect(lines).toHaveLength(steps.length);
		steps.forEach((step, index) => {
			expect(lines[index]?.usd).toBe(
				estimateStepCost(step, full, 1800).usd,
			);
		});
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

describe('pricing one LLM call from what the vendor reported', () => {
	const settings = mergeSettings({
		llmAnthropicModel: 'claude-sonnet-5',
		llmOpenAiModel: 'gpt-4o-mini',
	});

	it('bills the input and output tokens at the model rate', () => {
		// claude-sonnet-5 is $3 per million in, $15 per million out
		expect(
			llmCallCostFromUsage(LLM_PROVIDER_IDS.ANTHROPIC, settings, {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			}),
		).toBeCloseTo(18, 10);
	});

	it('bills an OpenAI reasoning response for its completion total once', () => {
		// gpt-4o-mini is $0.60 per million out. `completion_tokens` already
		// covers the reasoning OpenAI breaks out beneath it, so the charge is
		// for 1_000_000 output tokens and not for the 800_000 of them that the
		// breakdown names a second time.
		expect(
			llmCallCostFromUsage(
				LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				settings,
				extractOpenAiUsage({
					usage: {
						prompt_tokens: 0,
						completion_tokens: 1_000_000,
						completion_tokens_details: {
							reasoning_tokens: 800_000,
						},
					},
				}),
			),
		).toBeCloseTo(0.6, 10);
	});

	it('bills a Gemini thinking response for its candidates and thoughts', () => {
		// gemini-2.5-flash is $2.50 per million out, and Gemini prices a
		// thinking response as the sum of the two counts, so 400_000 candidate
		// plus 600_000 thinking tokens is a million billed at the output rate.
		expect(
			llmCallCostFromUsage(
				LLM_PROVIDER_IDS.GEMINI,
				mergeSettings({ geminiModel: 'gemini-2.5-flash' }),
				extractGeminiUsage({
					usageMetadata: {
						promptTokenCount: 0,
						candidatesTokenCount: 400_000,
						thoughtsTokenCount: 600_000,
					},
				}),
			),
		).toBeCloseTo(2.5, 10);
	});

	it('bills the half a response reported and nothing for the other', () => {
		expect(
			llmCallCostFromUsage(LLM_PROVIDER_IDS.OPENAI_COMPATIBLE, settings, {
				inputTokens: 1_000_000,
			}),
		).toBeCloseTo(0.15, 10);
	});

	it('bills the output alone when only that was reported', () => {
		// A truncated response can report the completion and not the prompt
		expect(
			llmCallCostFromUsage(LLM_PROVIDER_IDS.ANTHROPIC, settings, {
				outputTokens: 1_000_000,
			}),
		).toBeCloseTo(15, 10);
	});

	it('reports no price when the vendor reported no counts at all', () => {
		expect(
			llmCallCostFromUsage(LLM_PROVIDER_IDS.ANTHROPIC, settings, {}),
		).toBeNull();
	});

	it('reports no price for a model with no built-in rate', () => {
		expect(
			llmCallCostFromUsage(
				LLM_PROVIDER_IDS.ANTHROPIC,
				mergeSettings({ llmAnthropicModel: 'claude-from-the-future' }),
				{ inputTokens: 1000, outputTokens: 100 },
			),
		).toBeNull();
	});
});

// One rule for every surface that finishes a transcription. The dialog and the
// queue each carried their own and they disagreed, so the same recording
// reached the session total differently depending on where it was started
// from: the queue counted the free local engine the dialog leaves out, and
// recorded a run the provider gave no usage for as unpriced where the dialog
// fell back to the duration estimate.
describe('what a finished run adds to the session total', () => {
	const settings = mergeSettings({});

	it('records what the provider reported, and calls it no estimate', () => {
		expect(
			runCostToRecord({ engineId: 'deepgram', usd: 0.05 }, settings, 600),
		).toEqual({ usd: 0.05, estimated: false });
	});

	it('falls back to the duration estimate the user was already shown', () => {
		expect(
			runCostToRecord({ engineId: 'deepgram', usd: null }, settings, 600),
		).toEqual({
			usd: estimateStepCost('transcription', settings, 600).usd,
			estimated: true,
		});
	});

	it('records nothing for the free local engine', () => {
		expect(
			runCostToRecord(
				{
					engineId: TRANSCRIPTION_PROVIDER_IDS.LOCAL_WHISPER,
					usd: null,
				},
				settings,
				600,
			),
		).toBeNull();
	});

	it('records nothing while cost estimates are turned off', () => {
		expect(
			runCostToRecord(
				{ engineId: 'deepgram', usd: 0.05 },
				mergeSettings({ transcriptionShowCostEstimates: false }),
				600,
			),
		).toBeNull();
	});
});
