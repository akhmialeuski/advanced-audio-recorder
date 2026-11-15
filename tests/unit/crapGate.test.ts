import type { ESLint } from 'eslint';
import {
	CRAP_THRESHOLD,
	type FileCoverage,
	improvedBaseline,
	type Score,
	scoreFunctions,
	violations,
} from '../../scripts/crap-gate';
import { partial } from '../helpers/doubles';

const ROOT = '/repo';
const FILE = '/repo/src/a.ts';

/** One `complexity` report whose head ends on `line` at 1-based `endColumn`. */
function report(
	message: string,
	line: number,
	endColumn: number,
	ruleId = 'complexity',
) {
	return {
		message,
		line,
		endLine: line,
		column: 1,
		endColumn,
		severity: 2,
		ruleId,
	};
}

function lint(
	messages: ReturnType<typeof report>[],
	filePath = FILE,
): ESLint.LintResult[] {
	return [partial<ESLint.LintResult>({ filePath, messages })];
}

const at = (line: number, column: number) => ({ line, column });
const range = (from: [number, number], to: [number, number]) => ({
	start: at(...from),
	end: at(...to),
});

function coverage(file: Partial<FileCoverage>): Record<string, FileCoverage> {
	return {
		[FILE]: {
			fnMap: {},
			f: {},
			statementMap: {},
			s: {},
			branchMap: {},
			b: {},
			...file,
		},
	};
}

function score(key: string, crap: number): Score {
	return {
		key,
		path: 'src/a.ts',
		name: key,
		line: 1,
		complexity: 9,
		coverage: 0,
		crap,
	};
}

/**
 * The keys of a file of named functions laid out one after another, each holding the given number of arrow
 * callbacks. Istanbul numbers every callback by a counter over the whole file, as ts-jest coverage does.
 */
function callbackKeys(callbacks: Record<string, number>): string[] {
	const messages: ReturnType<typeof report>[] = [];
	const fnMap: FileCoverage['fnMap'] = {};
	const f: FileCoverage['f'] = {};
	let line = 1;
	let id = 0;
	for (const [name, count] of Object.entries(callbacks)) {
		messages.push(
			report(`Function '${name}' has a complexity of 1.`, line, 20),
		);
		fnMap[id] = {
			name,
			decl: range([line, 9], [line, 9 + name.length]),
			loc: range([line, 20], [line + count + 1, 1]),
		};
		f[id++] = 1;
		for (let at = line + 1; at <= line + count; at++) {
			messages.push(
				report('Arrow function has a complexity of 1.', at, 12),
			);
			fnMap[id] = {
				name: `(anonymous_${id})`,
				decl: range([at, 4], [at, 5]),
				loc: range([at, 14], [at, 30]),
			};
			f[id++] = 1;
		}
		line += count + 2;
	}
	return scoreFunctions(lint(messages), coverage({ fnMap, f }), ROOT).map(
		(s) => s.key,
	);
}

describe('scoreFunctions with wrapped parameters', () => {
	it('matches a function whose wrapped parameters move its body below the head', () => {
		// function attachmentsByParent(
		//   attachments: Item[],
		// ): Map<string, Info[]> {
		const scores = scoreFunctions(
			lint([
				report(
					"Function 'attachmentsByParent' has a complexity of 4.",
					1,
					29,
				),
			]),
			coverage({
				fnMap: {
					'0': {
						name: 'attachmentsByParent',
						decl: range([1, 9], [1, 28]),
						loc: range([3, 22], [6, 1]),
					},
				},
				f: { '0': 3 },
				statementMap: {
					'0': range([4, 2], [4, 20]),
					'1': range([5, 2], [5, 20]),
				},
				s: { '0': 3, '1': 3 },
			}),
			ROOT,
		);

		expect(scores).toEqual([
			{
				key: 'src/a.ts::attachmentsByParent',
				path: 'src/a.ts',
				name: 'attachmentsByParent',
				line: 1,
				complexity: 4,
				coverage: 1,
				crap: 4,
			},
		]);
	});
});

