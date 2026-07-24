/**
 * LLM-driven context generation for the advanced two-pass transcription mode
 * (the "Whisper: Courtside Edition" method, arXiv:2602.18966). A team of
 * sequential LLM agents mines the first (draft) pass's transcript for the
 * recording's domain context - topic, proper names, domain jargon, and
 * English technical terms/acronyms spoken inside another language - and
 * assembles it into a compact decoding bias for the second pass: one natural
 * sentence in the audio's language with the most valuable tokens last (for
 * prompt-biased engines) and a flat keyterm list (for keyword-biased
 * engines). The LLM never edits transcript text; it only produces a prior,
 * and the final text is still decoded from the audio.
 *
 * Over-correction - biasing toward words that were never spoken - is the
 * method's main failure mode, so candidates are filtered twice: names and
 * jargon must fuzzy-match the draft transcript in code (they are in the
 * audio's language and should appear near-verbatim, allowing for
 * inflection), while English acronyms and user glossary terms - whose whole
 * point is that the draft garbled them ("кубернетис" for "Kubernetes") - are
 * vetted by a decider agent that judges from the draft whether each was
 * plausibly spoken.
 *
 * Every stage is best-effort: a failed agent call degrades that stage rather
 * than failing the pipeline, and the caller treats a null result as "nothing
 * to bias" and keeps the single-pass transcript.
 * @module transcription/advanced/contextPipeline
 */

import { PLUGIN_LOG_PREFIX } from '../../constants';
import { dedupeTerms } from '../dictionary';
import { WHISPER_PROMPT_TOKEN_LIMIT, tokenUpperBound } from '../dictionaryBias';
import type { LlmProvider } from '../llm/LlmProvider';
import { plainText } from '../transcriptModel';
import type { Transcript } from '../TranscriptTypes';

/**
 * Minimum similarity for a proper name to count as heard in the draft.
 * Names in the prompt are normalized to their base form while the draft may
 * hold inflected forms ("Иванову" for "Иванов"), so the threshold leaves
 * room for case endings while still rejecting inventions.
 */
export const NAME_MATCH_THRESHOLD = 0.85;

/**
 * Minimum similarity for a domain term to count as heard in the draft.
 * Stricter than names: jargon is drawn from a much larger vocabulary, so a
 * looser match would let the LLM smuggle in plausible-but-unspoken terms.
 */
export const JARGON_MATCH_THRESHOLD = 0.9;

/**
 * Upper bound on the draft-transcript characters fed to each agent. A long
 * meeting is sampled evenly across its whole timeline instead of truncated,
 * so context from the end of the recording still reaches the agents without
 * overflowing the LLM input.
 */
export const CONTEXT_SAMPLE_MAX_CHARS = 12000;

/** Output-token budget for the list-producing agents. */
export const CONTEXT_LIST_MAX_TOKENS = 512;

/** Output-token budget for the one-sentence topic agent. */
export const CONTEXT_TOPIC_MAX_TOKENS = 128;

/** Output-token budget for the sentence-builder agent. */
export const CONTEXT_SENTENCE_MAX_TOKENS = 300;

/**
 * Cap on the terms kept per category after filtering. The prompt window and
 * the provider keyterm limits bound the final output anyway; this only stops
 * a runaway list from a misbehaving model from dominating the pipeline.
 */
export const CONTEXT_MAX_TERMS_PER_CATEGORY = 25;

/**
 * Longest candidate line accepted from a list agent. Anything longer is not
 * a term but leaked prose (a refusal, an explanation), so it is dropped.
 */
const MAX_TERM_CHARS = 80;

/**
 * Sampling temperature for every agent call: the same recording should
 * produce the same context (and therefore the same second pass) on every run.
 */
export const CONTEXT_AGENT_TEMPERATURE = 0;

/**
 * Lines that mean "found nothing" rather than being a term themselves
 * (including a bare dash or en/em dash a model may answer with).
 */
const EMPTY_ANSWER_PATTERN =
	/^(none|nothing|empty|n\/a|нет|ничего|-|\u2013|\u2014)\.?$/i;

