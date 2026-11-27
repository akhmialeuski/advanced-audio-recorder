/**
 * The prompt a note template's parts are asked for with, and the reading of
 * the answer.
 *
 * The parts of one call are asked for together, as one JSON object with a key
 * per part, because a model that reads the transcript once and answers every
 * part from that one reading is both cheaper and more consistent than a call
 * per part. The model returns data and the plugin writes the Markdown, so the
 * prompt describes each value by its format's contract, never by the Markdown
 * it will become.
 * @module transcription/templatePrompt
 */

import type { LlmPrompt } from './llmPostProcess';
import type { PartSpec } from '../templates/noteTemplate';
import { partFormat, DEFAULT_PART_FORMAT } from '../templates/partFormats';
import type { RunFacts } from '../templates/runVariables';
import { formatDuration } from '../templates/templateHelpers';
import type { Transcript } from './TranscriptTypes';
import { formatTimecode } from '../utils/TimeUtils';
import { parseJsonAnswer } from './llm/jsonAnswer';

/** One part of a call, with the instruction it is asked for with. */
export interface PromptPart {
	readonly spec: PartSpec;
	/** The instruction, from the block or the profile it names, filled in. */
	readonly instruction: string;
}

/** What one call's prompt is built from. */
export interface TemplatePromptInput {
	/** The parts this call asks for. */
	readonly parts: readonly PromptPart[];
	/** The facts of the run, told to the model as context. */
	readonly facts: RunFacts;
	/** Canonical spellings of names and terms. */
	readonly glossary: readonly string[];
	/** The transcript the parts are taken from. */
	readonly transcript: Transcript;
}

/** What the model is told the whole job is. */
const TEMPLATE_SYSTEM_PROMPT =
	'You fill in the parts of a note about a recording, from its transcript. ' +
	'Answer with one JSON object and nothing else: one key per part listed below, ' +
	'each holding the value described for it. Take everything from the transcript ' +
	'and invent nothing; when the transcript holds nothing for a part, give an ' +
	'empty value ("" or []).';

/**
 * The facts of the recording, as lines the model reads for context.
 * @param facts - The facts of the run
 */
function recordingClause(facts: RunFacts): string {
	const lines = [
		`Title: ${facts.title}`,
		...(facts.recordedAt === null
			? []
			: [
					`Recorded: ${new Date(facts.recordedAt).toISOString().slice(0, 10)}`,
				]),
		...(facts.durationSeconds === null
			? []
			: [`Length: ${formatDuration(facts.durationSeconds)}`]),
		...(facts.participants.length > 0
			? [`Participants: ${facts.participants.join(', ')}`]
			: []),
	];
	return `\n\nAbout the recording:\n${lines.join('\n')}`;
}

/**
 * The glossary clause: canonical spellings the parts should use.
 * @param glossary - Canonical terms, possibly none
 */
function glossaryClause(glossary: readonly string[]): string {
	return glossary.length === 0
		? ''
		: `\n\nWhere a name, term or acronym appears, spell it as in this list: ${glossary.join(', ')}.`;
}

/**
 * The language every value is written in.
 * @param language - The transcript's language, when known
 */
function languageClause(language: string): string {
	return language === ''
		? '\n\nWrite every value in the language of the transcript, unless a part says otherwise.'
		: `\n\nWrite every value in ${language}, unless a part says otherwise.`;
}

/**
 * How one part is described to the model.
 * @param part - The part and its instruction
 */
function partClause(part: PromptPart): string {
	const { spec } = part;
	const format = partFormat(spec.format) ?? partFormat(DEFAULT_PART_FORMAT);
	const lines = [
		`"${spec.name}": ${format?.contract ?? 'a string'}.`,
		...(spec.max === undefined
			? []
			: [`At most ${String(spec.max)} items, the most important first.`]),
		...(spec.language === undefined
			? []
			: [`Write it in ${spec.language}.`]),
		part.instruction,
	];
	return lines.filter((line) => line !== '').join('\n');
}

/**
 * The transcript as the model reads it: a line per segment with its time and
 * speaker, and no links or Markdown, which would only cost tokens.
 * @param transcript - The transcript
 */
export function transcriptForModel(transcript: Transcript): string {
	const reference = transcript.segments.at(-1)?.end ?? 0;
	return transcript.segments
		.map((segment) => {
			const speaker = segment.speaker ? `${segment.speaker}: ` : '';
			return `[${formatTimecode(segment.start, reference)}] ${speaker}${segment.text.trim()}`;
		})
		.join('\n');
}

/**
 * The prompt for one call.
 * @param input - The parts, facts and transcript of the call
 */
export function buildTemplatePrompt(input: TemplatePromptInput): LlmPrompt {
	return {
		system:
			TEMPLATE_SYSTEM_PROMPT +
			recordingClause(input.facts) +
			glossaryClause(input.glossary) +
			languageClause(input.facts.language) +
			'\n\nParts:\n\n' +
			input.parts.map(partClause).join('\n\n'),
		user: transcriptForModel(input.transcript),
	};
}

/**
 * The answer for each part of a call, as the model gave it. A call of one part
 * is read leniently: a value given alone rather than inside an object, or
 * under another key as the only one, is read as that part's answer.
 * @param output - The model's answer
 * @param names - The names of the call's parts
 * @returns The raw answer per part; a part the model left out is absent
 */
export function readTemplateAnswer(
	output: string,
	names: readonly string[],
): Map<string, unknown> {
	const only = names.length === 1 ? names[0] : undefined;
	const parsed = parseJsonAnswer(output, 'object');
	if (!parsed) {
		return only === undefined
			? new Map<string, unknown>()
			: new Map([
					[only, parseJsonAnswer(output, 'array') ?? output.trim()],
				]);
	}
	const answers = new Map(
		names
			.filter((name) => Object.hasOwn(parsed, name))
			.map((name) => [name, parsed[name]]),
	);
	const values = Object.values(parsed);
	if (answers.size === 0 && only !== undefined && values.length === 1) {
		answers.set(only, values[0]);
	}
	return answers;
}
