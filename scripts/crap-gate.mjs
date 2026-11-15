// Gate the CRAP score of every function in src/ against crap-baseline.json, after `npm run test:coverage` has
// written coverage/coverage-final.json. With --update-baseline, a green run records improvements only, and a
// missing baseline is seeded. Node runs the TypeScript import directly through its type stripping.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ESLint } from 'eslint';
import { improvedBaseline, scoreFunctions, violations } from './crap-gate.ts';

const BASELINE = 'crap-baseline.json';
const COVERAGE = 'coverage/coverage-final.json';

const update = parseArgs({
	options: { 'update-baseline': { type: 'boolean' } },
}).values['update-baseline'];

if (!existsSync(COVERAGE)) {
	console.error(
		`crap-gate: ${COVERAGE} is missing. Run npm run test:coverage first.`,
	);
	process.exit(2);
}

// complexity at 0 makes ESLint report every function with its score. Suppressions stay off, so the size-limit
// debt recorded in eslint-suppressions.json hides no function.
const eslint = new ESLint({
	applySuppressions: false,
	overrideConfig: { rules: { complexity: ['error', 0] } },
	ruleFilter: ({ ruleId }) => ruleId === 'complexity',
});
const scores = scoreFunctions(
	await eslint.lintFiles(['src']),
	JSON.parse(readFileSync(COVERAGE, 'utf8')),
	process.cwd(),
);

const recorded = existsSync(BASELINE)
	? JSON.parse(readFileSync(BASELINE, 'utf8')).crap
	: undefined;
const baseline = recorded ?? (update ? improvedBaseline(scores) : {});
const problems = violations(scores, baseline);
if (update && problems.length === 0) {
	const next = improvedBaseline(scores, baseline);
	const sorted = Object.fromEntries(
		Object.keys(next)
			.sort()
			.map((key) => [key, next[key]]),
	);
	writeFileSync(
		BASELINE,
		`${JSON.stringify({ crap: sorted }, null, '\t')}\n`,
	);
}

for (const problem of problems) console.error(problem);
process.stdout.write(
	`${scores.length} function(s) scored, ${problems.length} violation(s)\n`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
