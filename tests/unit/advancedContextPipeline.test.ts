/**
 * Tests for the advanced two-pass context pipeline: the pure builders
 * (term-list parsing, fuzzy matching, transcript condensing, fallback prompt
 * assembly) and the generateContext agent orchestration over a scripted LLM
 * provider - Russian fixtures with English acronyms, matching the mode's
 * target use case.
 * @module tests/unit/advancedContextPipeline.test
 */

import {
	CONTEXT_AGENT_TEMPERATURE,
	CONTEXT_SAMPLE_MAX_CHARS,
	ContextGenerationCancelledError,
	JARGON_MATCH_THRESHOLD,
	NAME_MATCH_THRESHOLD,
	buildFallbackPrompt,
	condenseTranscript,
	countFuzzyOccurrences,
	filterHeardTerms,
	generateContext,
	parseTermList,
	sentenceRetainsTerms,
	similarity,
	withinPromptWindow,
} from 'src/transcription/advanced/contextPipeline';
import type {
	LlmCompleteOptions,
	LlmProvider,
} from 'src/transcription/llm/LlmProvider';
import type { LlmPrompt } from 'src/transcription/llmPostProcess';
import { buildTranscript } from 'src/transcription/transcriptModel';
import type { Transcript } from 'src/transcription/TranscriptTypes';

/** One recorded agent call made through the scripted provider. */
interface AgentCall {
	system: string;
	user: string;
	maxTokens: number;
	options?: LlmCompleteOptions;
}

/**
 * Scripted LLM provider: dispatches on a distinctive fragment of each
 * agent's system prompt and records every call. An agent without a scripted
 * reply answers with an empty string; a scripted `Error` reply throws.
 */
function scriptedLlm(replies: Partial<Record<AgentKey, string | Error>>): {
	llm: LlmProvider;
	calls: AgentCall[];
} {
	const calls: AgentCall[] = [];
	const llm: LlmProvider = {
		id: 'scripted',
		label: 'Scripted',
		complete: (
			prompt: LlmPrompt,
			maxTokens: number,
			options?: LlmCompleteOptions,
		): Promise<string> => {
			calls.push({ ...prompt, maxTokens, options });
			const reply = replies[agentKeyOf(prompt.system)];
			if (reply instanceof Error) {
				return Promise.reject(reply);
			}
			return Promise.resolve(reply ?? '');
		},
	};
	return { llm, calls };
}

type AgentKey =
	| 'topic'
	| 'names'
	| 'jargon'
	| 'acronyms'
	| 'decider'
	| 'sentence';

/** Maps a system prompt back to the agent that sent it. */
function agentKeyOf(system: string): AgentKey {
	if (system.includes('domain and topic')) {
		return 'topic';
	}
	if (system.includes('proper names')) {
		return 'names';
	}
	if (system.includes('domain terminology')) {
		return 'jargon';
	}
	if (system.includes('English technical terms')) {
		return 'acronyms';
	}
	if (system.includes('verify candidate terms')) {
		return 'decider';
	}
	return 'sentence';
}

/** Russian meeting draft with garbled English terms and inflected names. */
function russianBaseline(): Transcript {
	return buildTranscript(
		[
			{
				start: 0,
				end: 5,
				text: 'Сегодня обсуждаем деплой в кубернетис и настройку си ай си ди.',
			},
			{
				start: 5,
				end: 10,
				text: 'Иванову нужно сделать ревью пул реквеста.',
			},
			{ start: 10, end: 15, text: 'Петров сказал что стейджинг упал.' },
		],
		{ language: 'ru' },
	);
}

describe('parseTermList', () => {
	it('strips bullets, numbering, and quotes and drops noise lines', () => {
		const parsed = parseTermList(
			[
				'- Kubernetes',
				'2. gRPC',
				'"CI/CD"',
				'kubernetes,',
				'',
				'None',
				'This line is way too long to be a term because it rambles on and on about nothing at all',
			].join('\n'),
		);
		expect(parsed).toEqual(['Kubernetes', 'gRPC', 'CI/CD']);
	});
});