/** The context mined from the first pass, ready to bias the second. */
export interface GeneratedContext {
	/** One-sentence topic/domain description in the audio's language. */
	topic: string;
	/** Proper names heard in the recording, in base (nominative) form. */
	names: string[];
	/** Domain terms in the audio's language, verified against the draft. */
	jargon: string[];
	/**
	 * English technical terms and acronyms plausibly spoken (possibly
	 * transliterated in the draft), in canonical English spelling.
	 */
	acronyms: string[];
	/**
	 * The decoding-bias sentence: one natural sentence in the audio's
	 * language, most valuable tokens last, within the Whisper prompt window.
	 */
	promptSentence: string;
	/**
	 * Flat term list for keyword-biased engines (Deepgram keyterm), most
	 * valuable first so a trimming request limit drops the least valuable.
	 */
	keyterms: string[];
}

/** Options for {@link generateContext}. */
export interface ContextPipelineOptions {
	/** Language detected on the first pass (ISO code), when known. */
	language?: string;
	/**
	 * User-curated glossary terms: the run's selected Dictionary profile, the
	 * same terms the single pass biases toward. Candidates like any other, so
	 * the decider drops the ones the draft gives no evidence for and an
	 * off-topic term cannot be injected into a recording that never mentions it.
	 */
	glossary?: string[];
	/** Cancellation probe checked before each agent call. */
	isCancelled?: () => boolean;
}

/** Raised when the caller's cancellation probe fires between agent calls. */
export class ContextGenerationCancelledError extends Error {
	constructor() {
		super('Context generation cancelled');
		this.name = 'ContextGenerationCancelledError';
	}
}

/**
 * Parses a list-agent reply into clean terms: one term per line, with
 * bullets, numbering, quotes, and trailing separators stripped; blank lines,
 * "none"-style answers, over-long prose lines, and case-insensitive
 * duplicates dropped.
 * @param raw - The agent's raw text reply
 * @returns Clean terms in reply order
 */
export function parseTermList(raw: string): string[] {
	const terms: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		let term = line.trim();
		// Leading list markers: "-", "*", "•", "1.", "1)", "(1)".
		term = term.replace(/^[-*•]+\s*/, '').replace(/^\(?\d+[.)]\s*/, '');
		// Wrapping quotes or backticks around the whole term.
		term = term.replace(/^["'`«]+/, '').replace(/["'`»]+$/, '');
		// Trailing list separators.
		term = term.replace(/[,;]+$/, '').trim();
		if (!term || term.length > MAX_TERM_CHARS) {
			continue;
		}
		if (EMPTY_ANSWER_PATTERN.test(term)) {
			continue;
		}
		terms.push(term);
	}
	return dedupeTerms(terms);
}

/**
 * Normalized Levenshtein similarity in [0, 1], case-insensitive: 1 for equal
 * strings, 0 for nothing in common. Cheap two-row dynamic programming, ample
 * for term-sized inputs.
 * @param a - First string
 * @param b - Second string
 * @returns Similarity ratio
 */
export function similarity(a: string, b: string): number {
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	if (left === right) {
		return 1;
	}
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) {
		return 1;
	}
	let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return 1 - (previous[right.length] ?? 0) / maxLength;
}

