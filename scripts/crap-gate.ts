/**
 * CRAP per function: `complexity² × (1 − coverage)³ + complexity` (Savoia and Evans, crap4j).
 *
 * ESLint's `complexity` rule, run with a maximum of 0, supplies every function's complexity, and Istanbul's
 * `coverage-final.json` supplies its coverage. This module only joins the two reports and compares the scores
 * with the recorded baseline. `scripts/crap-gate.mjs` reads the inputs and writes the results.
 */
import { relative, sep } from 'node:path';
import type { ESLint } from 'eslint';

export const CRAP_THRESHOLD = 8;

/** Recorded CRAP by function key. A recorded function may keep its score but not raise it. */
export type Baseline = Record<string, number>;

interface Position {
	line: number;
	column: number;
}

interface Range {
	start: Position;
	end: Position;
}

interface FunctionEntry {
	name: string;
	decl: Range;
	loc: Range;
}

/** The part of one `coverage-final.json` entry the gate reads. */
export interface FileCoverage {
	fnMap: Record<string, FunctionEntry>;
	f: Record<string, number>;
	statementMap: Record<string, Range>;
	s: Record<string, number>;
	branchMap: Record<string, { loc: Range }>;
	b: Record<string, number[]>;
}

export interface Score {
	key: string;
	path: string;
	name: string;
	line: number;
	complexity: number;
	coverage: number;
	crap: number;
}

/** A function as ESLint reports it: where its head ends, its kind, and its name when it has one. */
interface Reported {
	line: number;
	head: Position;
	complexity: number;
	kind: string;
	name: string | undefined;
}

/** A function already keyed in the current file, with the Istanbul body span it was matched to. */
interface Keyed {
	body: Range;
	name: string;
}

/** The Istanbul function a reported one was matched to, with its call count. */
interface Located {
	entry: FunctionEntry;
	calls: number;
}

const COMPLEXITY_MESSAGE = /^(.*?)(?: '(.+)')? has a complexity of (\d+)/;
// ESLint scores these too, but they are not functions, so Istanbul has no coverage entry for them.
const NOT_FUNCTIONS = new Set([
	'Class field initializer',
	'Class static block',
]);
const NO_COVERAGE: FileCoverage = {
	fnMap: {},
	f: {},
	statementMap: {},
	s: {},
	branchMap: {},
	b: {},
};

const compare = (a: Position, b: Position): number =>
	a.line - b.line || a.column - b.column;

const share = (hits: number[]): number =>
	hits.length === 0 ? 1 : hits.filter((hit) => hit > 0).length / hits.length;

function reported(result: ESLint.LintResult): Reported[] {
	const found: Reported[] = [];
	for (const message of result.messages) {
		const match = COMPLEXITY_MESSAGE.exec(message.message);
		if (message.ruleId !== 'complexity' || !match) continue;
		const [, kind = '', name, complexity] = match;
		if (NOT_FUNCTIONS.has(kind)) continue;
		found.push({
			line: message.line,
			// ESLint columns are 1-based and Istanbul columns 0-based.
			head: {
				line: message.endLine ?? message.line,
				column: (message.endColumn ?? message.column) - 1,
			},
			complexity: Number(complexity),
			kind,
			name,
		});
	}
	return found;
}

/**
 * ESLint places a function at its head, which ends at the opening parenthesis or the arrow, while Istanbul's
 * `loc` starts at the body, a line lower once Prettier wraps the parameters. So the match is the innermost
 * Istanbul function whose span, from `decl` to the end of the body, holds the end of the head.
 */
function locate(file: FileCoverage, head: Position): Located | undefined {
	let best: Located | undefined;
	for (const [id, entry] of Object.entries(file.fnMap)) {
		const holds =
			compare(entry.decl.start, head) <= 0 &&
			compare(head, entry.loc.end) <= 0;
		if (
			holds &&
			(!best || compare(best.entry.decl.start, entry.decl.start) < 0)
		)
			best = { entry, calls: file.f[id] ?? 0 };
	}
	return best;
}

/**
 * The lower of the function's statement and branch coverage, or 0 when it was never called or Istanbul does not
 * know it. Statements and branches belong to the function when they start on a line of its body.
 */
