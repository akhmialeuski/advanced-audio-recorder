/**
 * Tests for the advanced two-pass orchestration in TranscriptionService: the
 * mode is inert when off (single pass, no LLM calls), a biased second pass
 * runs with the language pinned to the first pass's detection and its
 * transcript is adopted, the length safeguard and any context/second-pass
 * failure revert to the first pass, Deepgram gets keyterms instead of a
 * prompt sentence, and a non-biasing model degrades to a single pass before
 * any LLM spend. Providers and the LLM are injected fakes; audio preparation
 * is mocked to a single part.
 * @module tests/unit/transcriptionServiceAdvanced.test
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { TranscriptionService } from 'src/transcription/TranscriptionService';
import type {
	TranscribeOptions,
	TranscriptionProvider,
} from 'src/transcription/providers/TranscriptionProvider';
import { WHISPER_API_CAPABILITIES } from 'src/transcription/providers/capabilities';
import { prepareAudio } from 'src/transcription/audioPrep';
import type { LlmProvider } from 'src/transcription/llm/LlmProvider';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import type { TranscriptSegment } from 'src/transcription/TranscriptTypes';
import { mergeSettings } from 'src/settings/settingsSerialization';
import type { AudioRecorderSettingsInput } from 'src/settings/settingsSchema';
import {
	LLM_PROVIDER_IDS,
	TRANSCRIBE_CHUNK_PROGRESS_CEILING,
	TRANSCRIPTION_PROVIDER_IDS,
} from 'src/constants';
import type { TranscriptionProviderId } from 'src/settings/settingsSchema';

// Replace audio preparation so the test drives the part count directly without
// decoding real audio (the Web Audio path is unavailable under jsdom).
jest.mock('src/transcription/audioPrep', () => ({
	prepareAudio: jest.fn(),
	audioMimeFromExtension: jest.fn(() => 'audio/webm'),
	audioPrepOptions: jest.fn(() => ({})),
}));

const mockPrepareAudio = prepareAudio as jest.Mock;
const mockNotice = Notice as unknown as jest.Mock;

const audioFile = {
	name: 'rec.webm',
	extension: 'webm',
	path: 'rec.webm',
} as unknown as TFile;

/** Minimal App with just the surface the transcription pipeline touches. */
function makeApp(): App {
	return {
		vault: {
			readBinary: jest.fn(async () => new ArrayBuffer(4)),
		},
		fileManager: {
			generateMarkdownLink: jest.fn(() => '[[rec#t=0|0:00]]'),
		},
	} as unknown as App;
}

/** One prepared part whose bytes can be materialized once per pass. */
function prepareOnePart(): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [
			{
				contentType: 'audio/wav',
				filename: 'audio.wav',
				offsetSeconds: 0,
				createData: () => new ArrayBuffer(4),
			},
		],
		diarizationSplitWarning: false,
	});
}

/** Two prepared parts, so the chunk progress band is split across them. */
function prepareTwoParts(): void {
	mockPrepareAudio.mockResolvedValue({
		payloads: [0, 5].map((offsetSeconds) => ({
			contentType: 'audio/wav',
			filename: `audio-${String(offsetSeconds)}.wav`,
			offsetSeconds,
			createData: () => new ArrayBuffer(4),
		})),
		diarizationSplitWarning: false,
	});
}

/** Russian draft with a garbled English term and an inflected name. */
const PASS1_SEGMENTS: TranscriptSegment[] = [
	{
		start: 0,
		end: 5,
		text: 'Поручим Иванову деплой сервиса в кубернетис.',
	},
];

/** The biased second pass renders the term canonically. */
const PASS2_SEGMENTS: TranscriptSegment[] = [
	{
		start: 0,
		end: 5,
		text: 'Поручим Иванову деплой сервиса в Kubernetes.',
	},
];

/**
 * Fake provider that records each call's options and answers the biased
 * (second) pass with the canonical-spelling transcript.
 */
function makeProvider(
	id: TranscriptionProviderId = TRANSCRIPTION_PROVIDER_IDS.WHISPER_API,
	secondPassSegments: TranscriptSegment[] = PASS2_SEGMENTS,
): { provider: TranscriptionProvider; calls: TranscribeOptions[] } {
	const calls: TranscribeOptions[] = [];
	const provider: TranscriptionProvider = {
		id,
		label: 'Fake engine',
		requiresNetwork: false,
		capabilities: WHISPER_API_CAPABILITIES,
		transcribe: (_payload, options) => {
			calls.push(options);
			const biased = Boolean(
				options.biasPrompt ?? options.keyterms?.length,
			);
			return Promise.resolve({
				language: 'ru',
				segments: biased ? secondPassSegments : PASS1_SEGMENTS,
			});
		},
	};
	return { provider, calls };
}

