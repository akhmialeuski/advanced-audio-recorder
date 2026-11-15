// Lint the repository the way the Obsidian community review does, and fail on what makes that review abort with
// "The source code review encountered a fatal error": ESLint exiting with 2, which a crash, a broken config or
// suppressions the review's rules leave unused all cause, or a fatal message such as a file no tsconfig.json holds.
// Ordinary findings pass, because the review lists them instead of aborting. The CLI is run rather than the Node
// API, since only the CLI loads eslint-suppressions.json from the working directory as the review's run does.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const eslintBin = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');

const run = spawnSync(
	process.execPath,
	[eslintBin, '.', '--config', 'scripts/review-scan.config.mjs', '--format', 'json'],
	{ encoding: 'utf8', maxBuffer: 1 << 30 },
);

if (run.status === 2 || run.status === null) {
	console.error(`review-scan: ESLint aborted (exit ${String(run.status)}):\n${run.stderr}`);
	process.exit(1);
}

const fatal = JSON.parse(run.stdout).flatMap((file) =>
	file.messages
		.filter((message) => message.fatal)
		.map((message) => `${relative(process.cwd(), file.filePath)}:${message.line}: ${message.message}`),
);
for (const line of fatal) console.error(line);
console.log(`review-scan: ${fatal.length} fatal message(s)`);
process.exitCode = fatal.length === 0 ? 0 : 1;
