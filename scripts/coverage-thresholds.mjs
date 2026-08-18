/**
 * Prints the coverage each `coverageThreshold` group in package.json actually
 * reaches right now, so the thresholds can be pinned to the current state.
 *
 * Jest subtracts every file matched by a path/glob group from the `global`
 * group, so the global numbers are NOT the ones in the summary's `total` once
 * groups exist. This script mirrors that subtraction.
 *
 * Usage: node scripts/coverage-thresholds.mjs [--json]
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const summary = require('../coverage/coverage-summary.json');
const pkg = require('../package.json');

const METRICS = ['statements', 'branches', 'functions', 'lines'];
const root = process.cwd();
const groups = Object.keys(pkg.jest.coverageThreshold).filter(
	(key) => key !== 'global',
);

/**
 * Lists every configured group a file belongs to. Jest counts a file in each
 * matching group, so nested groups such as `src/player/` and
 * `src/player/views/` both include the files under `views`.
 * @param {string} file - Absolute path of the covered file
 * @returns {string[]} Matching group keys, or `['global']` when none match
 */
function groupsFor(file) {
	const matches = groups.filter((key) =>
		file.startsWith(path.resolve(root, key)),
	);
	return matches.length > 0 ? matches : ['global'];
}

const buckets = new Map([['global', []]]);
for (const key of groups) {
	buckets.set(key, []);
}
for (const [file, entry] of Object.entries(summary)) {
	if (file === 'total') {
		continue;
	}
	for (const key of groupsFor(file)) {
		buckets.get(key).push(entry);
	}
}

/**
 * Aggregates per-file coverage entries into whole-group percentages.
 * @param {object[]} entries - Coverage summary entries
 * @returns {Record<string, number>} Percentage per metric
 */
function aggregate(entries) {
	const totals = Object.fromEntries(METRICS.map((m) => [m, [0, 0]]));
	for (const entry of entries) {
		for (const metric of METRICS) {
			totals[metric][0] += entry[metric].covered;
			totals[metric][1] += entry[metric].total;
		}
	}
	return Object.fromEntries(
		METRICS.map((metric) => {
			const [covered, total] = totals[metric];
			return [metric, total === 0 ? 100 : (covered / total) * 100];
		}),
	);
}

const report = {};
for (const [key, entries] of buckets) {
	report[key] = { files: entries.length, ...aggregate(entries) };
}

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(report, null, 2));
} else {
	for (const [key, value] of Object.entries(report)) {
		const cells = METRICS.map(
			(m) => `${m} ${value[m].toFixed(2).padStart(6)}`,
		).join('  ');
		console.log(
			`${key.padEnd(20)} ${String(value.files).padStart(3)} files  ${cells}`,
		);
	}
}
