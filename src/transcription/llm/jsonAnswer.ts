/**
 * Finding the JSON in a model's answer.
 *
 * A model asked for JSON alone still wraps it: in a code fence, after a
 * sentence such as "Here are the chapters:", or both. Every reader of a JSON
 * answer needs the same tolerance, so it lives here once.
 * @module transcription/llm/jsonAnswer
 */

/** The brackets a JSON value of one kind opens and closes with. */
const BRACKETS = {
	array: ['[', ']'],
	object: ['{', '}'],
} as const;

/** Which kind of JSON value an answer should hold. */
export type JsonAnswerKind = keyof typeof BRACKETS;

/**
 * The JSON text in a model's answer: the inside of a code fence when there is
 * one, cut from the first opening bracket of the kind asked for to the last
 * closing one, which also drops prose before and after it.
 * @param output - The model's answer
 * @param kind - Whether an array or an object is expected
 * @returns Candidate JSON text, or null when the brackets are not there
 */
export function extractJsonText(
	output: string,
	kind: JsonAnswerKind,
): string | null {
	const [open, close] = BRACKETS[kind];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
	const candidate = fenced?.[1] ?? output;
	const start = candidate.indexOf(open);
	const end = candidate.lastIndexOf(close);
	if (start === -1 || end <= start) {
		return null;
	}
	return candidate.slice(start, end + 1);
}

/**
 * The JSON value of the kind asked for in a model's answer, parsed.
 * @param output - The model's answer
 * @param kind - Whether an array or an object is expected
 * @returns The value, or undefined when none of that kind could be read
 */
export function parseJsonAnswer(
	output: string,
	kind: 'object',
): Record<string, unknown> | undefined;
export function parseJsonAnswer(
	output: string,
	kind: 'array',
): unknown[] | undefined;
export function parseJsonAnswer(
	output: string,
	kind: JsonAnswerKind,
): Record<string, unknown> | unknown[] | undefined {
	const parsed = parsedJson(extractJsonText(output, kind));
	const isArray = Array.isArray(parsed);
	if (kind === 'array') {
		return isArray ? (parsed as unknown[]) : undefined;
	}
	return isRecord(parsed) ? parsed : undefined;
}

/**
 * Parsed JSON text, or undefined for none or for text that does not parse.
 * @param text - The candidate text
 */
function parsedJson(text: string | null): unknown {
	if (text === null) {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Whether a parsed value is a JSON object.
 * @param value - The value
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
