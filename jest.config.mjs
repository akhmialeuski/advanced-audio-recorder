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
		},
	],
	reporters: ['default', '<rootDir>/scripts/jest-suite-stats-reporter.cjs'],
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
	coverageReporters: ['text', 'json-summary', 'lcov'],
	coverageThreshold: {
		global: {
			statements: 95.5,
			branches: 87,
			functions: 95.2,
			lines: 95.4,
		},
		'./src/main.ts': {
			statements: 73,
			branches: 71.5,
			functions: 50,
			lines: 73.5,
		},
		'src/player/views/': {
			statements: 83.5,
			branches: 65,
			functions: 82,
			lines: 84,
		},
		'src/player/': {
			statements: 86.4,
			branches: 75,
			functions: 84,
			lines: 86.5,
		},
		'src/ui/': {
			statements: 90,
			branches: 81.3,
			functions: 81,
			lines: 90,
		},
		'src/actions/': {
			statements: 90,
			branches: 94,
			functions: 74.5,
			lines: 90,
		},
		'src/platform/': {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
	},
};
