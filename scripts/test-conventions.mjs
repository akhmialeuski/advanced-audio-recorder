/**
 * Checks the test conventions that are otherwise only written down.
 *
 * docs/dev/testing.md states several rules a reviewer would have to remember:
 * assert through the helpers rather than on CSS classes, widen a type through
 * a named helper rather than a bare double cast, and never shadow the shared
 * Obsidian mock with an inline one. Each of them is what it is today because
 * somebody did the opposite at scale, so each gets a ceiling here rather than
 * a note in a document.
 *
 * The ceilings are the counts the suite reached, not aspirations: they stop
 * the numbers creeping back up, and are lowered deliberately when the work is
 * done to lower them.
 *
 * Usage: node scripts/test-conventions.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** The rules, each with the ceiling the suite currently sits at or under. */
const RULES = [
	{
		name: 'CSS class selectors in test bodies',
		pattern: /'\.aar-/g,
		limit: 0,
		fix: 'name the selector in tests/helpers/selectors.ts',
	},
	{
		name: 'querySelector calls in test bodies',
		pattern: /querySelector/g,
		limit: 70,
		fix: 'read the DOM through tests/helpers/dom.ts',
	},
	{
		name: 'bare `as unknown as` casts',
		pattern: /as unknown as/g,
		limit: 150,
		fix: 'widen through partial<T>() or internalsOf<T>() in tests/helpers/doubles.ts',
	},
	{
		name: 'test titles starting with "should"',
		pattern: /^\s*(?:it|test)\(\s*['"`]should\b/gm,
		limit: 0,
		fix: 'name the behaviour in the third person, as jest/valid-title requires',
	},
	{
		// "It was called" is the weakest thing a spy can be asked. It passes
		// for a call with the wrong file, the wrong path, the wrong marker -
		// every mistake worth catching in code that writes to the vault. The
		// negative form is not counted: "nothing was written" is a strong
		// claim that has no arguments to name.
		//
		// The lookbehind spans whitespace on purpose. Prettier keeps `.not`
		// next to its matcher today, but it wraps a long member chain, and a
		// ceiling pinned to the exact count would then fail the build for a
		// change that made a test stronger.
		name: 'assertions that a call happened without saying with what',
		pattern: /(?<!\.not\s*\.\s*)toHaveBeenCalled\(\)/g,
		limit: 168,
		fix: 'name the arguments with toHaveBeenCalledWith, or the count with toHaveBeenCalledTimes',
	},
	{
		// Obsidian extends HTMLElement at runtime, and a suite that reproduces
		// a corner of that surface gets a subtly different one - a `cls` that
		// takes no array, a `createEl` that appends before it fills. The
		// shared extension is the only copy that keeps up with the real thing.
		name: 'hand-rolled Obsidian DOM extensions',
		pattern: /\b(?:createEl|createDiv|setText)\b\s*=\s*function|\['(?:createEl|createDiv)'\]\s*=/g,
		limit: 0,
		fix: 'extend elements through addObsidianDomExtensions in tests/mocks/domExtensions.ts',
	},
];

/**
 * Every test file under a directory.
 * @param dir - Directory to walk
 * @returns Repo-relative paths
 */
function testFiles(dir) {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...testFiles(full));
		} else if (entry.name.endsWith('.test.ts')) {
			found.push(full);
		}
	}
	return found;
}

const files = testFiles('tests');
const sources = files.map((file) => ({
	file,
	text: fs.readFileSync(path.join(ROOT, file), 'utf8'),
}));

const problems = [];

for (const rule of RULES) {
	let total = 0;
	const worst = [];
	for (const { file, text } of sources) {
		const count = [...text.matchAll(rule.pattern)].length;
		total += count;
		if (count > 0) {
			worst.push({ file, count });
		}
	}
	const status = total <= rule.limit ? 'ok  ' : 'OVER';
	console.log(
		`${status} ${String(total).padStart(4)} / ${String(rule.limit).padEnd(4)} ${rule.name}`,
	);
	if (total > rule.limit) {
		worst.sort((a, b) => b.count - a.count);
		problems.push(
			`${rule.name}: ${String(total)} > ${String(rule.limit)} - ${rule.fix}\n` +
				worst
					.slice(0, 5)
					.map((entry) => `    ${String(entry.count)}  ${entry.file}`)
					.join('\n'),
		);
	}
}

// The shared Obsidian mock may be extended or spread, never replaced: a
// partial inline double silently no-ops whatever it leaves out, which is how
// a Setting that rendered nothing kept a whole dialog's tests passing.
const shadowMocks = sources.filter(({ text }) => {
	const declaration = /jest\.mock\('obsidian',([\s\S]{0,200})/.exec(text);
	return declaration !== null && !declaration[1].includes('mocks/modules/');
});
console.log(
	`${shadowMocks.length === 0 ? 'ok  ' : 'OVER'} ${String(shadowMocks.length).padStart(4)} / 0    inline mocks shadowing the obsidian mock`,
);
if (shadowMocks.length > 0) {
	problems.push(
		'Inline obsidian mocks - extend tests/mocks/obsidian.ts, or spread it ' +
			'the way tests/mocks/modules/obsidianWithCapturingSetting.ts does:\n' +
			shadowMocks.map((entry) => `    ${entry.file}`).join('\n'),
	);
}

if (problems.length > 0) {
	console.error(`\nConvention ceilings exceeded (${problems.length}):`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	process.exit(1);
}

console.log('\nEvery test convention is within its ceiling.');