describe('scoreFunctions with nested or unknown functions', () => {
	it('picks the innermost function holding the head of a nested arrow', () => {
		const scores = scoreFunctions(
			lint([report('Arrow function has a complexity of 2.', 2, 24)]),
			coverage({
				fnMap: {
					'0': {
						name: 'outer',
						decl: range([1, 9], [1, 14]),
						loc: range([1, 17], [4, 1]),
					},
					'1': {
						name: '(anonymous_1)',
						decl: range([2, 14], [2, 23]),
						loc: range([2, 23], [3, 3]),
					},
				},
				f: { '0': 1, '1': 0 },
			}),
			ROOT,
		);

		expect(scores).toEqual([
			expect.objectContaining({
				name: 'arrow function',
				coverage: 0,
				crap: 6,
			}),
		]);
	});

	it('counts a function Istanbul does not know as uncovered and names it by its kind', () => {
		const scores = scoreFunctions(
			lint(
				[report('Arrow function has a complexity of 3.', 7, 12)],
				'/repo/src/b.ts',
			),
			coverage({}),
			ROOT,
		);

		expect(scores).toEqual([
			expect.objectContaining({
				key: 'src/b.ts::arrow function',
				coverage: 0,
				crap: 12,
			}),
		]);
	});
});

describe('scoreFunctions coverage', () => {
	it('takes the lower of statement and branch coverage', () => {
		const scores = scoreFunctions(
			lint([report("Method 'run' has a complexity of 3.", 1, 6)]),
			coverage({
				fnMap: {
					'0': {
						name: '(anonymous_0)',
						decl: range([1, 2], [1, 5]),
						loc: range([1, 8], [9, 3]),
					},
				},
				f: { '0': 1 },
				statementMap: {
					'0': range([2, 4], [2, 9]),
					'1': range([3, 4], [3, 9]),
				},
				s: { '0': 1, '1': 1 },
				branchMap: { '0': { loc: range([2, 4], [8, 5]) } },
				b: { '0': [1, 0, 0, 0] },
			}),
			ROOT,
		);

		expect(scores).toEqual([
			expect.objectContaining({
				name: 'run',
				coverage: 0.25,
				crap: expect.closeTo(3 ** 2 * 0.75 ** 3 + 3, 4),
			}),
		]);
	});
});

describe('scoreFunctions naming', () => {
	it('skips class field initializers, static blocks and other rules', () => {
		const scores = scoreFunctions(
			lint([
				report('Class field initializer has a complexity of 3.', 1, 9),
				report('Class static block has a complexity of 3.', 2, 9),
				report('Unexpected any.', 3, 9, 'no-explicit-any'),
			]),
			coverage({}),
			ROOT,
		);

		expect(scores).toEqual([]);
	});

	it('numbers a name repeated in one file', () => {
		const scores = scoreFunctions(
			lint([
				report("Method 'execute' has a complexity of 1.", 3, 10),
				report("Method 'execute' has a complexity of 1.", 9, 10),
			]),
			coverage({}),
			ROOT,
		);

		expect(scores.map((s) => s.key)).toEqual([
			'src/a.ts::execute',
			'src/a.ts::execute#2',
		]);
	});

	it('keys a callback by its enclosing function, so a callback added in another function keeps the key', () => {
		// A recorded callback whose key moved would fail the gate, and --update-baseline cannot re-record it.
		expect(callbackKeys({ first: 1, second: 1 })).toEqual([
			'src/a.ts::first',
			'src/a.ts::first>arrow function',
			'src/a.ts::second',
			'src/a.ts::second>arrow function',
		]);
		expect(callbackKeys({ first: 2, second: 1 })).toEqual([
			'src/a.ts::first',
			'src/a.ts::first>arrow function',
			'src/a.ts::first>arrow function#2',
			'src/a.ts::second',
			'src/a.ts::second>arrow function',
		]);
	});
});

describe('violations', () => {
	it('reports unrecorded and worsened functions over the threshold, worst first', () => {
		const scores = [
			score('new', 12),
			score('worse', 30),
			score('kept', 20),
			score('better', 9),
			score('fine', CRAP_THRESHOLD),
		];

		const found = violations(scores, { worse: 25, kept: 20, better: 15 });

		expect(found).toEqual([
			'src/a.ts:1: worse CRAP 30.00 (complexity 9, coverage 0%), the limit is 8',
			'src/a.ts:1: new CRAP 12.00 (complexity 9, coverage 0%), the limit is 8',
		]);
	});
});

describe('improvedBaseline', () => {
	it('records every function over the threshold when nothing is recorded yet', () => {
		expect(improvedBaseline([score('a', 12), score('b', 8)])).toEqual({
			a: 12,
		});
	});

	it('keeps only recorded functions still over the threshold, at their lower score', () => {
		const scores = [
			score('lower', 10),
			score('higher', 40),
			score('fixed', 5),
			score('new', 50),
		];

		expect(
			improvedBaseline(scores, {
				lower: 20,
				higher: 30,
				fixed: 15,
				gone: 9,
			}),
		).toEqual({ lower: 10, higher: 30 });
	});
});
