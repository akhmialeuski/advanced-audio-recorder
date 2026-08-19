/**
 * Each LLM-driven job picks its own engine, and this covers the three readers
 * that have to agree on that choice: the factory that builds the provider, the
 * ceiling that bounds its answer, and the cost model that prices the call.
 *
 * Every one of them used to read the post-processing field directly, so a job
 * pointed at another engine was dispatched to the post-processing one and
 * merely bounded and priced against the engine it named - a configuration that
 * looked right and ran somewhere else.
 * @module tests/unit/llmJobEngines.test
 */

import type { TFile } from 'obsidian';
import { AutoChapterService } from 'src/chapters/AutoChapterService';
import { createLlmProvider } from 'src/transcription/factories';
import { LLM_JOBS, estimateStepCost, jobVendorId } from 'src/transcription/api';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import { mergeSettings } from 'src/settings/settingsSerialization';
import { LLM_PROVIDER_IDS } from 'src/constants';
import type {
	AudioRecorderSettings,
	LlmProviderId,
} from 'src/settings/settingsSchema';
import type { RecordingSidecarStore } from 'src/sidecar/RecordingSidecarStore';
import type { Transcript } from 'src/transcription/TranscriptTypes';
import { at } from '../helpers/assertions';
import { partial } from '../helpers/doubles';
import { createMockApp } from '../helpers/createApp';

/** A configuration where every job names a different engine. */
const settingsWithDistinctEngines = (): AudioRecorderSettings =>
	mergeSettings({
		transcriptionEnabled: true,
		llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		chaptersLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
		advancedLlmProvider: LLM_PROVIDER_IDS.GEMINI,
		whisperApiKey: 'openai-key',
		anthropicApiKey: 'anthropic-key',
		geminiApiKey: 'gemini-key',
		llmOpenAiMaxTokens: 1000,
		llmAnthropicMaxTokens: 2000,
		geminiMaxTokens: 3000,
	});

describe('LLM_JOBS', () => {
	it('names the field each job stores its engine in', () => {
		const settings = settingsWithDistinctEngines();

		expect(jobVendorId(settings, 'postProcess')).toBe(
			LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		);
		expect(jobVendorId(settings, 'autoChapters')).toBe(
			LLM_PROVIDER_IDS.ANTHROPIC,
		);
		expect(jobVendorId(settings, 'contextAgents')).toBe(
			LLM_PROVIDER_IDS.GEMINI,
		);
	});

	it('declares the key the settings row binds to, so both read one table', () => {
		const settings = settingsWithDistinctEngines();

		for (const job of Object.values(LLM_JOBS)) {
			expect(settings[job.key]).toBe(job.vendor(settings));
		}
	});
});

describe('createLlmProvider', () => {
	it('builds the engine it is given rather than the post-processing one', () => {
		const settings = settingsWithDistinctEngines();

		expect(
			createLlmProvider(settings, jobVendorId(settings, 'autoChapters'))
				.id,
		).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
		expect(
			createLlmProvider(settings, jobVendorId(settings, 'contextAgents'))
				.id,
		).toBe(LLM_PROVIDER_IDS.GEMINI);
	});

	it('falls back to the post-processing engine when no job is named', () => {
		expect(createLlmProvider(settingsWithDistinctEngines()).id).toBe(
			LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
		);
	});

	it('reports the missing key of the engine the job names', () => {
		const settings = mergeSettings({
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			chaptersLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
			whisperApiKey: 'openai-key',
			anthropicApiKey: '',
		});

		// Not "set the OpenAI key": the run that is about to fail is the one
		// configured to call Anthropic.
		expect(() =>
			createLlmProvider(settings, jobVendorId(settings, 'autoChapters')),
		).toThrow('Set the Anthropic API key in settings.');
	});
});

describe('AutoChapterService engine choice', () => {
	const TRANSCRIPT: Transcript = {
		segments: [
			{ start: 0, end: 30, text: 'intro' },
			{ start: 60, end: 200, text: 'topic' },
		],
		speakers: [],
	};

	const file = { name: 'rec.wav', path: 'rec.wav' } as TFile;

	/**
	 * Runs a generation and reports what the service asked its factory for.
	 * @param settings - The configuration the run reads
	 */
	async function runChapters(settings: AudioRecorderSettings): Promise<{
		vendorIds: LlmProviderId[];
		maxTokens: number[];
	}> {
		const vendorIds: LlmProviderId[] = [];
		const maxTokens: number[] = [];
		const llm: LlmProvider = {
			id: LLM_PROVIDER_IDS.GEMINI,
			label: 'Fake',
			complete: (_prompt, limit): Promise<string> => {
				maxTokens.push(limit);
				return Promise.resolve('0:00 Intro\n1:00 Topic');
			},
		};
		const store = partial<RecordingSidecarStore>({
			read: jest.fn().mockResolvedValue({ markers: [] }),
			write: jest.fn().mockResolvedValue(undefined),
		});
		const service = new AutoChapterService(
			createMockApp({
				vault: { getFiles: () => [] },
				metadataCache: { resolvedLinks: {} },
			}).app,
			() => settings,
			store,
			undefined,
			{
				createLlm: (_settings, vendorId): LlmProvider => {
					vendorIds.push(vendorId);
					return llm;
				},
				probeDuration: () => Promise.resolve(300),
			},
		);
		await service.generate(file, TRANSCRIPT);
		return { vendorIds, maxTokens };
	}

	it('calls the engine the chapters row names', async () => {
		const { vendorIds } = await runChapters(settingsWithDistinctEngines());

		expect(at(vendorIds, 0)).toBe(LLM_PROVIDER_IDS.ANTHROPIC);
	});

	it("bounds the answer by that engine's own ceiling", async () => {
		// The ceiling belongs to the engine that honours it, so a run on
		// Anthropic is bounded by the Anthropic field, not the OpenAI one.
		const { maxTokens } = await runChapters(settingsWithDistinctEngines());

		expect(at(maxTokens, 0)).toBe(2000);
	});
});

describe('cost estimate per job', () => {
	it('prices a step against the engine its job names', () => {
		const settings = settingsWithDistinctEngines();

		expect(
			estimateStepCost('postProcess', settings, 600).providerName,
		).toBe('OpenAI');
		expect(
			estimateStepCost('autoChapters', settings, 600).providerName,
		).toBe('Anthropic (Claude)');
		expect(
			estimateStepCost('contextAgents', settings, 600).providerName,
		).toBe('Google Gemini');
	});

	it('quotes the model of the engine the job names', () => {
		const settings = settingsWithDistinctEngines();
		settings.llmAnthropicModel = 'claude-sonnet-5';

		expect(estimateStepCost('autoChapters', settings, 600).model).toBe(
			'claude-sonnet-5',
		);
	});
});