/** Scripted context agents keyed by a fragment of their system prompt. */
const AGENT_REPLIES: [string, string][] = [
	['domain and topic', 'Митинг про инфраструктуру.'],
	['proper names', 'Иванов'],
	['domain terminology', 'деплой'],
	['English technical terms', 'Kubernetes'],
	['verify candidate terms', 'Kubernetes'],
	[
		'context prompt',
		'Обсуждение инфраструктуры: деплой, Иванов, Kubernetes.',
	],
];

/** Fake LLM that answers the scripted agents and records each call. */
function makeLlm(): { llm: LlmProvider; calls: LlmPrompt[] } {
	const calls: LlmPrompt[] = [];
	const llm: LlmProvider = {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Fake LLM',
		complete: (prompt: LlmPrompt): Promise<string> => {
			calls.push(prompt);
			const match = AGENT_REPLIES.find(([fragment]) =>
				prompt.system.includes(fragment),
			);
			return Promise.resolve(match?.[1] ?? '');
		},
	};
	return { llm, calls };
}

/** A fake LLM whose every call fails (unreachable endpoint, bad key). */
function makeDeadLlm(): LlmProvider {
	return {
		id: LLM_PROVIDER_IDS.GEMINI,
		label: 'Dead LLM',
		complete: () => Promise.reject(new Error('LLM unreachable')),
	};
}

function makeService(
	provider: TranscriptionProvider,
	llm: LlmProvider,
	settingsInput: AudioRecorderSettingsInput,
): TranscriptionService {
	const settings = mergeSettings({
		transcriptionEnabled: true,
		// These suites exercise the advanced behavior, so the master switch is
		// on by default; individual tests still gate the two-pass sub-toggle.
		transcriptionAdvancedSettingsEnabled: true,
		...settingsInput,
	});
	return new TranscriptionService(makeApp(), () => settings, {
		createProvider: () => provider,
		createLlm: () => llm,
	});
}

beforeEach(() => {
	prepareOnePart();
});