function functionCoverage(
	file: FileCoverage,
	found: Located | undefined,
): number {
	if (!found || found.calls === 0) return 0;
	const { start, end } = found.entry.loc;
	const inBody = (range: Range): boolean =>
		range.start.line >= start.line && range.start.line <= end.line;
	const statements = Object.entries(file.statementMap)
		.filter(([, range]) => inBody(range))
		.map(([key]) => file.s[key] ?? 0);
	const branches = Object.entries(file.branchMap)
		.filter(([, branch]) => inBody(branch.loc))
		.flatMap(([key]) => file.b[key] ?? []);
	return Math.min(share(statements), share(branches));
}

/** The name itself on its first use in a file, then `name#2`, `name#3`. */
function uniqueName(seen: Map<string, number>, base: string): string {
	const count = (seen.get(base) ?? 0) + 1;
	seen.set(base, count);
	return count === 1 ? base : `${base}#${count}`;
}

/**
 * The name of a function ESLint does not name: its kind, under the name of the innermost function whose body holds
 * it. Istanbul names such a function by a counter over every function above it in the file, so a key built from
 * that counter would move whenever a callback is added anywhere above.
 */
function unnamed(
	outer: Keyed[],
	kind: string,
	found: Located | undefined,
): string {
	const own = kind.toLowerCase();
	if (!found) return own;
	const { loc } = found.entry;
	// ESLint reports a function before the ones nested in it, so the last holder is the innermost.
	const parent = outer
		.filter(
			({ body }) =>
				compare(body.start, loc.start) <= 0 &&
				compare(loc.end, body.end) <= 0,
		)
		.at(-1);
	return parent ? `${parent.name}>${own}` : own;
}

/**
 * Score every function ESLint reported. A function is keyed by its file and its name: ESLint's name, else its kind
 * under the name of the function holding it, with `#2`, `#3` for a name repeated in one file.
 */
export function scoreFunctions(
	results: ESLint.LintResult[],
	coverage: Record<string, FileCoverage>,
	root: string,
): Score[] {
	const scores: Score[] = [];
	for (const result of results) {
		const path = relative(root, result.filePath).split(sep).join('/');
		const file = coverage[result.filePath] ?? NO_COVERAGE;
		const seen = new Map<string, number>();
		const keyed: Keyed[] = [];
		for (const fn of reported(result)) {
			const found = locate(file, fn.head);
			const name = uniqueName(
				seen,
				fn.name ?? unnamed(keyed, fn.kind, found),
			);
			if (found) keyed.push({ body: found.entry.loc, name });
			const covered = functionCoverage(file, found);
			const crap =
				fn.complexity ** 2 * (1 - covered) ** 3 + fn.complexity;
			scores.push({
				key: `${path}::${name}`,
				path,
				name,
				line: fn.line,
				complexity: fn.complexity,
				coverage: covered,
				crap: Math.round(crap * 10_000) / 10_000,
			});
		}
	}
	return scores;
}

/** One line per function over the threshold that the baseline does not record at that score or higher, worst first. */
export function violations(scores: Score[], baseline: Baseline): string[] {
	return scores
		.filter(
			(score) =>
				score.crap > CRAP_THRESHOLD &&
				score.crap > (baseline[score.key] ?? -1),
		)
		.sort((a, b) => b.crap - a.crap)
		.map(
			(score) =>
				`${score.path}:${score.line}: ${score.name} CRAP ${score.crap.toFixed(2)} ` +
				`(complexity ${score.complexity}, coverage ${Math.round(score.coverage * 100)}%), ` +
				`the limit is ${CRAP_THRESHOLD}`,
		);
}

/**
 * The baseline after this run: every function over the threshold at its current score when nothing is recorded
 * yet, otherwise only the recorded functions still over it, each at the lower of its two scores.
 */
export function improvedBaseline(
	scores: Score[],
	recorded?: Baseline,
): Baseline {
	const next: Baseline = {};
	for (const score of scores) {
		if (score.crap <= CRAP_THRESHOLD) continue;
		if (!recorded) {
			next[score.key] = score.crap;
			continue;
		}
		const prior = recorded[score.key];
		if (prior !== undefined) next[score.key] = Math.min(score.crap, prior);
	}
	return next;
}