/** Splits text into word tokens (Unicode letters/digits, inner ' . / -). */
function tokenizeWords(text: string): string[] {
	return text.match(/[\p{L}\p{N}]+(?:['./-][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * How many places in the text fuzzy-match the term at or above the
 * threshold. A term of N words is compared against every N-word window, so a
 * multi-word name counts as often as a single word. Used both to verify a
 * term was heard (count > 0) and to rank terms by how often they came up.
 * @param term - Candidate term
 * @param textWords - Tokenized draft-transcript words
 * @param threshold - Minimum similarity for a window to count
 * @returns Number of matching windows
 */
export function countFuzzyOccurrences(
	term: string,
	textWords: readonly string[],
	threshold: number,
): number {
	const termWords = tokenizeWords(term);
	if (termWords.length === 0) {
		return 0;
	}
	const joined = termWords.join(' ');
	let count = 0;
	for (let i = 0; i + termWords.length <= textWords.length; i++) {
		const window = textWords.slice(i, i + termWords.length).join(' ');
		if (similarity(joined, window) >= threshold) {
			count++;
		}
	}
	return count;
}

/**
 * Keeps the terms that fuzzy-match the draft transcript, dropping what the
 * LLM listed but the recording gives no evidence for - the code-level
 * decider against the over-correction failure mode. Terms are capped at
 * {@link CONTEXT_MAX_TERMS_PER_CATEGORY}, most frequent first.
 * @param terms - Candidate terms from a list agent
 * @param textWords - Tokenized draft-transcript words
 * @param threshold - Minimum similarity for a term to count as heard
 * @returns Verified terms, most frequent first
 */
export function filterHeardTerms(
	terms: readonly string[],
	textWords: readonly string[],
	threshold: number,
): string[] {
	return terms
		.map((term) => ({
			term,
			count: countFuzzyOccurrences(term, textWords, threshold),
		}))
		.filter((entry) => entry.count > 0)
		.sort((a, b) => b.count - a.count)
		.slice(0, CONTEXT_MAX_TERMS_PER_CATEGORY)
		.map((entry) => entry.term);
}

/**
 * Evenly samples a transcript's segments into at most `maxChars` characters
 * of draft text, so a long meeting contributes context from its whole
 * timeline instead of only its beginning.
 * @param transcript - The first pass's transcript
 * @param maxChars - Upper bound on the sampled characters
 * @returns Newline-joined sampled segment texts
 */
export function condenseTranscript(
	transcript: Transcript,
	maxChars: number,
): string {
	const texts = transcript.segments
		.map((segment) => segment.text.trim())
		.filter((text) => text.length > 0);
	const total = texts.reduce((sum, text) => sum + text.length + 1, 0);
	if (total <= maxChars) {
		return texts.join('\n');
	}
	const keepRatio = maxChars / total;
	const kept: string[] = [];
	let budget = maxChars;
	let accumulator = 0;
	for (const text of texts) {
		accumulator += keepRatio;
		if (accumulator < 1) {
			continue;
		}
		accumulator -= 1;
		if (text.length + 1 > budget) {
			continue;
		}
		kept.push(text);
		budget -= text.length + 1;
	}
	return kept.join('\n');
}

/**
 * Whether a bias sentence fits the Whisper prompt window, measured with the
 * same safe token upper bound the dictionary path uses.
 * @param sentence - Candidate bias sentence
 * @returns True when the sentence is within the window
 */
export function withinPromptWindow(sentence: string): boolean {
	return tokenUpperBound(sentence) <= WHISPER_PROMPT_TOKEN_LIMIT;
}

/**
 * Deterministic bias-prompt assembly used when the sentence agent fails or
 * overruns the prompt window: the topic sentence followed by the terms in
 * ascending value order, so the most valuable tokens sit at the end where
 * Whisper weights them most. Terms are dropped from the least-valuable front
 * until the result fits the window.
 * @param topic - Topic sentence in the audio's language ('' for none)
 * @param termsAscending - Terms in ascending order of value
 * @returns A prompt within the window, or '' when nothing fits
 */
export function buildFallbackPrompt(
	topic: string,
	termsAscending: readonly string[],
): string {
	for (let start = 0; start <= termsAscending.length; start++) {
		const terms = termsAscending.slice(start);
		const parts: string[] = [];
		if (topic) {
			parts.push(topic.endsWith('.') ? topic : `${topic}.`);
		}
		if (terms.length) {
			parts.push(`${terms.join(', ')}.`);
		}
		const prompt = parts.join(' ').trim();
		if (!prompt) {
			return '';
		}
		if (withinPromptWindow(prompt)) {
			return prompt;
		}
		if (terms.length === 0) {
			// Even the topic alone overruns; no usable prompt.
			return '';
		}
	}
	return '';
}

/** Collapses an agent reply to one clean line (first non-empty line). */
function firstLine(raw: string): string {
	for (const line of raw.split(/\r?\n/)) {
		const cleaned = line
			.trim()
			.replace(/^["'`«]+/, '')
			.replace(/["'`»]+$/, '')
			.trim();
		if (cleaned) {
			return cleaned;
		}
	}
	return '';
}

/** Keeps the candidates the decider echoed, preserving candidate spelling. */
function intersectTerms(
	candidates: readonly string[],
	decided: readonly string[],
): string[] {
	const kept = new Set(decided.map((term) => term.toLowerCase()));
	return candidates.filter((term) => kept.has(term.toLowerCase()));
}

/** Human clause naming the output language for the agent prompts. */
function languageClause(language?: string): string {
	return language
		? `the transcript's language (language code "${language}")`
		: "the transcript's language";
}

const TOPIC_SYSTEM =
	'You analyze a raw, error-prone speech-to-text transcript of a meeting. ' +
	'Reply with exactly one short sentence describing the domain and topic ' +
	'of the conversation - no preamble, no quotes. Write the sentence in ';

const NAMES_SYSTEM =
	'You extract proper names from a raw speech-to-text transcript that may ' +
	'contain recognition errors. List the person, company, team, and product ' +
	'names actually referred to in the transcript, one per line, each in its ' +
	'base dictionary (nominative) form in the language it was spoken. Do not ' +
	'invent names, do not include generic words, and do not add any other ' +
	'text. If there are none, reply with an empty message.';

const JARGON_SYSTEM =
	'You extract professional domain terminology from a raw speech-to-text ' +
	'transcript that may contain recognition errors. List the specialized ' +
	'domain terms that actually occur in the transcript, one per line, each ' +
	'in its base dictionary form in the language it was spoken. Exclude ' +
	'everyday words, exclude English acronyms (they are collected ' +
	'separately), do not invent terms, and do not add any other text. If ' +
	'there are none, reply with an empty message.';

const ACRONYMS_SYSTEM =
	'You recover English technical terms, product names, and acronyms from a ' +
	'raw speech-to-text transcript of a meeting that may be held in another ' +
	'language. The recognizer often garbles them - e.g. "кубернетис" for ' +
	'"Kubernetes" or "си ай си ди" for "CI/CD". List each English term or ' +
	'acronym that was plausibly spoken in the recording, one per line, in ' +
	'its canonical English spelling. Only include terms the transcript gives ' +
	'evidence for; do not add any other text. If there are none, reply with ' +
	'an empty message.';

const DECIDER_SYSTEM =
	'You verify candidate terms against a raw speech-to-text transcript. ' +
	'Keep a candidate only if the transcript gives evidence it was actually ' +
	'spoken - verbatim, inflected, or garbled/transliterated by the ' +
	'recognizer. Drop every candidate the transcript gives no evidence for. ' +
	'Reply with the kept candidates only, one per line, spelled exactly as ' +
	'given, with no other text.';

const SENTENCE_SYSTEM_PREFIX =
	'You write one natural sentence that will be used as a speech ' +
	"recognizer's context prompt. Write the sentence in ";

const SENTENCE_SYSTEM_SUFFIX =
	'. Describe the topic and weave in all the given terms spelled exactly ' +
	'as provided, keeping English terms and acronyms in their canonical ' +
	'English spelling. The terms are listed in ascending order of ' +
	'importance; place the later (more important) ones toward the end of ' +
	'the sentence. Reply with the sentence only - no preamble, no quotes.';

/**
 * Runs the multi-agent context pipeline over the first pass's transcript:
 * topic, name, jargon, and acronym extraction, code-level and LLM deciders
 * against over-correction, and assembly of the bias sentence and keyterm
 * list. Sequential LLM calls: 5 (no candidates for the decider) to 6, each
 * pinned to temperature 0.
 *
 * Best-effort by construction: a failed agent degrades its own stage, and a
 * pipeline that finds nothing to bias returns null so the caller keeps the
 * single-pass transcript. Only cancellation escapes as an error
 * ({@link ContextGenerationCancelledError}).
 * @param baseline - The first (draft) pass's transcript
 * @param llm - The configured LLM provider the agents run on
 * @param options - Language, glossary, and cancellation options
 * @returns The generated context, or null when there is nothing to bias
 */
export async function generateContext(
	baseline: Transcript,
	llm: LlmProvider,
	options: ContextPipelineOptions = {},
): Promise<GeneratedContext | null> {
	const sample = condenseTranscript(baseline, CONTEXT_SAMPLE_MAX_CHARS);
	if (!sample.trim()) {
		return null;
	}
	const throwIfCancelled = (): void => {
		if (options.isCancelled?.()) {
			throw new ContextGenerationCancelledError();
		}
	};
	/**
	 * One best-effort agent call: null means the call itself failed (so the
	 * stage can distinguish "errored" from "found nothing" and degrade
	 * accordingly), while cancellation always escapes.
	 */
	const agent = async (
		label: string,
		system: string,
		user: string,
		maxTokens: number,
	): Promise<string | null> => {
		throwIfCancelled();
		try {
			return await llm.complete({ system, user }, maxTokens, {
				temperature: CONTEXT_AGENT_TEMPERATURE,
			});
		} catch (error) {
			console.warn(
				`${PLUGIN_LOG_PREFIX} Advanced context agent "${label}" failed; continuing without it.`,
				error,
			);
			return null;
		}
	};

	const topicRaw = await agent(
		'topic',
		TOPIC_SYSTEM + languageClause(options.language) + '.',
		sample,
		CONTEXT_TOPIC_MAX_TOKENS,
	);
	const namesRaw = await agent(
		'names',
		NAMES_SYSTEM,
		sample,
		CONTEXT_LIST_MAX_TOKENS,
	);
	if (topicRaw === null && namesRaw === null) {
		// Two consecutive failures mean the LLM itself is unreachable (bad
		// key, network); stop burning timeouts on the remaining agents.
		return null;
	}
	const jargonRaw = await agent(
		'jargon',
		JARGON_SYSTEM,
		sample,
		CONTEXT_LIST_MAX_TOKENS,
	);
	const acronymsRaw = await agent(
		'acronyms',
		ACRONYMS_SYSTEM,
		sample,
		CONTEXT_LIST_MAX_TOKENS,
	);

	const topic = firstLine(topicRaw ?? '');
	const textWords = tokenizeWords(plainText(baseline));
	const names = filterHeardTerms(
		parseTermList(namesRaw ?? ''),
		textWords,
		NAME_MATCH_THRESHOLD,
	);
	const jargon = filterHeardTerms(
		parseTermList(jargonRaw ?? ''),
		textWords,
		JARGON_MATCH_THRESHOLD,
	);

	// Acronyms and glossary terms cannot be verified in code - the draft
	// holds their garbled form, not their canonical spelling - so the decider
	// agent vets them against the draft instead.
	const unverified = dedupeTerms([
		...parseTermList(acronymsRaw ?? ''),
		...(options.glossary ?? []),
	]);
	let vetted = unverified;
	if (unverified.length > 0) {
		const decidedRaw = await agent(
			'decider',
			DECIDER_SYSTEM,
			`Transcript:\n${sample}\n\nCandidates:\n${unverified.join('\n')}`,
			CONTEXT_LIST_MAX_TOKENS,
		);
		if (decidedRaw !== null) {
			vetted = intersectTerms(unverified, parseTermList(decidedRaw));
		}
		// A failed decider keeps the candidates: losing the acronyms - the
		// mode's main payoff - costs more than the over-correction risk the
		// length safeguard already bounds.
	}
	const acronymCandidates = new Set(
		parseTermList(acronymsRaw ?? '').map((term) => term.toLowerCase()),
	);
	const acronyms = vetted
		.filter((term) => acronymCandidates.has(term.toLowerCase()))
		.slice(0, CONTEXT_MAX_TERMS_PER_CATEGORY);
	const glossaryKept = vetted
		.filter((term) => !acronymCandidates.has(term.toLowerCase()))
		.slice(0, CONTEXT_MAX_TERMS_PER_CATEGORY);

	// Most valuable first: canonical acronyms (the draft's worst errors),
	// then the user's curated glossary, names, and jargon. A keyword-biased
	// engine that trims the list drops the least valuable end.
	const keyterms = dedupeTerms([
		...acronyms,
		...glossaryKept,
		...names,
		...jargon,
	]);
	if (keyterms.length === 0 && !topic) {
		return null;
	}

	// The sentence wants the same order reversed: Whisper weights the last
	// tokens of its prompt most, so the most valuable terms go at the end.
	const termsAscending = [...keyterms].reverse();
	let promptSentence = '';
	if (termsAscending.length > 0 || topic) {
		const builtRaw = await agent(
			'sentence',
			SENTENCE_SYSTEM_PREFIX +
				languageClause(options.language) +
				SENTENCE_SYSTEM_SUFFIX,
			`Topic: ${topic || '(unknown)'}\n\nTerms in ascending order of importance:\n${termsAscending.join('\n')}`,
			CONTEXT_SENTENCE_MAX_TOKENS,
		);
		const built = firstLine(builtRaw ?? '');
		promptSentence =
			built && withinPromptWindow(built)
				? built
				: buildFallbackPrompt(topic, termsAscending);
	}
	if (!promptSentence && keyterms.length === 0) {
		return null;
	}

	return { topic, names, jargon, acronyms, promptSentence, keyterms };
}