describe('TranscriptionService advanced two-pass mode', () => {
	it('runs a single pass with no LLM calls when the mode is off', async () => {
		const { provider, calls } = makeProvider();
		const { llm, calls: llmCalls } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: false,
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		expect(calls).toHaveLength(1);
		expect(llmCalls).toHaveLength(0);
		expect(result.markdown).toContain('кубернетис');
	});

	it('re-transcribes with the bias and the first pass language, and adopts the result', async () => {
		const { provider, calls } = makeProvider();
		const { llm, calls: llmCalls } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		expect(calls).toHaveLength(2);
		const secondPass = calls[1];
		expect(secondPass?.biasPrompt).toContain('Kubernetes');
		// The language was auto on the first pass; the second pins the
		// detected language so an English-heavy bias cannot flip the
		// transcript's language.
		expect(calls[0]?.language).toBeUndefined();
		expect(secondPass?.language).toBe('ru');
		// Six context agents ran on the configured LLM.
		expect(llmCalls).toHaveLength(6);
		// The adopted transcript renders the canonical spelling.
		expect(result.markdown).toContain('Kubernetes');
		expect(result.markdown).not.toContain('кубернетис');
	});

	it('runs the context agents on the engine the two-pass row names', async () => {
		// The agents pick their own engine, which the run has to dispatch to:
		// reading the post-processing field instead sent them to whichever
		// service was configured for a different job entirely.
		const { provider } = makeProvider();
		const { llm } = makeLlm();
		const vendorIds: string[] = [];
		const settings = mergeSettings({
			transcriptionEnabled: true,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
			llmProvider: LLM_PROVIDER_IDS.OPENAI_COMPATIBLE,
			advancedLlmProvider: LLM_PROVIDER_IDS.ANTHROPIC,
		});
		const service = new TranscriptionService(makeApp(), () => settings, {
			createProvider: () => provider,
			createLlm: (_settings, vendorId): LlmProvider => {
				vendorIds.push(vendorId);
				return llm;
			},
		});

		await service.run(audioFile, { notePathForLinks: 'note.md' });

		expect(vendorIds).toEqual([LLM_PROVIDER_IDS.ANTHROPIC]);
	});

	it('reverts to the first pass when the second comes back too short', async () => {
		const { provider, calls } = makeProvider('whisper-api', [
			{ start: 0, end: 5, text: 'Коротко.' },
		]);
		const { llm } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		expect(calls).toHaveLength(2);
		expect(result.markdown).toContain('кубернетис');
		expect(result.markdown).not.toContain('Коротко');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('too short'),
		);
	});

	it('sends keyterms instead of a prompt sentence on Deepgram, skipping the prompt-only agents', async () => {
		const { provider, calls } = makeProvider('deepgram');
		const { llm, calls: llmCalls } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
			transcriptionProvider: 'deepgram',
			deepgramModel: 'nova-3',
		});

		await service.run(audioFile, { notePathForLinks: 'note.md' });

		expect(calls).toHaveLength(2);
		expect(calls[1]?.biasPrompt).toBeUndefined();
		expect(calls[1]?.keyterms).toEqual(['Kubernetes', 'Иванов', 'деплой']);
		// A keyword-biased engine reads only the keyterm list, so the topic and
		// sentence agents that build the prompt sentence are skipped: four LLM
		// calls (names, jargon, acronyms, decider), not six.
		expect(llmCalls).toHaveLength(4);
		const systems = llmCalls.map((call) => call.system);
		expect(systems.some((s) => s.includes('domain and topic'))).toBe(false);
		expect(systems.some((s) => s.includes('context prompt'))).toBe(false);
	});

	it('degrades to a single pass, before any LLM spend, on a non-biasing model', async () => {
		const { provider, calls } = makeProvider('deepgram');
		const { llm, calls: llmCalls } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
			transcriptionProvider: 'deepgram',
			// Deepgram's hosted Whisper models accept no biasing at all.
			deepgramModel: 'whisper',
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		expect(calls).toHaveLength(1);
		expect(llmCalls).toHaveLength(0);
		expect(result.markdown).toContain('кубернетис');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('skipped'),
		);
	});

	it('keeps the whole progress band for the single pass a non-biasing engine degrades to', async () => {
		// Two-pass is toggled on, but the engine cannot bias, so only one pass
		// runs. The chunk progress band must not be halved for a second pass
		// that never comes: with two parts the second is reported at half the
		// full ceiling, not a quarter (which a wrongly-split band would give).
		prepareTwoParts();
		const { provider } = makeProvider('deepgram');
		const { llm } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
			transcriptionProvider: 'deepgram',
			deepgramModel: 'whisper',
		});

		const progress: { pct: number; label: string }[] = [];
		await service.run(audioFile, {
			notePathForLinks: 'note.md',
			onProgress: (pct, label) => progress.push({ pct, label }),
		});

		const transcribing = progress.filter((entry) =>
			entry.label.startsWith('Transcribing'),
		);
		const maxTranscribing = Math.max(
			...transcribing.map((entry) => entry.pct),
		);
		expect(maxTranscribing).toBeCloseTo(
			TRANSCRIBE_CHUNK_PROGRESS_CEILING / 2,
			5,
		);
	});

	it('keeps the first pass when every context agent fails', async () => {
		const { provider, calls } = makeProvider();
		const service = makeService(provider, makeDeadLlm(), {
			transcriptionAdvancedEnabled: true,
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		// The pipeline found nothing to bias, so no second pass ran and the
		// completed transcript survived.
		expect(calls).toHaveLength(1);
		expect(result.markdown).toContain('кубернетис');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('no usable context'),
		);
	});

	it("reuses the run's Dictionary terms as advanced context candidates", async () => {
		const { provider } = makeProvider();
		const { llm, calls: llmCalls } = makeLlm();
		const service = makeService(provider, llm, {
			transcriptionAdvancedEnabled: true,
			transcriptionDictionaryProfiles: [
				{ id: 'p1', name: 'Infra', terms: 'gRPC' },
			],
			transcriptionDictionaryProfileId: 'p1',
		});

		await service.run(audioFile, { notePathForLinks: 'note.md' });

		// The selected Dictionary term is fed to the pipeline's decider agent as
		// a candidate, proving the advanced mode reuses the same terms the single
		// pass biases toward instead of a separate, removed glossary.
		const deciderCall = llmCalls.find((call) =>
			call.system.includes('verify candidate terms'),
		);
		expect(deciderCall?.user).toContain('gRPC');
	});

	it('keeps the first pass when a broken LLM factory throws', async () => {
		const { provider, calls } = makeProvider();
		const settings = mergeSettings({
			transcriptionEnabled: true,
			transcriptionAdvancedSettingsEnabled: true,
			transcriptionAdvancedEnabled: true,
		});
		const service = new TranscriptionService(makeApp(), () => settings, {
			createProvider: () => provider,
			createLlm: () => {
				throw new Error('LLM not configured');
			},
		});

		const result = await service.run(audioFile, {
			notePathForLinks: 'note.md',
		});

		expect(calls).toHaveLength(1);
		expect(result.markdown).toContain('кубернетис');
		expect(mockNotice).toHaveBeenCalledWith(
			expect.stringContaining('failed'),
		);
	});
});
