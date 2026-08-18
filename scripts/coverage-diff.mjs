/**
 * Guards the test suite against silent regressions that the coverage
 * thresholds in package.json cannot see.
 *
 * Thresholds are aggregate: one file losing fifteen points while another gains
 * them keeps the group percentage flat. This compares the fresh coverage run
 * against a committed baseline file by file, and also checks that the suite
 * itself has not shrunk (test count, suite count).
 *
 * Usage:
 *   node scripts/coverage-diff.mjs                 check against the baseline
 *   node scripts/coverage-diff.mjs --update-baseline   record the current state
 *
 * Run `npm run test:coverage` first: the script reads coverage/coverage-summary.json
 * and coverage/suite-stats.json, both written by that run.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, 'tests/coverage-baseline.json');
const SUMMARY_PATH = path.join(ROOT, 'coverage/coverage-summary.json');
const STATS_PATH = path.join(ROOT, 'coverage/suite-stats.json');
const METRICS = ['statements', 'branches', 'functions', 'lines'];

/** Percentage points a file may drop before the run is treated as a regression. */
const FILE_TOLERANCE = 0.01;

/**
 * Reads a JSON file, failing with an actionable message when it is missing.
 * @param {string} file - Absolute path to read
 * @param {string} hint - What to run when the file is absent
 * @returns {unknown} Parsed contents
 */
function readJson(file, hint) {
	if (!fs.existsSync(file)) {
		console.error(`Missing ${path.relative(ROOT, file)} - run ${hint} first.`);
		process.exit(2);
	}
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Reduces a coverage summary to the shape the baseline stores: total plus a
 * percentage per file, keyed by repo-relative path.
 * @param {Record<string, object>} summary - Jest's coverage-summary.json
 * @returns {{total: Record<string, number>, files: Record<string, Record<string, number>>}} Baseline shape
 */
function shapeCoverage(summary) {
	const files = {};
	for (const [absolute, entry] of Object.entries(summary)) {
		if (absolute === 'total') {
			continue;
		}
		const key = path.relative(ROOT, absolute);
		files[key] = Object.fromEntries(
			METRICS.map((metric) => [metric, entry[metric].pct]),
		);
	}
	return {
		total: Object.fromEntries(
			METRICS.map((metric) => [metric, summary.total[metric].pct]),
		),
		files,
	};
}

const summary = readJson(SUMMARY_PATH, 'npm run test:coverage');
const stats = readJson(STATS_PATH, 'npm run test:coverage');
const current = { coverage: shapeCoverage(summary), suite: stats };

if (process.argv.includes('--update-baseline')) {
	fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, '\t')}\n`);
	console.log(`Baseline updated: ${path.relative(ROOT, BASELINE_PATH)}`);
	console.log(
		`  total: ${METRICS.map((m) => `${m} ${current.coverage.total[m]}%`).join(', ')}`,
	);
	console.log(
		`  suite: ${current.suite.tests} tests in ${current.suite.suites} suites`,
	);
	process.exit(0);
}

const baseline = readJson(
	BASELINE_PATH,
	'node scripts/coverage-diff.mjs --update-baseline',
);

const failures = [];
const improvements = [];

for (const metric of METRICS) {
	const before = baseline.coverage.total[metric];
	const after = current.coverage.total[metric];
	if (after < before - FILE_TOLERANCE) {
		failures.push(
			`total ${metric}: ${after.toFixed(2)}% < baseline ${before.toFixed(2)}%`,
		);
	} else if (after > before + FILE_TOLERANCE) {
		improvements.push(
			`total ${metric}: ${before.toFixed(2)}% -> ${after.toFixed(2)}%`,
		);
	}
}

for (const [file, before] of Object.entries(baseline.coverage.files)) {
	const after = current.coverage.files[file];
	if (!after) {
		// A deleted source file is not a coverage regression; a renamed one shows
		// up as a new file with its own numbers.
		continue;
	}
	for (const metric of METRICS) {
		if (after[metric] < before[metric] - FILE_TOLERANCE) {
			failures.push(
				`${file} ${metric}: ${after[metric].toFixed(2)}% < baseline ${before[metric].toFixed(2)}%`,
			);
		}
	}
}

const newFiles = Object.keys(current.coverage.files).filter(
	(file) => !(file in baseline.coverage.files),
);

if (current.suite.tests < baseline.suite.tests) {
	failures.push(
		`test count: ${current.suite.tests} < baseline ${baseline.suite.tests}`,
	);
}
if (current.suite.suites < baseline.suite.suites) {
	failures.push(
		`suite count: ${current.suite.suites} < baseline ${baseline.suite.suites}`,
	);
}

console.log(
	`Suite: ${current.suite.tests} tests (baseline ${baseline.suite.tests}) in ` +
		`${current.suite.suites} suites (baseline ${baseline.suite.suites})`,
);
for (const line of improvements) {
	console.log(`  improved: ${line}`);
}
for (const file of newFiles) {
	console.log(`  new file: ${file}`);
}

if (failures.length > 0) {
	console.error(`\nCoverage regression (${failures.length}):`);
	for (const line of failures) {
		console.error(`  ${line}`);
	}
	console.error(
		'\nRaise the coverage back, or re-record the baseline deliberately with ' +
			'node scripts/coverage-diff.mjs --update-baseline',
	);
	process.exit(1);
}

console.log('No coverage or suite-size regression.');
