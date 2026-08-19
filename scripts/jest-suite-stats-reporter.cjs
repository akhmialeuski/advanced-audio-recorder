/**
 * Jest reporter that records how big the suite is, so a run can be compared
 * against a committed baseline the same way coverage is.
 *
 * Coverage alone does not notice a deleted test whose lines another test also
 * touches; the test count does. Written next to the coverage output so
 * scripts/coverage-diff.mjs finds both in one place.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Writes coverage/suite-stats.json at the end of a run. */
class SuiteStatsReporter {
	/**
	 * @param {object} globalConfig - Jest's resolved global config
	 */
	constructor(globalConfig) {
		this.rootDir = globalConfig.rootDir;
		// A filtered run (`jest SomeFile`) covers fewer suites; recording it would
		// let the baseline drift down to whatever was last run in isolation.
		// Jest 30 exposes a TestPathPatterns object carrying the raw patterns.
		const patterns = globalConfig.testPathPatterns?.patterns ?? [];
		this.filtered =
			patterns.length > 0 ||
			Boolean(globalConfig.onlyChanged) ||
			Boolean(globalConfig.testNamePattern);
	}

	/**
	 * @param {unknown} _contexts - Test contexts (unused)
	 * @param {object} results - Aggregated run results
	 */
	onRunComplete(_contexts, results) {
		if (this.filtered) {
			return;
		}
		const outDir = path.join(this.rootDir, 'coverage');
		fs.mkdirSync(outDir, { recursive: true });
		fs.writeFileSync(
			path.join(outDir, 'suite-stats.json'),
			`${JSON.stringify(
				{
					suites: results.numTotalTestSuites,
					tests: results.numTotalTests,
					passed: results.numPassedTests,
					failed: results.numFailedTests,
					todo: results.numTodoTests,
				},
				null,
				'\t',
			)}\n`,
		);
	}
}

module.exports = SuiteStatsReporter;
