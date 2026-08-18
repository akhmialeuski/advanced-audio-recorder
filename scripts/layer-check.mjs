/**
 * Checks that each test sits in the layer its content puts it in.
 *
 * The layers are only useful if the boundary means something, and "how many
 * modules does this test pull in" is the one signal that is both objective and
 * hard to argue with: a test over one module is a unit test, a test that wires
 * five together is not, whatever directory it happens to live in.
 *
 * Usage: node scripts/layer-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** Most modules a unit test may pull in from src/ before it is not one. */
const UNIT_MAX_IMPORTS = 4;
/** Fewest modules an integration test must wire together to earn the name. */
const INTEGRATION_MIN_IMPORTS = 3;

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

/**
 * How many distinct src modules a test file imports.
 * @param file - Repo-relative path to a test
 * @returns Count of distinct src imports
 */
function srcImportCount(file) {
	const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
	const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
		(match) => match[1],
	);
	const fromSrc = specifiers.filter((specifier) =>
		specifier.startsWith('src/'),
	);
	return new Set(fromSrc).size;
}

const problems = [];

for (const file of testFiles('tests/unit')) {
	const imports = srcImportCount(file);
	if (imports > UNIT_MAX_IMPORTS) {
		problems.push(
			`${file}: ${imports} src imports - wires too much together for a unit test ` +
				`(move to tests/integration, or narrow it)`,
		);
	}
}

for (const file of testFiles('tests/integration')) {
	const imports = srcImportCount(file);
	if (imports < INTEGRATION_MIN_IMPORTS) {
		problems.push(
			`${file}: ${imports} src imports - covers too little for an integration test ` +
				`(move to tests/unit)`,
		);
	}
}

const counts = {
	unit: testFiles('tests/unit').length,
	integration: testFiles('tests/integration').length,
	e2e: testFiles('tests/e2e').length,
};
console.log(
	`Layers: ${counts.unit} unit, ${counts.integration} integration, ${counts.e2e} e2e`,
);

if (problems.length > 0) {
	console.error(`\nMisplaced tests (${problems.length}):`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	process.exit(1);
}

console.log('Every test is in the layer its imports put it in.');