describe('similarity and fuzzy matching', () => {
	it('rates an inflected Russian surname above the name threshold', () => {
		// "Иванову" is the dative of "Иванов": one trailing letter apart.
		expect(similarity('Иванов', 'Иванову')).toBeGreaterThanOrEqual(
			NAME_MATCH_THRESHOLD,
		);
		expect(similarity('Иванов', 'Петрову')).toBeLessThan(
			NAME_MATCH_THRESHOLD,
		);
	});

	it('counts multi-word terms against word windows', () => {
		const words = 'мы обсуждаем пул реквест после ревью'.split(' ');
		expect(
			countFuzzyOccurrences('пул реквест', words, JARGON_MATCH_THRESHOLD),
		).toBe(1);
		expect(
			countFuzzyOccurrences('код фриз', words, JARGON_MATCH_THRESHOLD),
		).toBe(0);
	});

	it('keeps heard terms and drops inventions', () => {
		const words = 'Иванову нужно сделать деплой и ревью'.split(' ');
		expect(
			filterHeardTerms(
				['Иванов', 'Сидоров'],
				words,
				NAME_MATCH_THRESHOLD,
			),
		).toEqual(['Иванов']);
		expect(
			filterHeardTerms(
				['деплой', 'бэклог'],
				words,
				JARGON_MATCH_THRESHOLD,
			),
		).toEqual(['деплой']);
	});
});

describe('condenseTranscript', () => {
	it('returns the whole draft when it fits', () => {
		expect(condenseTranscript(russianBaseline(), 10_000)).toContain(
			'Петров',
		);
	});

	it('samples across the whole timeline within the budget', () => {
		const segments = Array.from({ length: 200 }, (_, i) => ({
			start: i,
			end: i + 1,
			text: `Сегмент номер ${String(i)} с достаточно длинным текстом для выборки.`,
		}));
		const sample = condenseTranscript(buildTranscript(segments), 2000);
		expect(sample.length).toBeLessThanOrEqual(2000);
		const numbers = [...sample.matchAll(/Сегмент номер (\d+)/g)].map(
			(match) => Number(match[1]),
		);
		// Evenly sampled: material from both the first and the last quarter.
		expect(Math.min(...numbers)).toBeLessThan(50);
		expect(Math.max(...numbers)).toBeGreaterThan(150);
	});
});

describe('buildFallbackPrompt', () => {
	it('joins the topic and terms with the most valuable last', () => {
		const prompt = buildFallbackPrompt('Митинг про инфраструктуру', [
			'ревью',
			'Иванов',
			'Kubernetes',
		]);
		expect(prompt).toBe(
			'Митинг про инфраструктуру. ревью, Иванов, Kubernetes.',
		);
		expect(withinPromptWindow(prompt)).toBe(true);
	});

	it('drops least-valuable terms from the front until the window fits', () => {
		const terms = Array.from(
			{ length: 120 },
			(_, i) => `term-number-${String(i)}`,
		);
		const prompt = buildFallbackPrompt('Topic', terms);
		expect(withinPromptWindow(prompt)).toBe(true);
		// The most valuable (last) term always survives the trimming.
		expect(prompt).toContain('term-number-119');
		expect(prompt).not.toContain('term-number-0,');
	});

	it('drops an oversized topic but keeps the valuable terms', () => {
		// A topic that alone overruns the window must not take the mined terms
		// down with it: the names and acronyms are the second pass's real payoff.
		const hugeTopic = Array.from({ length: 80 }, () => 'topic').join(' ');
		expect(withinPromptWindow(`${hugeTopic}.`)).toBe(false);
		const prompt = buildFallbackPrompt(hugeTopic, ['Иванов', 'Kubernetes']);
		expect(withinPromptWindow(prompt)).toBe(true);
		expect(prompt).toContain('Kubernetes');
		expect(prompt).toContain('Иванов');
		expect(prompt).not.toContain('topic');
	});
});

describe('sentenceRetainsTerms', () => {
	it('accepts a sentence carrying every term, case-insensitively', () => {
		expect(
			sentenceRetainsTerms('We deploy kubernetes with CI/CD daily.', [
				'Kubernetes',
				'CI/CD',
			]),
		).toBe(true);
	});

	it('rejects a sentence that dropped or re-spelled a term', () => {
		expect(
			sentenceRetainsTerms('We ship services with pipelines.', [
				'Kubernetes',
			]),
		).toBe(false);
	});

	it('accepts any sentence when there are no terms to retain', () => {
		expect(sentenceRetainsTerms('A topic-only prompt.', [])).toBe(true);
	});
});

