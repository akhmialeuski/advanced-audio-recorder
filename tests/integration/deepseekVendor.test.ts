/**
 * DeepSeek as an LLM vendor, driven through the real registries: the settings
 * load, the factory, the OpenAI-compatible client on the wire, and the cost
 * estimate. DeepSeek has no audio endpoint, so the vendor has its own account
 * and a chat catalogue only, and pointing a job at it must leave transcription
 * on whatever account it was on.
 * @module tests/integration/deepseekVendor.test
 */

import {
	DEFAULT_DEEPSEEK_BASE_URL,
	LLM_DEEPSEEK_MODEL_SUGGESTIONS,
	LLM_PROVIDER_IDS,
	TRANSCRIPTION_PROVIDER_IDS,
} from 'src/constants';
import { ENGINES, ENGINE_IDS, EngineLabel } from 'src/providers/providers';
import {
	LLM_PROVIDER_OPTIONS,
	TRANSCRIPTION_PROVIDER_OPTIONS,
} from 'src/settings/labels';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { buildCostEstimate, resolveLlmPricing } from 'src/transcription/costs';
import { createLlmProvider } from 'src/transcription/factories';
import { HttpError } from 'src/transcription/httpClient';
import {
	LLM_JOBS,
	LlmJobId,
	jobLlmVendor,
} from 'src/transcription/llm/vendors';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import { at, jsonBody } from '../helpers/assertions';
import { captureRequests } from '../helpers/network';

const PROMPT: LlmPrompt = { system: 'Clean up.', user: 'uh so we agreed' };

/** What DeepSeek answers an account with no credit left. */
const INSUFFICIENT_BALANCE = JSON.stringify({
	error: {
		message: 'Insufficient Balance',
		type: 'unknown_error',
		param: null,
		code: 'invalid_request_error',
	},
});

describe('DeepSeek LLM vendor', () => {
	it('is offered to every LLM job and to no transcription dropdown', () => {
		expect(LLM_PROVIDER_OPTIONS).toContainEqual({
			value: LLM_PROVIDER_IDS.DEEPSEEK,
			label: EngineLabel.DeepSeek,
		});
		expect(
			TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => option.label),
		).not.toContain(EngineLabel.DeepSeek);
		expect(ENGINES[ENGINE_IDS.DEEPSEEK].transcriptionId).toBeNull();

		// Each job stores its engine under its own key; all three resolve the
		// same descriptor, which is what the factory and the estimate read.
		for (const job of Object.values(LlmJobId)) {
			const settings = mergeSettings({
				[LLM_JOBS[job].key]: LLM_PROVIDER_IDS.DEEPSEEK,
			});
			expect(jobLlmVendor(settings, job).id).toBe(
				LLM_PROVIDER_IDS.DEEPSEEK,
			);
		}
	});

	it('keeps its key apart from the OpenAI account used for transcription', async () => {
		const settings = mergeSettings({
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
			whisperApiKey: 'sk-openai',
			llmProvider: LLM_PROVIDER_IDS.DEEPSEEK,
			deepSeekApiKey: 'sk-deepseek',
		});
		const sent = captureRequests({
			text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
		});

		const completion = await createLlmProvider(settings).complete(
			PROMPT,
			1024,
		);

		expect(completion.text).toBe('ok');
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(
			`${DEFAULT_DEEPSEEK_BASE_URL}/chat/completions`,
		);
		expect(sent[0]?.headers?.Authorization).toBe('Bearer sk-deepseek');
		expect(
			jsonBody<{ model: string; max_tokens: number }>(at(sent, 0)),
		).toMatchObject({ model: 'deepseek-flash', max_tokens: 1024 });
		// Transcription stays on the OpenAI endpoint and key.
		expect(settings.whisperApiKey).toBe('sk-openai');
		expect(settings.whisperApiBaseUrl).toBe('https://api.openai.com/v1');
	});

	it('seeds the current catalogue only and prices every id in it', () => {
		const settings = mergeSettings();
		expect(settings.llmDeepSeekModels).toEqual([
			'deepseek-flash',
			'deepseek-v4-pro',
		]);
		for (const retired of [
			'deepseek-chat',
			'deepseek-reasoner',
			'deepseek-v4-flash',
		]) {
			expect(LLM_DEEPSEEK_MODEL_SUGGESTIONS).not.toContain(retired);
		}
		for (const id of LLM_DEEPSEEK_MODEL_SUGGESTIONS) {
			expect(
				resolveLlmPricing(LLM_PROVIDER_IDS.DEEPSEEK, id),
			).not.toBeNull();
		}
	});

	it('prices the post-processing line from its rate table rather than refusing', () => {
		// deepseek-flash at peak is 0.30/1.20 per million tokens, exactly twice
		// gpt-4o-mini's 0.15/0.60, so with the same transcript and the same
		// answer ceiling the DeepSeek line has to cost twice the OpenAI one.
		const base = {
			transcriptionProvider: TRANSCRIPTION_PROVIDER_IDS.DEEPGRAM,
			llmPostProcessEnabled: true,
		};
		const deepSeek = buildCostEstimate(
			mergeSettings({ ...base, llmProvider: LLM_PROVIDER_IDS.DEEPSEEK }),
			600,
		).lines[1];
		const openAi = buildCostEstimate(
			mergeSettings({
				...base,
				llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
				llmOpenAiModel: 'gpt-4o-mini',
			}),
			600,
		).lines[1];

		expect(deepSeek).toMatchObject({
			providerName: EngineLabel.DeepSeek,
			model: 'deepseek-flash',
			pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
		});
		expect(deepSeek?.usd).not.toBeNull();
		expect(deepSeek?.usd).toBeCloseTo((openAi?.usd ?? 0) * 2, 10);
	});

	it("surfaces the vendor's own error sentence instead of an empty result", async () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.DEEPSEEK,
			deepSeekApiKey: 'sk-deepseek',
		});
		captureRequests({ status: 402, text: INSUFFICIENT_BALANCE });

		const call = createLlmProvider(settings).complete(PROMPT, 1024);

		// A 402 reads as the quota hint, followed by the vendor's own sentence
		// lifted out of its JSON envelope.
		await expect(call).rejects.toThrow(HttpError);
		await expect(call).rejects.toThrow(/^Out of API quota or credit\./);
		await expect(call).rejects.toThrow(
			/status 402: Insufficient Balance\)$/,
		);
	});
});
