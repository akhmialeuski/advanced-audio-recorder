/**
 * Jest configuration, split into the three layers the suite is organised in.
 *
 * The layers exist so a change can be checked at the right level: `unit` for a
 * module in isolation, `integration` for a handful of them wired together, and
 * `e2e` for the plugin driven the way Obsidian drives it. Naming them here is
 * what makes `--selectProjects unit` possible, and what stops the boundary from
 * being a naming convention nobody enforces.
 *
 * Coverage settings stay at the top level because Jest resolves them there:
 * `coverageThreshold` is a global option, and the per-path entries under it are
 * how each weak area of src/ gets its own floor. scripts/coverage-diff.mjs adds
 * the per-file guard on top.
 */

/** Everything a project needs regardless of which layer it is. */
const shared = {
	preset: undefined,
	testEnvironment: 'jsdom',
	moduleFileExtensions: ['js', 'ts', 'd.ts'],
	transform: { '^.+\\.ts$': 'ts-jest' },
	moduleNameMapper: {
		// The obsidian package ships types and no runtime, so the suite
		// supplies one; see tests/mocks/obsidian.ts.
		'^obsidian$': '<rootDir>/tests/mocks/obsidian.ts',
		'^@mediabunny/flac-encoder$': '<rootDir>/tests/mocks/flac-encoder.ts',
		'^@mediabunny/mp3-encoder$': '<rootDir>/tests/mocks/mp3-encoder.ts',
		'^src/(.*)$': '<rootDir>/src/$1',
	},
	setupFiles: ['<rootDir>/tests/setup.ts'],
	setupFilesAfterEnv: ['<rootDir>/tests/setupAfterEnv.ts'],
	clearMocks: true,
	restoreMocks: true,
};

export default {
	projects: [
		{
			...shared,
			displayName: 'unit',
			testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
		},
		{
			...shared,
			displayName: 'integration',
			testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
		},
		{
			...shared,
			displayName: 'e2e',
			testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
			// Every e2e suite drives the plugin, so every one of them needs
			// the same collaborators recorded. Registering the mocks here
			// keeps that out of the suites themselves.
			setupFiles: [...shared.setupFiles, '<rootDir>/tests/setupE2e.ts'],
		},
	],
	reporters: ['default', '<rootDir>/scripts/jest-suite-stats-reporter.cjs'],
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
	coverageReporters: ['text', 'json-summary', 'lcov'],
	coverageThreshold: {
		// Pinned just under the current actuals, so a drop is a failed build
		// rather than a number nobody notices. Note the semantics: a file
		// counts in EVERY group whose prefix matches it, and `global` covers
		// only the files no other group claims.
		// scripts/coverage-thresholds.mjs prints what each group reaches now.
		global: {
			statements: 97.1,
			branches: 89.7,
			functions: 97.7,
			lines: 97.1,
		},
		'./src/main.ts': {
			statements: 99.0,
			branches: 97.0,
			functions: 97.1,
			lines: 99.6,
		},
		'src/player/views/': {
			statements: 98.6,
			branches: 92.6,
			functions: 94.1,
			lines: 98.6,
		},
		'src/player/': {
			statements: 97.3,
			branches: 89.7,
			functions: 95.7,
			lines: 97.4,
		},
		'src/ui/': {
			statements: 97.7,
			branches: 90.7,
			functions: 95.1,
			lines: 97.8,
		},
		'src/actions/': {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
		'src/platform/': {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
	},
};