describe('generateContext', () => {
	const replies: Partial<Record<AgentKey, string | Error>> = {
		topic: 'Технический митинг о развертывании сервисов.',
		names: 'Иванов\nПетров\nСидоров',
		jargon: 'деплой\nревью\nбэклог',
		acronyms: 'Kubernetes\nCI/CD',
		decider: 'Kubernetes\nCI/CD\ngRPC',
		sentence:
			'Митинг про деплой и ревью, участвуют Иванов и Петров, обсуждаются gRPC, CI/CD и Kubernetes.',
	};

	it('extracts, verifies, and assembles the context from a Russian draft', async () => {
		const { llm, calls } = scriptedLlm(replies);
		const context = await generateContext(russianBaseline(), llm, {
			language: 'ru',
			glossary: ['gRPC', 'Kafka'],
		});

		expect(context).not.toBeNull();
		expect(context?.topic).toBe(
			'Технический митинг о развертывании сервисов.',
		);
		// Сидоров and бэклог are LLM inventions absent from the draft; the
		// code-level fuzzy decider drops them, while the inflected "Иванову"
		// still counts as Иванов.
		expect(context?.names).toEqual(['Иванов', 'Петров']);
		expect(context?.jargon).toEqual(['деплой', 'ревью']);
		// The decider kept gRPC (glossary) but not Kafka.
		expect(context?.acronyms).toEqual(['Kubernetes', 'CI/CD']);
		expect(context?.keyterms).toEqual([
			'Kubernetes',
			'CI/CD',
			'gRPC',
			'Иванов',
			'Петров',
			'деплой',
			'ревью',
		]);
		expect(context?.promptSentence).toBe(replies.sentence);

		// Six sequential agents, every call pinned to temperature 0.
		expect(calls).toHaveLength(6);
		for (const call of calls) {
			expect(call.options?.temperature).toBe(CONTEXT_AGENT_TEMPERATURE);
		}
		// The sentence builder receives the terms in ascending value order,
		// so the most valuable token is listed last.
		const sentenceCall = calls[calls.length - 1];
		expect(sentenceCall?.user.trim().endsWith('Kubernetes')).toBe(true);
	});

	it('keeps unvetted candidates when the decider call itself fails', async () => {
		const { llm } = scriptedLlm({
			...replies,
			decider: new Error('decider down'),
		});
		const context = await generateContext(russianBaseline(), llm, {
			glossary: ['Kafka'],
		});
		// Losing the acronyms would cost more than the over-correction risk
		// the length safeguard bounds, so a failed decider keeps them all.
		expect(context?.acronyms).toEqual(['Kubernetes', 'CI/CD']);
		expect(context?.keyterms).toContain('Kafka');
	});

	it('falls back to the deterministic prompt when the sentence agent fails', async () => {
		const { llm } = scriptedLlm({
			...replies,
			sentence: new Error('sentence down'),
		});
		const context = await generateContext(russianBaseline(), llm, {
			language: 'ru',
		});
		expect(context?.promptSentence).toBe(
			'Технический митинг о развертывании сервисов. ' +
				'ревью, деплой, Петров, Иванов, CI/CD, Kubernetes.',
		);
		expect(withinPromptWindow(context?.promptSentence ?? '')).toBe(true);
	});

	it('rejects an in-window sentence that dropped a mined term', async () => {
		// A fluent, in-window sentence that silently omits Kubernetes, the
		// highest-value acronym the pipeline mined. Accepting it would strip that
		// canonical spelling from the only bias a prompt-biased engine receives.
		const droppedSentence =
			'Митинг про деплой и ревью, участвуют Иванов и Петров.';
		const { llm } = scriptedLlm({ ...replies, sentence: droppedSentence });
		const context = await generateContext(russianBaseline(), llm, {
			language: 'ru',
			glossary: ['gRPC', 'Kafka'],
		});
		expect(context?.keyterms).toContain('Kubernetes');
		// The sentence is discarded for the deterministic assembly, which lists
		// every mined term with its canonical spelling.
		expect(context?.promptSentence).not.toBe(droppedSentence);
		expect(context?.promptSentence.toLowerCase()).toContain('kubernetes');
		expect(withinPromptWindow(context?.promptSentence ?? '')).toBe(true);
	});

	it('stops after the first two agents fail and returns null', async () => {
		const failure = new Error('LLM unreachable');
		const { llm, calls } = scriptedLlm({
			names: failure,
			jargon: failure,
			acronyms: failure,
			topic: failure,
		});
		const context = await generateContext(russianBaseline(), llm);
		expect(context).toBeNull();
		// The names and jargon extractors run first; two consecutive failures
		// abort before any further agent burns a timeout on a dead provider.
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => agentKeyOf(call.system))).toEqual([
			'names',
			'jargon',
		]);
	});

	it('returns null for an empty draft without calling the LLM', async () => {
		const { llm, calls } = scriptedLlm(replies);
		const context = await generateContext(buildTranscript([]), llm);
		expect(context).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('throws the cancellation error when the probe fires', async () => {
		const { llm } = scriptedLlm(replies);
		await expect(
			generateContext(russianBaseline(), llm, {
				isCancelled: () => true,
			}),
		).rejects.toBeInstanceOf(ContextGenerationCancelledError);
	});

	it('bounds the agent input sample for a long draft', async () => {
		const { llm, calls } = scriptedLlm(replies);
		const segments = Array.from({ length: 3000 }, (_, i) => ({
			start: i,
			end: i + 1,
			text: `Очень длинный сегмент номер ${String(i)} про деплой и ревью.`,
		}));
		await generateContext(buildTranscript(segments), llm);
		for (const call of calls) {
			expect(call.user.length).toBeLessThanOrEqual(
				// The decider/sentence users add candidate lines on top of the
				// sample; a small allowance covers them.
				CONTEXT_SAMPLE_MAX_CHARS + 500,
			);
		}
	});

	it('skips the topic and sentence agents when no prompt sentence is needed', async () => {
		// A keyword-biased engine reads only the keyterm list, so the caller
		// asks the pipeline not to build the prompt sentence. The topic and
		// sentence agents, whose only output feeds that sentence, must not run.
		const { llm, calls } = scriptedLlm(replies);
		const context = await generateContext(russianBaseline(), llm, {
			language: 'ru',
			glossary: ['gRPC', 'Kafka'],
			buildPromptSentence: false,
		});

		expect(context).not.toBeNull();
		// The keyterms are mined and vetted exactly as on the prompt path.
		expect(context?.keyterms).toEqual([
			'Kubernetes',
			'CI/CD',
			'gRPC',
			'Иванов',
			'Петров',
			'деплой',
			'ревью',
		]);
		// The prompt-only outputs are empty and their agents never ran: four
		// calls (names, jargon, acronyms, decider), not six.
		expect(context?.topic).toBe('');
		expect(context?.promptSentence).toBe('');
		expect(calls.map((call) => agentKeyOf(call.system))).toEqual([
			'names',
			'jargon',
			'acronyms',
			'decider',
		]);
	});

	it('accepts a sentence covering the window-fitting terms when the full list overflows', async () => {
		// Twenty-five short terms whose ascending list overruns the ~224-byte
		// Whisper prompt window, so only its high-value suffix can reach the
		// engine and the rest are trimmed.
		const terms = Array.from(
			{ length: 25 },
			(_, i) => `kterm${String(i).padStart(2, '0')}`,
		);
		const topic = 'Технический митинг.';
		// The terms the fallback keeps are exactly the window-fitting suffix.
		const termsAscending = [...terms].reverse();
		const fitting = terms.filter((term) =>
			buildFallbackPrompt(topic, termsAscending).includes(term),
		);
		// The list genuinely overflows: some terms fit, some are trimmed.
		expect(fitting.length).toBeGreaterThan(0);
		expect(fitting.length).toBeLessThan(terms.length);
		// A natural sentence carrying only the fitting terms (space-joined so it
		// stays within the window), distinct from the comma-joined fallback.
		const sentence = `${topic} ${fitting.join(' ')}.`;
		expect(withinPromptWindow(sentence)).toBe(true);

		const { llm } = scriptedLlm({
			topic,
			names: '',
			jargon: '',
			acronyms: terms.join('\n'),
			decider: terms.join('\n'),
			sentence,
		});
		const context = await generateContext(russianBaseline(), llm, {
			language: 'ru',
		});
		// The sentence retains every term that could reach the engine, so it is
		// adopted as-is; checking retention against the full (overflowing) list
		// would have wrongly rejected it for the terms the window dropped anyway.
		expect(context?.promptSentence).toBe(sentence);
	});
});
